// procinfo: foreground-process inspection for cmd's core (port of the
// ghostty-agents fork's AgentProcess.swift). Node has no sysctl access, and
// `ps` is unavailable inside some sandboxes, so the core runs this once and
// talks to it line by line:
//
//   stdin:  <shell pid>\n
//   stdout: {"pid":<shell>,"fg":<foreground pid>,"start":<unix s.frac>,"path":"…","argv":["…"]}\n
//           {"pid":<shell>,"error":"…"}\n
//
//   stdin:  t <pid> <pid> …\n          (resource usage of each pid's process tree)
//   stdout: [{"pid":<root>,"mem":<bytes>,"cpu":<ns>,"procs":<n>,
//             "top":[{"pid":…,"name":"…","path":"…","mem":<bytes>}, …]}, …]\n
//
//   stdin:  p <pid> <pid> …\n          (resource usage of each process alone)
//   stdout: [{"pid":…,"mem":<bytes>,"cpu":<ns>}, …]\n   (pids that are gone are left out)
//
// mem is the physical footprint (what Activity Monitor shows as "Memory");
// cpu is cumulative user+system time, so callers compute % from deltas.
//
// The foreground process is the terminal's foreground process group leader
// (kinfo_proc.kp_eproc.e_tpgid of the shell), the same thing tcgetpgrp reports.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <unistd.h>
#include <libproc.h>
#include <sys/resource.h>
#include <mach/mach_time.h>

static void json_str(const char *s, size_t n) {
  putchar('"');
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"' || c == '\\') printf("\\%c", c);
    else if (c < 0x20) printf("\\u%04x", c);
    else putchar(c);
  }
  putchar('"');
}

static int kinfo(pid_t pid, struct kinfo_proc *info) {
  size_t size = sizeof(*info);
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  if (sysctl(mib, 4, info, &size, NULL, 0) != 0 || size == 0) return -1;
  return 0;
}

static void report(pid_t shell, char *buf, int argmax) {
  struct kinfo_proc sh;
  if (kinfo(shell, &sh) != 0) {
    printf("{\"pid\":%d,\"error\":\"no such process\"}\n", shell);
    return;
  }
  pid_t fg = sh.kp_eproc.e_tpgid > 0 ? sh.kp_eproc.e_tpgid : shell;
  struct kinfo_proc fi;
  double start = 0;
  if (kinfo(fg, &fi) == 0) {
    start = fi.kp_proc.p_un.__p_starttime.tv_sec + fi.kp_proc.p_un.__p_starttime.tv_usec / 1e6;
  }

  size_t size = (size_t)argmax;
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, fg};
  if (sysctl(mib, 3, buf, &size, NULL, 0) != 0 || size <= sizeof(int)) {
    // argv is unreadable (e.g. setuid); still report the short name
    printf("{\"pid\":%d,\"fg\":%d,\"start\":%.6f,\"path\":", shell, fg, start);
    json_str(fi.kp_proc.p_comm, strnlen(fi.kp_proc.p_comm, sizeof(fi.kp_proc.p_comm)));
    printf(",\"argv\":[]}\n");
    return;
  }

  int argc;
  memcpy(&argc, buf, sizeof(int));
  size_t i = sizeof(int);
  size_t p0 = i;
  while (i < size && buf[i]) i++;
  size_t plen = i - p0;
  while (i < size && !buf[i]) i++; // padding before argv[0]

  printf("{\"pid\":%d,\"fg\":%d,\"start\":%.6f,\"path\":", shell, fg, start);
  json_str(buf + p0, plen);
  printf(",\"argv\":[");
  for (int a = 0; a < argc && i < size; a++) {
    size_t s0 = i;
    while (i < size && buf[i]) i++;
    if (a) putchar(',');
    json_str(buf + s0, i - s0);
    i++;
  }
  printf("]}\n");
}

// ── process-tree resource usage ───────────────────────────

typedef struct {
  pid_t pid, ppid;
  char name[2 * MAXCOMLEN + 1];
  uint64_t mem, cpu;
  int have_usage;
} proc_t;

static mach_timebase_info_data_t timebase;

static void usage_of(proc_t *p) {
  struct rusage_info_v4 ri;
  if (proc_pid_rusage(p->pid, RUSAGE_INFO_V4, (rusage_info_t *)&ri) != 0) return;
  p->mem = ri.ri_phys_footprint;
  // ri_*_time are mach absolute time units on Apple Silicon; convert to ns.
  p->cpu = (ri.ri_user_time + ri.ri_system_time) * timebase.numer / timebase.denom;
  p->have_usage = 1;
}

static int cmp_mem_desc(const void *a, const void *b) {
  const proc_t *x = *(proc_t *const *)a, *y = *(proc_t *const *)b;
  return x->mem < y->mem ? 1 : x->mem > y->mem ? -1 : 0;
}

static void report_trees(char *line) {
  int cap = proc_listallpids(NULL, 0);
  if (cap <= 0) { printf("[]\n"); return; }
  cap += 64;
  pid_t *pids = malloc(sizeof(pid_t) * (size_t)cap);
  int n = proc_listallpids(pids, (int)(sizeof(pid_t) * (size_t)cap));
  proc_t *procs = calloc((size_t)(n > 0 ? n : 1), sizeof(proc_t));
  int count = 0;
  for (int i = 0; i < n; i++) {
    struct proc_bsdshortinfo bi;
    if (proc_pidinfo(pids[i], PROC_PIDT_SHORTBSDINFO, 0, &bi, sizeof bi) != sizeof bi) continue;
    procs[count].pid = pids[i];
    procs[count].ppid = (pid_t)bi.pbsi_ppid;
    strncpy(procs[count].name, bi.pbsi_comm, sizeof procs[count].name - 1);
    count++;
  }

  printf("[");
  int first_root = 1;
  char *save = NULL;
  for (char *tok = strtok_r(line, " \t\n", &save); tok; tok = strtok_r(NULL, " \t\n", &save)) {
    pid_t root = (pid_t)atoi(tok);
    if (root <= 0) continue;
    // Collect the subtree with a simple worklist over the parent links.
    proc_t **tree = malloc(sizeof(proc_t *) * (size_t)(count > 0 ? count : 1));
    int tn = 0;
    for (int i = 0; i < count; i++) if (procs[i].pid == root) tree[tn++] = &procs[i];
    for (int head = 0; head < tn; head++) {
      for (int i = 0; i < count; i++) {
        if (procs[i].ppid == tree[head]->pid && procs[i].pid != tree[head]->pid) tree[tn++] = &procs[i];
      }
    }
    uint64_t mem = 0, cpu = 0;
    for (int i = 0; i < tn; i++) {
      if (!tree[i]->have_usage) usage_of(tree[i]);
      mem += tree[i]->mem;
      cpu += tree[i]->cpu;
    }
    qsort(tree, (size_t)tn, sizeof(proc_t *), cmp_mem_desc);
    printf("%s{\"pid\":%d,\"mem\":%llu,\"cpu\":%llu,\"procs\":%d,\"top\":[", first_root ? "" : ",", root,
           (unsigned long long)mem, (unsigned long long)cpu, tn);
    for (int i = 0; i < tn && i < 5; i++) {
      printf("%s{\"pid\":%d,\"name\":", i ? "," : "", tree[i]->pid);
      json_str(tree[i]->name, strnlen(tree[i]->name, sizeof tree[i]->name));
      char path[PROC_PIDPATHINFO_MAXSIZE];
      int plen = proc_pidpath(tree[i]->pid, path, sizeof path);
      printf(",\"path\":");
      json_str(path, plen > 0 ? (size_t)plen : 0);
      printf(",\"mem\":%llu}", (unsigned long long)tree[i]->mem);
    }
    printf("]}");
    first_root = 0;
    free(tree);
  }
  printf("]\n");
  free(procs);
  free(pids);
}

static void report_procs(char *line) {
  printf("[");
  int first = 1;
  char *save = NULL;
  for (char *tok = strtok_r(line, " \t\n", &save); tok; tok = strtok_r(NULL, " \t\n", &save)) {
    proc_t p = {0};
    p.pid = (pid_t)atoi(tok);
    if (p.pid <= 0) continue;
    usage_of(&p);
    if (!p.have_usage) continue;
    printf("%s{\"pid\":%d,\"mem\":%llu,\"cpu\":%llu}", first ? "" : ",", p.pid, (unsigned long long)p.mem,
           (unsigned long long)p.cpu);
    first = 0;
  }
  printf("]\n");
}

int main(void) {
  mach_timebase_info(&timebase);
  int argmax = 0;
  size_t sz = sizeof(argmax);
  int mib[2] = {CTL_KERN, KERN_ARGMAX};
  if (sysctl(mib, 2, &argmax, &sz, NULL, 0) != 0 || argmax <= 0) argmax = 1 << 20;
  char *buf = malloc((size_t)argmax);
  char line[8192];
  while (fgets(line, sizeof line, stdin)) {
    if (line[0] == 't') {
      report_trees(line + 1);
      fflush(stdout);
      continue;
    }
    if (line[0] == 'p') {
      report_procs(line + 1);
      fflush(stdout);
      continue;
    }
    pid_t pid = (pid_t)atoi(line);
    if (pid > 0) report(pid, buf, argmax);
    else printf("{\"pid\":0,\"error\":\"bad pid\"}\n");
    fflush(stdout);
  }
  free(buf);
  return 0;
}
