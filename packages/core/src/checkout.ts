// The git checkout a path is in, read from .git without running git: the one
// place cmd answers "which repository, which worktree, which branch" (Spaces'
// roots, the event log's project ids, the journal's reflogs, peer briefings,
// notification subjects). A linked worktree's .git is a file pointing at
// <repo>/.git/worktrees/<name>, whose commondir points back at the shared .git.
// `placeOf` is the cached form panes, agents and Spaces carry (docs/35).

import fs from "node:fs";
import path from "node:path";
import type { GitPlace } from "@cmd/protocol";

export interface Checkout {
  /** The worktree's top level. */
  top: string;
  /** The project: the main worktree's folder (equal for every worktree of one repository). */
  repo: string;
  /** The shared git folder (<repo>/.git). */
  common: string;
  /** This worktree's git folder (common for the main worktree). */
  gitDir: string;
  /** A linked worktree (gitDir isn't the shared one). */
  linked: boolean;
  /** The checked-out branch; null when HEAD is detached. */
  branch: string | null;
}

/** The checkout `p` (a file or a folder) is in; null outside a repository. */
export function checkoutOf(p: string): Checkout | null {
  if (!p) return null;
  let dir = p;
  try {
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch {
    return null;
  }
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(dotGit);
    } catch {}
    if (st) return read(dir, dotGit, st.isDirectory());
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function read(top: string, dotGit: string, isDir: boolean): Checkout | null {
  try {
    let gitDir = dotGit;
    let common = dotGit;
    if (!isDir) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
      if (!m) return null;
      gitDir = path.resolve(top, m[1]!.trim());
      common = gitDir;
      try {
        common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
      } catch {
        // <repo>/.git/worktrees/<name> without a commondir file: the layout says it.
        if (path.basename(path.dirname(gitDir)) === "worktrees") common = path.dirname(path.dirname(gitDir));
      }
    }
    let branch: string | null = null;
    try {
      branch = /^ref: refs\/heads\/(.+)$/.exec(fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim())?.[1] ?? null;
    } catch {}
    const repo = path.basename(common) === ".git" ? path.dirname(common) : common;
    return { top, repo, common, gitDir, linked: gitDir !== common, branch };
  } catch {
    return null;
  }
}

const CACHE_MAX = 2000;
/** A folder outside a repository is looked at again after this long (a `git init`, a clone). */
const NONE_TTL = 30_000;
const cache = new Map<string, { at: GitPlace | null; head: string | null; mtime: number }>();

/**
 * Where a folder is in git, for something that asks often (every pane prompt,
 * every agent event): cached per folder and re-read when its HEAD changes, so a
 * `git switch` shows. null outside a repository.
 */
export function placeOf(dir: string): GitPlace | null {
  if (!dir || !path.isAbsolute(dir)) return null;
  const hit = cache.get(dir);
  if (hit) {
    if (!hit.head) {
      if (Date.now() - hit.mtime < NONE_TTL) return hit.at;
    } else if (mtimeOf(hit.head) === hit.mtime) return hit.at;
  }
  const c = checkoutOf(dir);
  // Real paths, so a cwd reached through a symlink compares equal to a Space's (canonical) root.
  const at = c ? { project: real(c.repo), top: real(c.top), linked: c.linked, branch: c.branch } : null;
  const head = c ? path.join(c.gitDir, "HEAD") : null;
  if (cache.size >= CACHE_MAX) cache.clear();
  // Outside a repository, `mtime` is when it was looked at.
  cache.set(dir, { at, head, mtime: head ? mtimeOf(head) : Date.now() });
  return at;
}

function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function mtimeOf(f: string): number {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return -1;
  }
}

/** Two places say the same (a change worth sending). */
export function samePlace(a: GitPlace | null | undefined, b: GitPlace | null | undefined): boolean {
  return (a ?? null) === (b ?? null) || (!!a && !!b && a.top === b.top && a.branch === b.branch && a.project === b.project && a.linked === b.linked);
}

/** The tops of a repository's linked worktrees, from the shared git folder (`<common>/worktrees/<name>/gitdir`); missing ones left out. */
export function worktreesOf(common: string): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(common, "worktrees"));
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const top = path.dirname(fs.readFileSync(path.join(common, "worktrees", n, "gitdir"), "utf8").trim());
      if (fs.existsSync(top)) out.push(real(top));
    } catch {}
  }
  return out;
}

/** The repository's origin URL from its config (credentials in it stripped); null without one. */
export function remoteOf(common: string): string | null {
  try {
    const config = fs.readFileSync(path.join(common, "config"), "utf8");
    const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config);
    return m ? m[1]!.replace(/\/\/[^/@]+@/, "//") : null;
  } catch {
    return null;
  }
}
