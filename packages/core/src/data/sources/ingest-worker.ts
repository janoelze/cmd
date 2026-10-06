// The transcript ingest's worker (docs/28 §5): walks the transcript folders,
// reads what changed since the last pass (from each file's last offset) and
// hands the events to the core one file at a time, waiting for the core to
// record each before reading the next, so a first pass over gigabytes never
// floods the main thread. Watches the folders for changes. The core is the one
// writer; this thread only reads files.

import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import type { AgentKind } from "@cmd/protocol";
import { registerBuiltinSources } from "../../search/builtin.ts";
import { covers, isDir, locateContext, TranscriptSources, type TranscriptRoot } from "../../search/sources.ts";
import type { StoreEvent } from "../store.ts";
import { planPass, scanFiles, type FileState, type FoundFile } from "./ingest-pass.ts";
import { readTranscript } from "./transcripts.ts";

export interface WorkerInit {
  roots: TranscriptRoot[];
  known: FileState[];
}

/** Core → worker. */
export type IngestRequest = { type: "ack" } | { type: "learn"; agent: AgentKind; path: string } | { type: "home"; agent: AgentKind; dir: string } | { type: "reindex" } | { type: "pass" };

/** Worker → core. */
export type IngestMessage =
  | { type: "progress"; done: number; total: number }
  | { type: "file"; file: FoundFile; state: FileState; events: StoreEvent[]; sessionId: string | null }
  | { type: "removed"; paths: string[] }
  | { type: "pass"; changed: number; removed: number; files: number }
  | { type: "learned"; root: TranscriptRoot }
  | { type: "error"; message: string };

const { roots: located, known: knownList } = workerData as WorkerInit;
const post = (m: IngestMessage) => parentPort!.postMessage(m);
// Its own registry: sources hold functions, which can't cross from the core.
const sources = registerBuiltinSources(new TranscriptSources());
const roots = [...located];
const known = new Map<string, FileState>(knownList.map((k) => [k.path, k]));

let ack: (() => void) | null = null;
const acked = () => new Promise<void>((r) => (ack = r));

async function pass(): Promise<void> {
  try {
    const files = scanFiles(roots);
    const { changed, removed } = planPass(files, known);
    if (removed.length) {
      for (const p of removed) known.delete(p);
      post({ type: "removed", paths: removed });
    }
    if (changed.length > 10) post({ type: "progress", done: 0, total: changed.length });
    for (const [i, f] of changed.entries()) {
      const before = known.get(f.path) ?? null;
      let result;
      try {
        result = readTranscript({ agent: f.root.agent, path: f.path, env: f.root.env }, before, sources, f);
      } catch (err) {
        post({ type: "error", message: `${f.path}: ${(err as Error).message}` });
        continue;
      }
      const state: FileState = { path: f.path, rootDir: f.root.dir, size: f.size, mtime: f.mtime, offset: result.offset, lines: result.lines, agent: result.agent };
      known.set(f.path, state);
      const wait = acked();
      post({ type: "file", file: f, state, events: result.events, sessionId: result.sessionId });
      await wait;
      if (changed.length > 10 && (i + 1) % 10 === 0) post({ type: "progress", done: i + 1, total: changed.length });
    }
    post({ type: "pass", changed: changed.length, removed: removed.length, files: files.length });
  } catch (err) {
    post({ type: "error", message: (err as Error).message });
  }
}

// Transcripts are appended to constantly while agents run; batch changes. Only
// a file's new lines are read, so passes are cheap: a few seconds of quiet, and
// a pass at most every MIN_INTERVAL while a session writes without pause.
const QUIET = 2000;
const MIN_INTERVAL = 10_000;
let lastPass = 0;
let running: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const run = () => {
  if (running) return running.then(() => schedule(0));
  lastPass = Date.now();
  running = pass().finally(() => (running = null));
  return running;
};
const schedule = (delay?: number) => {
  if (timer) return;
  timer = setTimeout(
    () => {
      timer = undefined;
      void run();
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

void run();
for (const r of roots) watch(r);
// FSEvents can drop events; a slow periodic pass is the backstop.
setInterval(() => schedule(0), 5 * 60_000);

parentPort!.on("message", (m: IngestRequest) => {
  if (m.type === "ack") {
    ack?.();
    ack = null;
    return;
  }
  if (m.type === "pass") return void schedule(0);
  if (m.type === "reindex") {
    known.clear();
    void run();
    return;
  }
  const found = m.type === "home" ? sources.homeRoots(m.agent, m.dir, roots, locateContext()) : [sources.learn(m.agent, m.path, roots, locateContext())];
  let added = false;
  for (const root of found) {
    if (!root || !isDir(root.dir) || roots.some((k) => k.dir === root.dir || covers(k, root.dir))) continue;
    roots.push(root);
    watch(root);
    post({ type: "learned", root });
    added = true;
  }
  if (added) schedule(0);
});
