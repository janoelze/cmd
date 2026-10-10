// Reading a SQLite file without leaving a trace: a read-only connection to a
// WAL file still makes its -shm (and an empty -wal) and can't remove them when
// it closes. peek() removes the ones it made. For the core's checks before it
// opens its state (data/state-dir.ts), under the core lock (lock.ts), so no
// other process has them open.

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** `fn` on a read-only connection to `file`; undefined when there is no file. Leaves the folder as it found it. */
export function peek<T>(file: string, fn: (db: DatabaseSync) => T): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  const sidecars = [`${file}-wal`, `${file}-shm`].filter((f) => !fs.existsSync(f));
  const db = new DatabaseSync(file, { readOnly: true, timeout: 2000 });
  try {
    return fn(db);
  } finally {
    db.close();
    // A WAL with frames in it would be another writer's: kept.
    for (const f of sidecars) if (!f.endsWith("-wal") || fileSize(f) === 0) fs.rmSync(f, { force: true });
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
