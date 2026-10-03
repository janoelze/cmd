// Runs the indexing worker and answers searches from a read-only connection.

import fs from "node:fs";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { Searcher, type IndexStatus, type SearchHit, type TranscriptRoot } from "./index.ts";
import type { WorkerMessage } from "./worker.ts";

export class SearchService extends EventEmitter<{ status: [IndexStatus] }> {
  #dbPath: string;
  #worker: Worker | null = null;
  #searcher: Searcher | null = null;
  #status: IndexStatus = { sessions: 0, files: 0, indexing: false, done: 0, total: 0 };

  constructor(dbPath: string, roots: TranscriptRoot[]) {
    super();
    this.#dbPath = dbPath;
    this.#worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { dbPath, roots } });
    this.#worker.unref();
    this.#worker.on("message", (m: WorkerMessage) => this.#onMessage(m));
    this.#worker.on("error", (err) => console.error("cmd search worker:", err.message));
    this.#setStatus({ indexing: true });
  }

  status(): IndexStatus {
    return this.#status;
  }

  search(text: string, limit?: number): SearchHit[] {
    return this.#reader()?.search(text, limit) ?? [];
  }

  close(): void {
    void this.#worker?.terminate();
    this.#worker = null;
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
    } else console.error("cmd search:", m.message);
  }

  #setStatus(patch: Partial<IndexStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.emit("status", this.#status);
  }
}
