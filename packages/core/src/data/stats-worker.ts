// `data.stats` off the core's thread: sizes per type read every row of the log
// (seconds on a big one), so a worker answers from its own read-only connection.

import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { logStats } from "./store.ts";

const file = workerData.file as string;
const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
try {
  parentPort!.postMessage({ stats: logStats(db, file) });
} catch (err) {
  parentPort!.postMessage({ error: (err as Error).message });
} finally {
  db.close();
}
