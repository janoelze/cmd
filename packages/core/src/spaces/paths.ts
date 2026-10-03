// Path → Space matching. A Space's identity is its root's canonical path, so the
// same folder reached by any spelling (symlink, /tmp vs /private/tmp, other case
// on APFS, NFD vs NFC, `..`, trailing slash) is one Space. Containment compares
// whole path segments: ~/src/cmd does not contain ~/src/cmd-old.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Canonical absolute path: `~` expanded, relative paths resolved against `base`,
 * symlinks followed and the on-disk spelling (case, Unicode form) taken from the
 * file system via realpath(3). Parts that don't exist (a deleted cwd, a file not
 * created yet) are kept as written, NFC-normalized, below the deepest ancestor
 * that does exist.
 */
export function canonical(p: string, base = process.cwd(), home = os.homedir()): string {
  const expanded = p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
  const abs = path.resolve(base, expanded);
  const tail: string[] = [];
  let dir = abs;
  for (;;) {
    try {
      const real = fs.realpathSync.native(dir);
      return tail.length ? path.join(real, ...tail.reverse().map((s) => s.normalize("NFC"))) : real;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs.normalize("NFC");
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
}

/** Is `p` the folder `root` or inside it? Both canonical. */
export function contains(root: string, p: string): boolean {
  if (p === root) return true;
  return p.startsWith(root.endsWith("/") ? root : root + "/");
}

/** The item whose root most deeply contains `p` (canonical), if any. */
export function deepest<T extends { root: string }>(items: Iterable<T>, p: string): T | null {
  let best: T | null = null;
  for (const it of items) if (contains(it.root, p) && (!best || it.root.length > best.root.length)) best = it;
  return best;
}

/**
 * The enclosing repository's top level: the nearest folder with a `.git` entry
 * (a folder, or a file for linked worktrees and submodules, which are their own
 * roots, as `git rev-parse --show-toplevel` has it). null outside a repository.
 */
export function gitRoot(p: string): string | null {
  let dir = p;
  try {
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch {
    return null;
  }
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Default display name for a root: its folder name ("/" for the file system root). */
export function nameFor(root: string): string {
  return path.basename(root) || root;
}
