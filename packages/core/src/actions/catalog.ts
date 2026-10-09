// One folder's actions (docs/39, "Keeping it current"): every source run over
// the root and, for those that apply, each workspace package; the folders that
// were read, to watch; and an error for a file that couldn't be parsed, whose
// last good actions are kept so a half-saved package.json doesn't empty the list.

import path from "node:path";
import fs from "node:fs";
import type { WorkspaceAction } from "@cmd/protocol";
import { classify } from "./classify.ts";
import { SOURCES, makeDir, workspacePackages, type ActionSource, type Found } from "./sources.ts";

export interface Scan {
  actions: WorkspaceAction[];
  /** Per source and folder: what it found last time it could read its file. */
  found: Map<string, Found[]>;
  errors: { file: string; error: string }[];
  /** Folders to watch: the root, each package, and the sources' own folders that exist. */
  folders: string[];
}

/** Which file a source's error is about, for the message ("package.json can't be read"). */
const FILE_OF: Record<string, string[]> = {
  npm: ["package.json"],
  just: ["justfile", ".justfile", "Justfile"],
  task: ["Taskfile.yml", "Taskfile.yaml", "taskfile.yml", "taskfile.yaml"],
  make: ["GNUmakefile", "makefile", "Makefile"],
  mise: ["mise.toml", ".mise.toml"],
  deno: ["deno.json", "deno.jsonc"],
  composer: ["composer.json"],
  python: ["pyproject.toml"],
  cargo: ["Cargo.toml"],
  compose: ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"],
  vscode: [".vscode/tasks.json"],
};

export function scan(root: string, prev: Scan | null, sources: ActionSource[] = SOURCES): Scan {
  const found = new Map<string, Found[]>();
  const errors: Scan["errors"] = [];
  const folders = new Set([root]);
  const dirs = [makeDir(root, root), ...workspacePackages(root).map((p) => makeDir(root, p.path, p.name))];
  for (const d of dirs.slice(1)) folders.add(d.path);
  for (const src of sources) {
    for (const f of src.folders ?? []) if (isDir(path.join(root, f))) folders.add(path.join(root, f));
    for (const dir of src.packages ? dirs : dirs.slice(0, 1)) {
      const key = `${src.id}\0${dir.path}`;
      try {
        found.set(key, src.find(dir));
      } catch (e) {
        const file = (FILE_OF[src.id] ?? []).find((f) => dir.exists(f)) ?? src.id;
        errors.push({ file: dir.file(file), error: (e as Error).message.split("\n")[0]!.slice(0, 200) });
        found.set(key, prev?.found.get(key) ?? []);
      }
    }
  }
  const actions: WorkspaceAction[] = [];
  const ids = new Set<string>();
  for (const [key, list] of found) {
    const source = key.slice(0, key.indexOf("\0"));
    for (const f of list) {
      const id = `${source}:${f.file}:${f.name}`;
      if (ids.has(id)) continue;
      ids.add(id);
      const { kind: _kind, long: _long, risky: _risky, file, line, ...rest } = f;
      actions.push({ ...rest, id, source: { kind: source, file, ...(line ? { line } : {}) }, ...classify(f) });
    }
  }
  return { actions, found, errors, folders: [...folders] };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
