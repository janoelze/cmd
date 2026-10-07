// The search vocabulary (every indexed term and how many events hold it) read
// from the log on its own connection, for the search view (search.ts): on a
// big log the read takes hundreds of ms, which the core's thread must not spend.
// Answers once, as two arrays (cheaper to hand over than 100k objects), and exits.

import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const db = new DatabaseSync((workerData as { file: string }).file, { readOnly: true });
const rows = db.prepare(`SELECT term, doc FROM events_vocab`).all() as { term: string; doc: number }[];
db.close();
parentPort!.postMessage({ terms: rows.map((r) => r.term), docs: rows.map((r) => r.doc) });
