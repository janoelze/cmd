// Indexing worker: keeps the transcript index current without blocking the core.
// Full pass on start, then a pass whenever a transcript directory changes.

import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { indexCounts, indexPass, openIndex, type TranscriptRoot } from "./index.ts";

export interface WorkerInit {
  dbPath: string;
  roots: TranscriptRoot[];
}

export type WorkerMessage =
  | { type: "progress"; done: number; total: number }
  | { type: "pass"; changed: number; removed: number; sessions: number; files: number }
  | { type: "error"; message: string };

const { dbPath, roots } = workerData as WorkerInit;
const post = (m: WorkerMessage) => parentPort!.postMessage(m);
const db = openIndex(dbPath);

let running = false;
let again = false;
let lastPass = 0;
function pass(): void {
  if (running) {
    again = true; // coalesce bursts of file events into one follow-up pass
    return;
  }
  running = true;
  lastPass = Date.now();
  try {
    const r = indexPass(db, roots, (done, total) => post({ type: "progress", done, total }));
    post({ type: "pass", ...r, ...indexCounts(db) });
  } catch (err) {
    post({ type: "error", message: (err as Error).message });
  } finally {
    running = false;
  }
  if (again) {
    again = false;
    setTimeout(pass, 0);
  }
}

pass();

// Transcripts are appended to constantly while agents run; batch changes. A pass
// re-indexes each changed transcript whole (hundreds of ms for a long session),
// so live sessions are re-indexed at most every MIN_INTERVAL. A pending pass is
// kept, not pushed back: a session that writes constantly still gets indexed.
const QUIET = 3000;
const MIN_INTERVAL = 30_000;
let timer: ReturnType<typeof setTimeout> | undefined;
const schedule = () => {
  if (timer) return;
  timer = setTimeout(
    () => {
      timer = undefined;
      pass();
    },
    Math.max(QUIET, lastPass + MIN_INTERVAL - Date.now()),
  );
};
for (const r of roots) {
  try {
    fs.watch(r.dir, { recursive: true }, (_e, name) => {
      if (!name || String(name).endsWith(".jsonl")) schedule();
    });
  } catch {}
}
// FSEvents can drop events; a slow periodic pass is the backstop.
setInterval(pass, 5 * 60_000);
