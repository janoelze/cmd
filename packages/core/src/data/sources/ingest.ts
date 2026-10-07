// Owned transcripts (docs/28 §5, requirement A6): the core's copy of every agent
// session, read from the agents' folders into the event log. A worker walks the
// folders and reads files from where they were last read; this coordinator
// records each file's events (the data layer's policy and redaction apply),
// feeds the sessions view, remembers how far each file was read
// (transcript_files, in the views file) and which folders live agents taught
// it (entities of kind transcript-root), and reports progress as the search
// status the Settings window shows. `inline` runs the same pass on this thread
// (tests, the lab).

import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import type { AgentKind, SearchStatus } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { covers, isDir, locateContext, type TranscriptRoot, type TranscriptSources } from "../../search/sources.ts";
import type { DataService } from "../service.ts";
import type { SessionsView } from "../views/sessions.ts";
import type { ViewsStore } from "../views/views.ts";
import { planPass, scanFiles, type FileState } from "./ingest-pass.ts";
import type { IngestMessage, IngestRequest, WorkerInit } from "./ingest-worker.ts";
import { readTranscript } from "./transcripts.ts";
import { describeSession } from "../describe.ts";
import { inlinePacer, type Pacer } from "../../scheduler.ts";

const log = logger("transcripts");

const FILES_SQL = `
  CREATE TABLE IF NOT EXISTS transcript_files (
    path TEXT PRIMARY KEY,
    root_dir TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime REAL NOT NULL,
    offset INTEGER NOT NULL,
    lines INTEGER NOT NULL,
    agent TEXT
  );
`;

/**
 * Events recorded at a time while reading in the background (#recordInSteps):
 * starts at STEP, halves after a step over STEP_SLOW_MS (big messages, blobs to
 * compress) and doubles after one under STEP_FAST_MS, between STEP_MIN and STEP_MAX.
 */
const STEP = 100;
const STEP_MIN = 20;
const STEP_MAX = 400;
const STEP_SLOW_MS = 40;
const STEP_FAST_MS = 10;

export interface IngestOptions {
  data: DataService;
  views: ViewsStore;
  sessions: SessionsView;
  sources: TranscriptSources;
  /** The folders to read (TranscriptSources.locate plus archives). */
  roots: TranscriptRoot[];
  /** Read on this thread, now, instead of in a worker (tests). */
  inline?: boolean;
  /** Between steps of recording a file (the scheduler; by default the next tick). */
  pace?: Pacer;
}

export class TranscriptIngest extends EventEmitter<{ status: [SearchStatus]; changed: [] }> {
  #o: IngestOptions;
  #worker: Worker | null = null;
  #status: SearchStatus = { sessions: 0, files: 0, indexing: false, done: 0, total: 0 };
  #roots: TranscriptRoot[];
  /** Transcript paths already passed on (learn), so an agent's every update doesn't repeat it. */
  #reported = new Set<string>();
  #closed = false;

  constructor(o: IngestOptions) {
    super();
    this.#o = o;
    // Version 2: lines without a timestamp were stored at 0 (and dropped by retention): read every file again, those rows first gone.
    if (o.views.ensure("transcript_files", 2, ["transcript_files"], FILES_SQL).rebuilt) o.data.store.delete({ types: ["transcript."], before: 1 });
    this.#roots = [...o.roots];
    for (const r of this.#learnedRoots()) if (isDir(r.dir) && !this.#roots.some((k) => k.dir === r.dir || covers(k, r.dir))) this.#roots.push(r);
    this.#status = { ...this.#status, ...this.#counts() };
    o.sessions.fileOf = (id) => this.#fileOf(id);
  }

  /** The newest file read whose name holds a session id (every agent names its files by it), with its folder's env. */
  #fileOf(sessionId: string): { path: string; env: Record<string, string> | null } | null {
    if (sessionId.length < 4) return null;
    const row = this.#o.views.stmt(`SELECT path, root_dir AS rootDir FROM transcript_files WHERE instr(path, ?) > 0 ORDER BY mtime DESC LIMIT 1`).get(sessionId) as { path: string; rootDir: string } | undefined;
    return row ? { path: row.path, env: this.#roots.find((r) => r.dir === row.rootDir)?.env ?? null } : null;
  }

  /** Reads what changed: in a worker, or now when inline. */
  start(): void {
    if (this.#o.inline) return this.pass();
    this.#worker = new Worker(new URL("./ingest-worker.ts", import.meta.url), { workerData: { roots: this.#roots, known: this.#known() } satisfies WorkerInit });
    this.#worker.unref();
    this.#worker.on("message", (m: IngestMessage) => this.#onMessage(m));
    this.#worker.on("error", (err) => log.error("ingest worker failed", err));
    this.#setStatus({ indexing: true });
  }

  status(): SearchStatus {
    return this.#status;
  }

  roots(): TranscriptRoot[] {
    return [...this.#roots];
  }

  /** A live agent's transcript: if it lies outside every known folder, its folder is read from now on. */
  learn(agent: AgentKind, transcriptPath: string): void {
    if (this.#reported.has(transcriptPath)) return;
    this.#reported.add(transcriptPath);
    if (this.#worker) this.#send({ type: "learn", agent, path: transcriptPath });
    else {
      const root = this.#o.sources.learn(agent, transcriptPath, this.#roots, locateContext());
      if (root) this.#learned(root), this.pass();
    }
  }

  /** An agent home the core discovered (agents/homes.ts): its transcripts are read too. */
  learnHome(agent: AgentKind, dir: string): void {
    if (this.#worker) this.#send({ type: "home", agent, dir });
    else {
      const found = this.#o.sources.homeRoots(agent, dir, this.#roots, locateContext());
      for (const root of found) this.#learned(root);
      if (found.length) this.pass();
    }
  }

  /** Reads every file again from the start (a parser fix); the log dedupes by id, so nothing doubles. */
  reindex(): void {
    this.#o.views.db.exec(`DELETE FROM transcript_files`);
    if (this.#worker) this.#send({ type: "reindex" });
    else this.pass();
    this.#setStatus({ indexing: true, done: 0, total: 0 });
  }

  /** Reads what changed now, on this thread (inline mode; the worker does this on its own). */
  pass(): void {
    const files = scanFiles(this.#roots);
    const known = new Map(this.#known().map((k) => [k.path, k]));
    const { changed, removed } = planPass(files, known);
    for (const p of removed) this.#o.views.stmt(`DELETE FROM transcript_files WHERE path = ?`).run(p);
    for (const f of changed) {
      const before = known.get(f.path) ?? null;
      const r = readTranscript({ agent: f.root.agent, path: f.path, env: f.root.env }, before, this.#o.sources, f);
      this.#record({ path: f.path, rootDir: f.root.dir, size: f.size, mtime: f.mtime, offset: r.offset, lines: r.lines, agent: r.agent }, r.events, f.root.env);
    }
    this.#setStatus({ indexing: false, done: 0, total: 0, ...this.#counts() });
    if (changed.length || removed.length) this.emit("changed");
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.removeAllListeners();
    const w = this.#worker;
    this.#worker = null;
    await w?.terminate();
  }

  #send(m: IngestRequest): void {
    this.#worker?.postMessage(m);
  }

  /**
   * #record a few hundred events at a time, letting the core answer in between:
   * keystrokes reach terminals through it, and a first read is hundreds of
   * thousands of events. Where the file's reading stopped is saved with the last.
   * The worker redacted them already.
   */
  /** `final`: this is the file's last chunk (the worker sends a big file in several), so its state is saved with the last step. */
  async #recordInSteps(state: FileState, events: ReturnType<typeof readTranscript>["events"], env: Record<string, string> | null, final = true): Promise<void> {
    const pace = this.#o.pace ?? inlinePacer;
    const done = pace.mark("transcripts");
    try {
      let step = STEP;
      for (let i = 0; ; ) {
        const n = Math.min(step, events.length - i);
        const last = i + n >= events.length;
        const t0 = performance.now();
        this.#record(last && final ? state : null, events.slice(i, i + n), env, state, true);
        if (last) return;
        i += n;
        const ms = performance.now() - t0;
        if (ms > STEP_SLOW_MS) step = Math.max(STEP_MIN, step >> 1);
        else if (ms < STEP_FAST_MS) step = Math.min(STEP_MAX, step << 1);
        await pace.yield();
        if (this.#closed) return;
      }
    } finally {
      done();
    }
  }

  /** Events into the log and the sessions view; with `state`, where the file's reading stopped into the table. */
  #record(state: FileState | null, events: ReturnType<typeof readTranscript>["events"], env: Record<string, string> | null, file: FileState = state!, redacted = false): void {
    if (events.length) {
      const stored = this.#o.data.recordBatch(events, { redacted });
      this.#o.sessions.apply(stored, { path: file.path, env, mtime: file.mtime });
      for (const key of new Set(stored.map((e) => e.sessionId).filter((k): k is string => !!k))) {
        const row = this.#o.sessions.get(key);
        if (row) describeSession(this.#o.data, row);
      }
    }
    if (state) this.#o.views.stmt(`INSERT OR REPLACE INTO transcript_files (path, root_dir, size, mtime, offset, lines, agent) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(state.path, state.rootDir, state.size, state.mtime, state.offset, state.lines, state.agent);
  }

  #onMessage(m: IngestMessage): void {
    if (this.#closed) return;
    switch (m.type) {
      case "progress":
        this.#setStatus({ indexing: m.done < m.total, done: m.done, total: m.total });
        break;
      case "file":
        void this.#recordInSteps(m.state, m.events, m.file.root.env, !m.more)
          .catch((err) => log.error(`recording ${m.file.path} failed`, err))
          .finally(() => this.#send({ type: "ack" }));
        break;
      case "removed":
        for (const p of m.paths) this.#o.views.stmt(`DELETE FROM transcript_files WHERE path = ?`).run(p);
        break;
      case "pass":
        this.#setStatus({ indexing: false, done: 0, total: 0, ...this.#counts() });
        if (m.changed || m.removed) this.emit("changed");
        if (m.changed) log.info("transcripts read", { changed: m.changed, removed: m.removed, files: m.files });
        break;
      case "learned":
        this.#learned(m.root);
        break;
      case "error":
        log.warn(m.message);
    }
  }

  #learned(root: TranscriptRoot): void {
    if (this.#roots.some((k) => k.dir === root.dir)) return;
    this.#roots.push(root);
    this.#o.data.store.entity("transcript-root", root.dir, { agent: root.agent, depth: root.depth ?? null, fileName: root.fileName ?? null, env: root.env }, Date.now());
    log.info(`now reading ${root.agent ?? "mixed"} transcripts in ${root.dir}`);
  }

  #learnedRoots(): TranscriptRoot[] {
    return this.#o.data.store.entities("transcript-root").map((e) => ({ agent: (e.attrs.agent as AgentKind | null) ?? null, dir: e.id, depth: (e.attrs.depth as number | null) ?? undefined, fileName: (e.attrs.fileName as string | null) ?? undefined, env: (e.attrs.env as Record<string, string> | null) ?? null }));
  }

  #known(): FileState[] {
    return this.#o.views.stmt(`SELECT path, root_dir AS rootDir, size, mtime, offset, lines, agent FROM transcript_files`).all() as unknown as FileState[];
  }

  #counts(): { sessions: number; files: number } {
    return { sessions: this.#o.sessions.counts().sessions, files: (this.#o.views.stmt(`SELECT COUNT(*) AS n FROM transcript_files`).get() as { n: number }).n };
  }

  #setStatus(patch: Partial<SearchStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.emit("status", this.#status);
  }
}
