// WAL checkpoints for the event log, on their own thread and connection (data/
// service.ts, `maintenance`). SQLite checkpoints when the WAL reaches 1000 pages,
// inside whichever commit got there: on a big log that is hundreds of ms of the
// core's thread. Here a passive checkpoint runs every few seconds instead; it
// writes what it can without waiting for readers or writers.

import { DatabaseSync } from "node:sqlite";
import { workerData } from "node:worker_threads";

const EVERY_MS = 3000;

const db = new DatabaseSync((workerData as { file: string }).file);
setInterval(() => {
  try {
    db.exec(`PRAGMA wal_checkpoint(PASSIVE)`);
  } catch {
    // busy: the next one
  }
}, EVERY_MS);
