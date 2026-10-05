// Files changed during a turn whose folder isn't a git work tree (about one in
// eight of Claude's edits in recorded sessions): a recursive FSEvents watch on
// the agent's folder for the length of the turn. Build output, dependencies and
// VCS folders are left out; a folder too broad to watch (home, /) isn't watched.
// Like git snapshots this sees every writer, so other processes' changes count too.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IGNORE = /(^|\/)(\.git|\.hg|node_modules|dist|build|out|target|\.next|\.cache|__pycache__|\.venv|venv|\.DS_Store)(\/|$)/;
const MAX = 2000;

export interface TurnWatch {
  /** Stops watching; changed files (absolute) → "M", or "D" when gone. */
  stop(): Map<string, string>;
}

/** null when `dir` is too broad or can't be watched. */
export function watchTurn(dir: string): TurnWatch | null {
  const abs = path.resolve(dir);
  if (abs === "/" || abs === os.homedir() || path.dirname(abs) === "/" || abs === path.dirname(os.homedir())) return null;
  const seen = new Set<string>();
  const self = path.basename(abs); // FSEvents reports the watched folder itself by its name
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(abs, { recursive: true }, (_e, name) => {
      if (!name || seen.size >= MAX) return;
      const rel = String(name);
      if (rel !== self && !IGNORE.test(rel)) seen.add(rel);
    });
    watcher.unref();
  } catch {
    return null;
  }
  return {
    stop() {
      watcher.close();
      const out = new Map<string, string>();
      for (const rel of seen) {
        const p = path.join(abs, rel);
        const st = fs.statSync(p, { throwIfNoEntry: false });
        if (st?.isDirectory()) continue;
        out.set(p, st ? "M" : "D");
      }
      return out;
    },
  };
}
