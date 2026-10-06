// Git as journal events: what a repository's reflogs say happened (commits,
// merges, checkouts, branches created, rebases, resets) and its tags. Reflogs
// are read as files, without running git, so watching them is cheap; they hold
// 90 days by default, which makes them the backfill too. A merged branch whose
// worktree and branch are gone still left its merge in the main reflog; the
// commits it brought are read from the merge's range.
//
// Worktrees of one repository are one project: `repo` is the main worktree's
// folder, and each event says which worktree it happened in.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { JournalData } from "@cmd/protocol";
import type { NewJournalEvent } from "./store.ts";

export interface RepoInfo {
  /** The main worktree's folder: the project. */
  repo: string;
  /** The worktree `cwd` is in. */
  top: string;
  /** The shared git folder (<repo>/.git). */
  common: string;
  branch: string | null;
}

function git(cwd: string, args: string[], timeout = 5000): Promise<string | null> {
  return new Promise((resolve) =>
    execFile("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, maxBuffer: 16 << 20, timeout }, (err, out) => resolve(err ? null : out)),
  );
}

const repoCache = new Map<string, { at: number; info: RepoInfo | null }>();

/** The repository a folder is in; null outside one. Cached for a minute (branches change). */
export async function repoOf(cwd: string): Promise<RepoInfo | null> {
  const hit = repoCache.get(cwd);
  if (hit && Date.now() - hit.at < 60_000) return hit.info;
  const out = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel", "--abbrev-ref", "HEAD"]);
  const [common = "", top = "", branch = ""] = (out ?? "").split("\n");
  const info = common && top ? { repo: path.basename(common) === ".git" ? path.dirname(common) : common, top, common, branch: branch && branch !== "HEAD" ? branch : null } : null;
  repoCache.set(cwd, { at: Date.now(), info });
  return info;
}

/** The repository a path is in without running git: the nearest folder with a .git (a worktree's .git file points at its common dir). */
export function repoOfSync(p: string): { repo: string; top: string } | null {
  for (let dir = p; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const g = path.join(dir, ".git");
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(g);
    } catch {
      continue;
    }
    if (st.isDirectory()) return { repo: dir, top: dir };
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g, "utf8"));
    const wt = m?.[1]?.trim();
    // <repo>/.git/worktrees/<name>
    if (wt && path.basename(path.dirname(wt)) === "worktrees") return { repo: path.dirname(path.dirname(path.dirname(wt))), top: dir };
    return { repo: dir, top: dir };
  }
  return null;
}

export interface ReflogEntry {
  old: string;
  new: string;
  at: number;
  message: string;
}

/** `<old> <new> <who> <unix ts> <tz>\t<message>` lines. */
export function parseReflog(text: string): ReflogEntry[] {
  const out: ReflogEntry[] = [];
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const head = line.slice(0, tab);
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) .* (\d+) [+-]\d{4}$/.exec(head);
    if (!m) continue;
    out.push({ old: m[1]!, new: m[2]!, at: Number(m[3]) * 1000, message: line.slice(tab + 1) });
  }
  return out;
}

const read = (f: string) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

/** The reflogs of a repository: the main worktree's HEAD, each linked worktree's HEAD, each branch. */
function reflogs(common: string, repo: string): { file: string; worktree: string | null; branch: string | null }[] {
  const out: { file: string; worktree: string | null; branch: string | null }[] = [{ file: path.join(common, "logs", "HEAD"), worktree: repo, branch: null }];
  for (const name of safeDir(path.join(common, "worktrees"))) {
    const gitdir = read(path.join(common, "worktrees", name, "gitdir")).trim();
    out.push({ file: path.join(common, "worktrees", name, "logs", "HEAD"), worktree: gitdir ? path.dirname(gitdir) : null, branch: null });
  }
  const heads = path.join(common, "logs", "refs", "heads");
  const walk = (dir: string, prefix: string) => {
    for (const e of safeDirents(dir)) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}${e.name}/`);
      else out.push({ file: path.join(dir, e.name), worktree: null, branch: prefix + e.name });
    }
  };
  walk(heads, "");
  return out;
}

const safeDir = (d: string) => safeDirents(d).filter((e) => e.isDirectory()).map((e) => e.name);
function safeDirents(d: string): fs.Dirent[] {
  try {
    return fs.readdirSync(d, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The files a watcher should watch to hear about new reflog entries. */
export function reflogFiles(common: string, repo: string): string[] {
  return reflogs(common, repo).map((r) => r.file);
}

const short = (h: string) => h.slice(0, 9);
const ZERO = /^0+$/;

/**
 * Every event the repository's reflogs and tags hold since `since`. Keys are
 * per repository and object, so reading twice (a watcher, then a backfill)
 * gives the same events.
 */
export async function gitEvents(repoDir: string, since = 0): Promise<NewJournalEvent[]> {
  const info = await repoOf(repoDir);
  if (!info) return [];
  const { repo, common } = info;
  const commits = new Map<string, { at: number; subject: string; branch: string | null; worktree: string | null }>();
  const out: NewJournalEvent[] = [];
  const ev = (at: number, key: string, data: JournalData, text: string, thread: string | null, cwd: string | null) =>
    out.push({ at, until: null, kind: data.kind as NewJournalEvent["kind"], key: `git:${repo}:${key}`, spaceId: null, repo, cwd, thread, text, data, source: "backfill" });
  const branchThread = (b: string | null) => (b && b !== "HEAD" ? `branch:${repo}#${b}` : null);
  // Merges seen in any log, to expand into the commits they brought.
  const merges: { e: ReflogEntry; branch: string; into: string | null; worktree: string | null }[] = [];

  for (const log of reflogs(common, repo)) {
    // What a worktree's HEAD log says it has checked out, as it goes.
    let current: string | null = log.branch;
    for (const e of parseReflog(read(log.file))) {
      const m = e.message;
      let x: RegExpExecArray | null;
      if ((x = /^checkout: moving from (.+) to (.+)$/.exec(m))) current = x[2]!;
      if (e.at < since) continue;
      if ((x = /^commit(?: \((initial|amend|merge)\))?: (.*)$/.exec(m))) {
        const prev = commits.get(e.new);
        commits.set(e.new, { at: e.at, subject: x[2]!, branch: prev?.branch ?? (log.branch ?? (current && !/^[0-9a-f]{7,40}$/.test(current) ? current : null)), worktree: prev?.worktree ?? log.worktree });
      } else if ((x = /^merge (.+?): (Fast-forward|Merge made by.*)$/.exec(m))) {
        const into = log.branch ?? current;
        const ff = x[2] === "Fast-forward";
        if (!log.branch) merges.push({ e, branch: x[1]!, into, worktree: log.worktree });
        if (!log.branch) ev(e.at, `merge:${e.new}:${x[1]}`, { kind: "git.merge", branch: x[1]!, into, fastForward: ff, hash: short(e.new), worktree: log.worktree }, `Merged ${x[1]} into ${into ?? "HEAD"}`, branchThread(x[1]!), log.worktree);
      } else if ((x = /^checkout: moving from (.+) to (.+)$/.exec(m))) {
        if (x[1] !== x[2]) ev(e.at, `checkout:${e.at}:${log.worktree}:${x[2]}`, { kind: "git.checkout", from: x[1]!, to: x[2]!, worktree: log.worktree }, `Checked out ${x[2]}`, branchThread(x[2]!), log.worktree);
      } else if ((x = /^branch: Created from (.+)$/.exec(m)) && log.branch) {
        ev(e.at, `branch:${log.branch}:${e.at}`, { kind: "git.branch", branch: log.branch, from: x[1]!, worktree: null }, `Created branch ${log.branch} from ${x[1]}`, branchThread(log.branch), null);
      } else if ((x = /^rebase \(finish\): (?:returning to )?refs\/heads\/(.+?)(?: onto ([0-9a-f]+))?$/.exec(m)) && !log.branch) {
        ev(e.at, `rebase:${e.new}`, { kind: "git.rebase", branch: x[1]!, onto: x[2] ? short(x[2]) : null, worktree: log.worktree }, `Rebased ${x[1]}`, branchThread(x[1]!), log.worktree);
      } else if ((x = /^reset: moving to (.+)$/.exec(m)) && !log.branch && !ZERO.test(e.old) && e.old !== e.new) {
        ev(e.at, `reset:${e.new}:${e.at}`, { kind: "git.reset", to: x[1]!, worktree: log.worktree }, `Reset to ${x[1]}`, branchThread(current), log.worktree);
      }
    }
  }

  // Which worktree a branch was created in: the linked worktree whose first entry is at its creation.
  const worktreeOf = new Map<string, string>();
  for (const log of reflogs(common, repo)) {
    if (!log.branch && log.worktree && log.worktree !== repo) {
      const first = parseReflog(read(log.file))[0];
      const b = [...commits.values()].find((c) => c.worktree === log.worktree && c.branch)?.branch;
      if (first && b) worktreeOf.set(b, log.worktree);
    }
  }
  for (const o of out) if (o.data.kind === "git.branch" && worktreeOf.has(o.data.branch)) o.data.worktree = worktreeOf.get(o.data.branch)!;

  // Commits a merge brought: branches deleted after merging leave only this.
  for (const m of merges) {
    if (ZERO.test(m.e.old)) continue;
    const log = await git(repo, ["log", "--no-merges", "--format=%H%x09%at%x09%s", `${m.e.old}..${m.e.new}`]);
    for (const line of (log ?? "").split("\n").filter(Boolean)) {
      const [hash = "", at = "0", subject = ""] = line.split("\t");
      const prev = commits.get(hash);
      commits.set(hash, { at: prev?.at ?? Number(at) * 1000, subject, branch: prev?.branch && prev.branch !== m.into ? prev.branch : m.branch, worktree: prev?.worktree ?? null });
    }
  }

  for (const [hash, c] of commits) {
    if (c.at < since) continue;
    ev(c.at, `commit:${hash}`, { kind: "git.commit", hash: short(hash), subject: c.subject, branch: c.branch, worktree: c.worktree }, c.subject, branchThread(c.branch), c.worktree);
  }

  const tags = await git(repo, ["for-each-ref", "refs/tags", "--format=%(refname:short)%09%(objectname)%09%(creatordate:unix)"]);
  for (const line of (tags ?? "").split("\n").filter(Boolean)) {
    const [tag = "", hash = "", at = "0"] = line.split("\t");
    const t = Number(at) * 1000;
    if (t >= since) ev(t, `tag:${tag}`, { kind: "git.tag", tag, hash: short(hash) }, `Tagged ${tag}`, `release:${repo}#${tag}`, repo);
  }
  return out.sort((a, b) => a.at - b.at);
}
