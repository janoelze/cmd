// Command policy for Magic widgets (docs/12-magic-widgets.md): is a shell
// command read-only? The agent's `run` tool and command data sources only run
// commands classified "allow"; anything else is refused with the reason, so the
// agent picks another. A compound command is split on | || && ; & and newlines,
// and every part must pass. This is a best-effort parse; the sandbox
// (sandbox.ts) is what actually prevents writes.

import os from "node:os";
import path from "node:path";

export type Verdict = { level: "allow" | "ask" | "deny"; reason: string };

/** Paths whose contents must never reach a model provider. `~` is the home folder. */
export const DEFAULT_DENY_PATHS = [
  "~/.ssh",
  "~/.aws",
  "~/.azure",
  "~/.config/gcloud",
  "~/.kube",
  "~/.gnupg",
  "~/.netrc",
  "~/.npmrc",
  "~/.pypirc",
  "~/.git-credentials",
  "~/.docker/config.json",
  "~/.password-store",
  "~/.config/op",
  "~/Library/Keychains",
  "~/Library/Cookies",
  "~/Library/Safari",
  "~/Library/Messages",
  "~/Library/Mail",
  "~/Library/Application Support/Google/Chrome",
  "~/Library/Application Support/Chromium",
  "~/Library/Application Support/Firefox",
  "~/Library/Application Support/BraveSoftware",
  "~/Library/Application Support/Arc",
];

export function expandPath(p: string, home = os.homedir()): string {
  return p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

/** Is `p` (absolute) inside a denied path, or a .env file? */
export function isDeniedPath(p: string, deny: string[], home = os.homedir(), cwd = home): boolean {
  const abs = path.resolve(cwd, expandPath(p, home));
  if (/^\.env(\..*)?$/.test(path.basename(abs))) return true;
  return deny.some((d) => {
    const root = path.resolve(expandPath(d, home));
    return abs === root || abs.startsWith(root + path.sep);
  });
}

// ── tokenizer ─────────────────────────────────────────────

type Tok = { t: "word"; v: string } | { t: "op"; v: string } | { t: "redir"; v: string };

/** Shell words and operators; null when the command uses syntax we don't analyse. */
function tokenize(cmd: string): { toks: Tok[] } | { error: string } {
  const toks: Tok[] = [];
  let i = 0;
  let word: string | null = null;
  const flush = () => {
    if (word !== null) toks.push({ t: "word", v: word });
    word = null;
  };
  while (i < cmd.length) {
    const c = cmd[i]!;
    if (c === "`" || (c === "$" && cmd[i + 1] === "(")) return { error: "uses command substitution" };
    if ((c === "<" || c === ">") && cmd[i + 1] === "(") return { error: "uses process substitution" };
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) return { error: "has an unterminated quote" };
      word = (word ?? "") + cmd.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === "\\" && j + 1 < cmd.length) {
          s += cmd[j + 1];
          j += 2;
          continue;
        }
        if (cmd[j] === "`" || (cmd[j] === "$" && cmd[j + 1] === "(")) return { error: "uses command substitution" };
        s += cmd[j];
        j++;
      }
      if (j >= cmd.length) return { error: "has an unterminated quote" };
      word = (word ?? "") + s;
      i = j + 1;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      word = (word ?? "") + cmd[i + 1];
      i += 2;
      continue;
    }
    if (c === " " || c === "\t") {
      flush();
      i++;
      continue;
    }
    // Grouping, { …; } and ( … ): the commands inside are checked like any others.
    if ((c === "(" && word === null) || c === ")") {
      flush();
      toks.push({ t: "op", v: ";" });
      i++;
      continue;
    }
    if ((c === "{" || c === "}") && word === null && /[\s;]|$/.test(cmd[i + 1] ?? "")) {
      toks.push({ t: "op", v: ";" });
      i++;
      continue;
    }
    if (c === "\n" || c === ";") {
      flush();
      toks.push({ t: "op", v: ";" });
      i++;
      continue;
    }
    if (c === "|" || c === "&") {
      // 2>&1, >&2: part of a redirection
      if (c === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">")) {
        const m = /^&>>?/.exec(cmd.slice(i));
        if (m) {
          flush();
          toks.push({ t: "redir", v: m[0] });
          i += m[0].length;
          continue;
        }
      }
      flush();
      const two = cmd.slice(i, i + 2);
      if (two === "||" || two === "&&") {
        toks.push({ t: "op", v: two });
        i += 2;
      } else {
        toks.push({ t: "op", v: c });
        i++;
      }
      continue;
    }
    if (c === ">" || c === "<") {
      // An fd number right before (2>) belongs to the redirection.
      const fd = word !== null && /^\d$/.test(word) ? word : "";
      if (fd) word = null;
      flush();
      const m = /^(>>|>&|<<<|<<|>|<)/.exec(cmd.slice(i))!;
      toks.push({ t: "redir", v: fd + m[0] });
      i += m[0].length;
      continue;
    }
    word = (word ?? "") + c;
    i++;
  }
  flush();
  return { toks };
}

// ── rules ────────────────────────────────────────────────

/** Returns a reason when the arguments make the command unsafe; null when they are fine. */
type ArgRule = (args: string[]) => string | null;

const ok: ArgRule = () => null;
const has = (args: string[], ...flags: string[]) => args.some((a) => flags.some((f) => a === f || a.startsWith(f + "=")));
const sub = (allowed: string[], what: string): ArgRule => (args) => {
  const first = args.find((a) => !a.startsWith("-"));
  return first && allowed.includes(first) ? null : `only ${what} ${allowed.join(", ")}`;
};

const READ_ONLY: Record<string, ArgRule> = {
  cd: ok, ls: ok, cat: ok, head: ok, wc: ok, grep: ok, egrep: ok, fgrep: ok, rg: ok, ag: ok, stat: ok, file: ok,
  du: ok, df: ok, ps: ok, uptime: ok, whoami: ok, id: ok, hostname: ok, uname: ok, sw_vers: ok, date: ok,
  which: ok, whereis: ok, type: ok, echo: ok, printf: ok, jq: ok, yq: ok, uniq: ok, cut: ok, tr: ok, column: ok,
  nl: ok, basename: ok, dirname: ok, realpath: ok, readlink: ok, pwd: ok, true: ok, false: ok, test: ok, "[": ok,
  seq: ok, expr: ok, bc: ok, tac: ok, rev: ok, fold: ok, paste: ok, comm: ok, diff: ok, cmp: ok, md5: ok,
  shasum: ok, base64: ok, xxd: ok, od: ok, strings: ok, vm_stat: ok, iostat: ok, w: ok, who: ok, last: ok,
  netstat: ok, lsof: ok, mdfind: ok, mdls: ok, system_profiler: ok, ioreg: ok, dig: ok, nslookup: ok, host: ok,
  arp: ok, ifconfig: (a) => (a.some((x) => /^(up|down|alias|-alias|delete|create|destroy|inet|mtu|ether|lladdr)$/.test(x)) ? "changes an interface" : null),
  tail: (a) => (has(a, "-f", "-F") ? "follows forever" : null),
  sort: (a) => (has(a, "-o", "--output") ? "writes a file" : null),
  find: (a) => (a.some((x) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(x)) ? "runs or deletes" : null),
  sysctl: (a) => (has(a, "-w") || a.some((x) => x.includes("=")) ? "changes a kernel setting" : null),
  top: (a) => (has(a, "-l") ? null : "is interactive; use top -l 1"),
  ping: (a) => {
    const i = a.indexOf("-c");
    const n = i >= 0 ? Number(a[i + 1]) : NaN;
    return n > 0 && n <= 5 ? null : "needs -c 1..5";
  },
  awk: (a) => (a.some((x) => /system\s*\(|getline|\|\s*"|>\s*"|print[^;]*>/.test(x)) ? "runs commands or writes from awk" : null),
  sed: (a) => (a.some((x) => /^-i|^--in-place/.test(x)) || a.some((x) => /(^|[;{}\s])[wW]\s+\S|(^|[;{}\s])e(\s|$)/.test(x)) ? "edits files" : null),
  curl: (a) => {
    if (has(a, "-o", "-O", "--output", "--remote-name", "-T", "--upload-file", "-K", "--config", "-c", "--cookie-jar", "-D", "--dump-header")) return "writes or uploads files";
    if (a.some((x) => /^-[a-zA-Z]*[oOTKcD]$/.test(x))) return "writes or uploads files";
    if (has(a, "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-F", "--form")) return "sends data";
    const xi = a.findIndex((x) => x === "-X" || x === "--request");
    if (xi >= 0 && !/^(GET|HEAD)$/i.test(a[xi + 1] ?? "")) return "is not a GET";
    return null;
  },
  git: (a) => {
    // Global options before the subcommand; -C and -c take a value.
    let i = 0;
    while (i < a.length && a[i]!.startsWith("-")) i += a[i] === "-C" || a[i] === "-c" ? 2 : 1;
    if (a.slice(0, i).some((x) => x === "-c")) return "sets git config";
    const ok = ["status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "describe", "shortlog", "blame", "rev-list", "cat-file", "for-each-ref", "reflog"];
    return a[i] && ok.includes(a[i]!) ? null : `only git ${ok.join(", ")}`;
  },
  scutil: (a) => (a.some((x) => /^--(nc|dns|proxy|get|nwi)$|^-r$/.test(x)) && !a.some((x) => /^(start|stop|set|enable|disable)$|^--set$/.test(x)) ? null : "only scutil --nc list/status/show, --dns, --proxy, --get"),
  networksetup: (a) => (a[0] && /^-(get|list|show|print)/.test(a[0]) ? null : "only networksetup -get…/-list…"),
  route: (a) => (a.includes("get") ? null : "only route get"),
  defaults: sub(["read", "read-type", "domains", "find"], "defaults"),
  plutil: (a) => (has(a, "-p", "-lint") ? null : "only plutil -p / -lint"),
  pmset: (a) => (a[0] === "-g" ? null : "only pmset -g"),
  diskutil: sub(["list", "info", "apfs"], "diskutil"),
  launchctl: sub(["list", "print", "print-disabled"], "launchctl"),
  brew: sub(["list", "info", "outdated", "config", "--prefix", "deps", "leaves", "services"], "brew"),
  docker: (a) => {
    const s = a.find((x) => !x.startsWith("-"));
    if (s === "stats") return has(a, "--no-stream") ? null : "needs --no-stream";
    return s && ["ps", "images", "info", "version", "inspect", "logs", "port", "top"].includes(s) ? null : "only read-only docker commands";
  },
  tailscale: sub(["status", "ip", "netcheck", "version"], "tailscale"),
  wg: sub(["show"], "wg"),
  mullvad: sub(["status", "version"], "mullvad"),
  "warp-cli": sub(["status", "settings", "registration"], "warp-cli"),
  pgrep: ok,
  systemextensionsctl: sub(["list"], "systemextensionsctl"),
  nordvpn: sub(["status", "settings"], "nordvpn"),
  ipconfig: sub(["getifaddr", "getsummary", "getoption", "getpacket", "getv6packet"], "ipconfig"),
  softwareupdate: (a) => (has(a, "-l", "--list") ? null : "only softwareupdate --list"),
  sqlite3: (a) => (has(a, "-readonly") ? null : "needs -readonly"),
  log: sub(["show"], "log"),
  kubectl: sub(["get", "describe", "top", "version", "config"], "kubectl"),
  gh: (a) => {
    const [s, v] = a.filter((x) => !x.startsWith("-"));
    if (has(a, "--show-token", "-t") && s === "auth") return "would print the token";
    if (s === "api") return has(a, "-X", "--method", "-f", "-F", "--field", "--raw-field", "--input") ? "only GET via gh api" : null;
    if (s === "auth") return v === "status" ? null : "only gh auth status";
    if (s === "search") return null;
    if (s === "run" && v === "watch") return "follows forever; use gh run list / gh run view";
    return s && v && ["list", "view", "status", "checks", "diff"].includes(v) ? null : "only gh … list/view/status/checks, gh api (GET), gh search";
  },
  glab: (a) => {
    const [s, v] = a.filter((x) => !x.startsWith("-"));
    if (s === "auth") return v === "status" && !has(a, "-t", "--show-token") ? null : "only glab auth status (without the token)";
    if (s === "api") return has(a, "-X", "--method", "-f", "-F", "--field", "--raw-field", "--input") ? "only GET via glab api" : null;
    if (s === "config") return "may print the token";
    if ((s === "ci" || s === "pipeline") && v === "view") return "is interactive; use glab ci list / glab ci get";
    return s && v && ["list", "get", "status", "view", "diff"].includes(v) ? null : "only glab … list/get/status/view, glab api (GET)";
  },
};

/** Never, whatever the arguments: privilege, secrets, scripting, changing the system. */
const DENY: Record<string, string> = {
  sudo: "needs root", su: "needs root", doas: "needs root", osascript: "can control other apps", security: "reads the keychain",
  env: "prints the environment (may contain secrets)", printenv: "prints the environment (may contain secrets)",
  eval: "runs arbitrary code", exec: "replaces the shell", source: "runs a script", ".": "runs a script",
  xargs: "runs other commands", open: "opens apps and files", tee: "writes files", dd: "writes devices",
  sh: "runs a script", bash: "runs a script", zsh: "runs a script", fish: "runs a script",
  python: "runs code", python3: "runs code", node: "runs code", ruby: "runs code", perl: "runs code", deno: "runs code", bun: "runs code",
};

/**
 * CLIs that may use the person's stored login (never show it): their read-only
 * subcommands run with these env vars kept and these paths (and, with keychain,
 * the login keychain) readable in the sandbox. The model still can't read the
 * files (policy, read tool) and command output is scrubbed of tokens (redact).
 */
export const CREDENTIALED: Record<string, { env: string[]; paths: string[]; keychain?: boolean }> = {
  gh: { env: ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "GH_CONFIG_DIR"], paths: ["~/.config/gh"], keychain: true },
  glab: { env: ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "GITLAB_HOST", "GITLAB_URI", "GLAB_CONFIG_DIR"], paths: ["~/.config/glab-cli", "~/Library/Application Support/glab-cli"], keychain: true },
  kubectl: { env: ["KUBECONFIG"], paths: ["~/.kube"] },
  docker: { env: ["DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"], paths: ["~/.docker"] },
  tailscale: { env: [], paths: [], keychain: true },
};

export interface Credentials {
  env: string[];
  paths: string[];
  keychain: boolean;
}

/** The logins the programs in a command may use (empty when none of them is credentialed). */
export function credentialsFor(command: string): Credentials {
  const out: Credentials = { env: [], paths: [], keychain: false };
  const t = tokenize(command);
  if ("error" in t) return out;
  let start = true;
  for (const tok of t.toks) {
    if (tok.t === "op") {
      start = true;
      continue;
    }
    if (tok.t !== "word") continue;
    if (start && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.v)) continue;
    if (start) {
      const c = CREDENTIALED[path.basename(tok.v)];
      if (c) {
        out.env.push(...c.env);
        out.paths.push(...c.paths);
        out.keychain ||= !!c.keychain;
      }
    }
    start = false;
  }
  return out;
}

/** The logins a set of programs may use (a widget's permissions.run). */
export function credentialsForPrograms(programs: string[]): Credentials {
  const out: Credentials = { env: [], paths: [], keychain: false };
  for (const p of programs) {
    const c = CREDENTIALED[path.basename(p)];
    if (!c) continue;
    out.env.push(...c.env);
    out.paths.push(...c.paths);
    out.keychain ||= !!c.keychain;
  }
  return out;
}

/** Token-shaped strings, replaced before any command output reaches the model. */
const SECRET_PATTERNS = [
  /\b(gh[pousr]_[A-Za-z0-9]{30,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{30,})\b/g,
  /\b(glpat-[A-Za-z0-9_-]{20,})\b/g,
  /\b(gl(?:cbt|dt|ft|imt|oas|ptt|rt|soat)-[A-Za-z0-9_-]{20,})\b/g,
  /\b(xox[abposr]-[A-Za-z0-9-]{10,})\b/g,
  /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,})\b/g,
  /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g,
  /((?:token|password|passwd|secret|api[_-]?key)["']?\s*[:=]\s*["']?)([^\s"',}]{8,})/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, a: string, b?: string) => (b !== undefined && typeof b === "string" && /[:=]/.test(a) ? a + "[redacted]" : "[redacted]"));
  }
  return out;
}

export interface PolicyOptions {
  deny?: string[];
  home?: string;
  /** Where relative paths in the command resolve (default: home). */
  cwd?: string;
}

/** Classify one command line. */
export function classify(command: string, o: PolicyOptions = {}): Verdict {
  const deny = o.deny ?? DEFAULT_DENY_PATHS;
  const home = o.home ?? os.homedir();
  const cwd = o.cwd ?? home;
  if (!command.trim()) return { level: "deny", reason: "empty command" };
  const t = tokenize(command);
  if ("error" in t) return { level: "ask", reason: `the command ${t.error}` };
  // Split into simple commands.
  const parts: Tok[][] = [[]];
  for (const tok of t.toks) {
    if (tok.t === "op") parts.push([]);
    else parts[parts.length - 1]!.push(tok);
  }
  let worst: Verdict = { level: "allow", reason: "read-only" };
  const worse = (v: Verdict) => {
    const rank = { allow: 0, ask: 1, deny: 2 };
    if (rank[v.level] > rank[worst.level]) worst = v;
  };
  for (const part of parts) {
    if (!part.length) continue;
    const words: string[] = [];
    for (let i = 0; i < part.length; i++) {
      const tok = part[i]!;
      if (tok.t === "redir") {
        const target = part[i + 1]?.t === "word" ? part[++i]!.v : "";
        if (tok.v.endsWith(">&") || tok.v === "&>" || tok.v === "&>>") {
          if (tok.v.startsWith("&>") && target !== "/dev/null") worse({ level: "ask", reason: `writes to ${target}` });
          continue;
        }
        if (tok.v.includes(">")) {
          if (target !== "/dev/null") worse({ level: "ask", reason: `writes to ${target || "a file"}` });
        } else if (target && isDeniedPath(target, deny, home, cwd)) {
          worse({ level: "deny", reason: `reads ${target}, which stays private` });
        }
        continue;
      }
      words.push(tok.v);
    }
    // Leading VAR=value assignments.
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
    if (!words.length) continue;
    const name = path.basename(words[0]!);
    const args = words.slice(1);
    for (const a of args) {
      // Flags never name files, except --file=path style values.
      const candidate = a.startsWith("-") ? (a.includes("=") ? a.slice(a.indexOf("=") + 1) : "") : a;
      if (candidate && !/^[a-z]+:\/\//i.test(candidate) && isDeniedPath(candidate, deny, home, cwd)) {
        worse({ level: "deny", reason: `reads ${candidate}, which stays private` });
      }
    }
    if (DENY[name]) {
      worse({ level: "deny", reason: `${name} ${DENY[name]}` });
      continue;
    }
    const rule = READ_ONLY[name];
    if (!rule) {
      worse({ level: "ask", reason: `${name} is not a known read-only command` });
      continue;
    }
    const why = rule(args);
    if (why) worse({ level: "ask", reason: `${name} ${why}` });
  }
  return worst;
}
