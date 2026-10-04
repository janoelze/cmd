// One core per state dir: an exclusive lock on $CMD_HOME/core.lock, held for
// the core's whole life and released by the kernel however it ends (SIGKILL
// included). Whether a core answers on its socket says nothing about whether
// one runs (the socket file can be removed under a live core, and a busy one
// can refuse connections), so this, not the socket, decides. Node has no
// flock(); SQLite's exclusive lock (fcntl, on the file) is the same thing.

import { DatabaseSync } from "node:sqlite";

export interface InstanceLock {
  release(): void;
}

/** Take the lock, or null if another process holds it. */
export function acquireLock(file: string): InstanceLock | null {
  const db = new DatabaseSync(file, { timeout: 0 });
  try {
    db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
  } catch {
    db.close();
    return null;
  }
  // The handle holds the lock: keep it referenced until release().
  return { release: () => db.isOpen && db.close() };
}
