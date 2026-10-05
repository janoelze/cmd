// What changed in a work tree during a turn, whatever the agent says and however
// it edited (tools, shell, scripts): a snapshot of `git status` (with each listed
// file's size and mtime) and HEAD at the turn's start and end. A file counts if it
// is listed at the end and is new to the list or changed on disk, if it left the
// list, or if a commit made during the turn touched it. Read-only: no optional
// locks, no index refresh.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { IGNORE } from "./fswatch.ts";

export interface GitSnapshot {
  top: string;
  head: string | null;
  /** Path (absolute) → status letter and what was on disk. */
  files: Map<string, { change: string; stamp: string }>;
  truncated: boolean;
}

const MAX_FILES = 5000;

function git(cwd: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, maxBuffer: 32 * 1024 * 1024, timeout }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

const stamp = (file: string) => {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  return st ? `${st.size}:${st.mtimeMs}` : "-";
};

/** null outside a work tree, without git, or when git is slow. */
export async function snapshot(cwd: string): Promise<GitSnapshot | null> {
  try {
    const top = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    if (!top) return null;
    const head = await git(top, ["rev-parse", "--verify", "-q", "HEAD"]).then((s) => s.trim() || null, () => null);
    const out = await git(top, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames"]);
    const files = new Map<string, { change: string; stamp: string }>();
    let truncated = false;
    for (const entry of out.split("\0")) {
      if (entry.length < 4) continue;
      if (files.size >= MAX_FILES) {
        truncated = true;
        break;
      }
      const xy = entry.slice(0, 2);
      const rel = entry.slice(3).replace(/\/$/, "");
      // Untracked generated folders (__pycache__, node_modules without a .gitignore) aren't changes.
      if (xy === "??" && IGNORE.test(rel)) continue;
      const abs = path.join(top, rel);
      const change = xy === "??" ? "A" : (xy.trim()[0] ?? "M");
      files.set(abs, { change, stamp: stamp(abs) });
    }
    return { top, head, files, truncated };
  } catch {
    return null;
  }
}

/** Files that changed between two snapshots of the same work tree: path → git letter. */
export async function changedBetween(a: GitSnapshot, b: GitSnapshot): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (a.top !== b.top) return out;
  for (const [p, f] of b.files) {
    const before = a.files.get(p);
    if (!before || before.stamp !== f.stamp || before.change !== f.change) out.set(p, f.change);
  }
  // Listed before, not now: reverted, or committed (the commit diff below says which).
  for (const p of a.files.keys()) if (!b.files.has(p)) out.set(p, "M");
  if (a.head && b.head && a.head !== b.head) {
    try {
      const diff = await git(b.top, ["diff", "--name-status", "-z", "--no-renames", a.head, b.head]);
      const parts = diff.split("\0").filter(Boolean);
      for (let i = 0; i + 1 < parts.length; i += 2) out.set(path.join(b.top, parts[i + 1]!), parts[i]!.slice(0, 1));
    } catch {}
  }
  return out;
}
