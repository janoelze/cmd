// The git checkout a path is in, read from .git without running git: the one
// place cmd answers "which repository, which worktree, which branch" (Spaces'
// roots, the event log's project ids, the journal's reflogs, peer briefings,
// notification subjects). A linked worktree's .git is a file pointing at
// <repo>/.git/worktrees/<name>, whose commondir points back at the shared .git.

import fs from "node:fs";
import path from "node:path";

export interface Checkout {
  /** The worktree's top level. */
  top: string;
  /** The project: the main worktree's folder (equal for every worktree of one repository). */
  repo: string;
  /** The shared git folder (<repo>/.git). */
  common: string;
  /** This worktree's git folder (common for the main worktree). */
  gitDir: string;
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
    return { top, repo, common, gitDir, branch };
  } catch {
    return null;
  }
}
