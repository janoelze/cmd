// One pass over the transcript folders (docs/28 §5, A6): which files are there,
// which changed since they were last read, which are gone. Pure file-system
// work, shared by the ingest worker and the inline ingest tests use.

import fs from "node:fs";
import path from "node:path";
import type { AgentKind } from "@cmd/protocol";
import type { TranscriptRoot } from "../../search/sources.ts";

/** A transcript file as found in a root. */
export interface FoundFile {
  path: string;
  root: TranscriptRoot;
  size: number;
  mtime: number;
}

/** Where a file's reading stopped, as kept between passes. */
export interface FileState {
  path: string;
  rootDir: string;
  size: number;
  mtime: number;
  offset: number;
  lines: number;
  agent: AgentKind | null;
}

/** Every transcript within each root's depth; a file under two roots counts for the first. */
export function scanFiles(roots: TranscriptRoot[]): FoundFile[] {
  const out: FoundFile[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, root: TranscriptRoot, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (root.depth === undefined || depth < root.depth) walk(p, root, depth + 1);
      } else if ((root.fileName ? e.name === root.fileName : e.name.endsWith(".jsonl")) && !seen.has(p)) {
        try {
          const st = fs.statSync(p);
          if (st.isFile()) {
            seen.add(p);
            out.push({ path: p, root, size: st.size, mtime: st.mtimeMs });
          }
        } catch {}
      }
    }
  };
  for (const root of roots) walk(root.dir, root, 1);
  return out;
}

/** Files to read (new, grown or changed) and files that are gone, against what was read before. */
export function planPass(files: FoundFile[], known: Map<string, FileState>): { changed: FoundFile[]; removed: string[] } {
  const changed = files.filter((f) => {
    const k = known.get(f.path);
    return !k || k.size !== f.size || Math.abs(k.mtime - f.mtime) > 1;
  });
  const present = new Set(files.map((f) => f.path));
  const removed = [...known.keys()].filter((p) => !present.has(p));
  return { changed, removed };
}
