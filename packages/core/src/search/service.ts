// Runs the indexing worker and answers searches from a read-only connection.

import fs from "node:fs";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import type { AgentKind } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { Searcher, type IndexStatus, type SearchHit } from "./index.ts";
import type { TranscriptRoot } from "./sources.ts";
import type { WorkerMessage, WorkerRequest } from "./worker.ts";

const log = logger("search");

export class SearchService extends EventEmitter<{ status: [IndexStatus] }> {
  #dbPath: string;
  #worker: Worker | null = null;
  #searcher: Searcher | null = null;
  #status: IndexStatus = { sessions: 0, files: 0, indexing: false, done: 0, total: 0 };
  /** Transcript paths already passed to the worker. */
  #reported = new Set<string>();

  constructor(dbPath: string, roots: TranscriptRoot[]) {
    super();
    this.#dbPath = dbPath;
    this.#worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { dbPath, roots } });
    this.#worker.unref();
    this.#worker.on("message", (m: WorkerMessage) => this.#onMessage(m));
    this.#worker.on("error", (err) => log.error("worker failed", err));
    this.#setStatus({ indexing: true });
  }

  status(): IndexStatus {
    return this.#status;
  }

  search(text: string, limit?: number): SearchHit[] {
    return this.#reader()?.search(text, limit) ?? [];
  }

  recent(limit?: number, exclude?: string[]): SearchHit[] {
    return this.#reader()?.recent(limit, exclude) ?? [];
  }

  /** A live agent's transcript: if it lies outside every known folder, its folder is indexed from now on. */
  learn(agent: AgentKind, transcriptPath: string): void {
    if (this.#reported.has(transcriptPath)) return;
    this.#reported.add(transcriptPath);
    this.#worker?.postMessage({ type: "learn", agent, path: transcriptPath } satisfies WorkerRequest);
  }

  /** Rebuilds the index from scratch (e.g. after a parser fix); folders learned from agents are kept. */
  reindex(): void {
    this.#worker?.postMessage({ type: "reindex" } satisfies WorkerRequest);
    this.#setStatus({ indexing: true, done: 0, total: 0 });
  }

  /** Resolves once the worker has stopped (it holds the index open for writing). */
  async close(): Promise<void> {
    this.removeAllListeners();
    this.#searcher?.close();
    this.#searcher = null;
    const w = this.#worker;
    this.#worker = null;
    await w?.terminate();
  }

  #reader(): Searcher | null {
    if (this.#searcher) return this.#searcher;
    if (!fs.existsSync(this.#dbPath)) return null;
    try {
      this.#searcher = new Searcher(new DatabaseSync(this.#dbPath, { readOnly: true }));
      this.#setStatus(this.#searcher.counts());
    } catch {
      return null; // schema not created yet
    }
    return this.#searcher;
  }

  #onMessage(m: WorkerMessage): void {
    if (m.type === "progress") this.#setStatus({ indexing: m.done < m.total, done: m.done, total: m.total });
    else if (m.type === "pass") {
      this.#searcher?.invalidate();
      this.#setStatus({ indexing: false, sessions: m.sessions, files: m.files, done: 0, total: 0 });
    } else if (m.type === "learned") log.info(`now indexing ${m.root.agent ?? "mixed"} transcripts in ${m.root.dir}`);
    else log.error(m.message);
  }

  #setStatus(patch: Partial<IndexStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.emit("status", this.#status);
  }
}
