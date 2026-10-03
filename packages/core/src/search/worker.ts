// Indexing worker: keeps the transcript index current without blocking the core.
// Full pass on start, then a pass whenever a transcript directory changes.
// Folders reported by live agents (learn) are remembered in the index and
// watched from then on.

import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import type { AgentKind } from "@cmd/protocol";
import { clearIndex, indexCounts, indexPass, learnedRoots, openIndex, saveLearnedRoot } from "./index.ts";
import { registerBuiltinSources } from "./builtin.ts";
import { covers, isDir, locateContext, TranscriptSources, type TranscriptRoot } from "./sources.ts";

export interface WorkerInit {
  dbPath: string;
  roots: TranscriptRoot[];
}

/** Core → worker. */
export type WorkerRequest = { type: "learn"; agent: AgentKind; path: string } | { type: "reindex" };

export type WorkerMessage =
  | { type: "progress"; done: number; total: number }
  | { type: "pass"; changed: number; removed: number; sessions: number; files: number }
  | { type: "learned"; root: TranscriptRoot }
  | { type: "error"; message: string };

const { dbPath, roots: located } = workerData as WorkerInit;
const post = (m: WorkerMessage) => parentPort!.postMessage(m);
const db = openIndex(dbPath);
// Its own registry: sources hold functions, which can't cross from the core.
const sources = registerBuiltinSources(new TranscriptSources());
const roots = [...located];
for (const r of learnedRoots(db)) {
  if (isDir(r.dir) && !roots.some((k) => k.dir === r.dir || covers(k, r.dir))) roots.push(r);
}

function pass(): void {
  try {
    const r = indexPass(db, roots, sources, (done, total) => post({ type: "progress", done, total }));
    post({ type: "pass", ...r, ...indexCounts(db) });
  } catch (err) {
    post({ type: "error", message: (err as Error).message });
  }
}

// Transcripts are appended to constantly while agents run; batch changes. A pass
// re-indexes each changed transcript whole (hundreds of ms for a long session),
// so live sessions are re-indexed at most every MIN_INTERVAL. A pending pass is
// kept, not pushed back: a session that writes constantly still gets indexed.
const QUIET = 3000;
const MIN_INTERVAL = 30_000;
let lastPass = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const schedule = (delay?: number) => {
  if (timer) return;
  timer = setTimeout(
    () => {
      timer = undefined;
      lastPass = Date.now();
      pass();
    },
    delay ?? Math.max(QUIET, lastPass + MIN_INTERVAL - Date.now()),
  );
};

function watch(r: TranscriptRoot): void {
  try {
    fs.watch(r.dir, { recursive: true }, (_e, name) => {
      if (!name || String(name).endsWith(".jsonl")) schedule();
    });
  } catch {}
}

lastPass = Date.now();
pass();
for (const r of roots) watch(r);
// FSEvents can drop events; a slow periodic pass is the backstop.
setInterval(() => schedule(0), 5 * 60_000);

parentPort!.on("message", (m: WorkerRequest) => {
  if (m.type === "reindex") {
    clearIndex(db);
    lastPass = Date.now();
    pass();
    return;
  }
  const root = sources.learn(m.agent, m.path, roots, locateContext());
  if (!root || !isDir(root.dir)) return;
  roots.push(root);
  saveLearnedRoot(db, root);
  watch(root);
  post({ type: "learned", root });
  schedule(0);
});
