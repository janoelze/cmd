// Session search over the event log (docs/28 §4, C3; docs/33): the palette's
// ?query, its history and the Navigator's search. The searching is
// search-worker.ts's, on a long-lived worker with its own read-only
// connections, so a common word never blocks the core's thread (AR1-06-06);
// this side forwards requests and answers. A worker that dies or times out fails
// what it was asked (an error, never a wait) and is started again on the next
// request after a short pause. A log in memory (tests) is searched in-process.

import { Worker } from "node:worker_threads";
import type { HistoryHit, SearchHit } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import type { DataService } from "../service.ts";
import { SearchEngine, type SearchReply, type SearchRequest, type SearchWorkerData } from "./search-worker.ts";
import type { SessionsView } from "./sessions.ts";

export { snippetOf, weightOf } from "./search-worker.ts";

const log = logger("search");

/** A request unanswered this long fails, and the worker is replaced. */
const TIMEOUT_MS = 20_000;
/** After the worker died, requests fail this long before a new one starts. */
const RESTART_MS = 1000;

export interface SearchViewOptions {
  /** A vocabulary up to this many terms is read again as soon as the log grows (search-worker.ts). */
  eagerTerms?: number;
  /** The views file the worker reads sessions from (views.sqlite); without it, a log on disk is searched in-process. */
  viewsFile?: string | null;
  timeoutMs?: number;
  restartMs?: number;
}

type Request = Omit<Extract<SearchRequest, { op: "search" }>, "id"> | Omit<Extract<SearchRequest, { op: "history" }>, "id">;

export class SearchView {
  #engine: SearchEngine | null = null;
  #files: SearchWorkerData["search"] | null = null;
  #worker: Worker | null = null;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #id = 0;
  #retryAt = 0;
  #timeoutMs: number;
  #restartMs: number;
  #closed = false;

  constructor(data: DataService, sessions: SessionsView, opts: SearchViewOptions = {}) {
    this.#timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    this.#restartMs = opts.restartMs ?? RESTART_MS;
    const file = data.store.file;
    if (file !== ":memory:" && opts.viewsFile) this.#files = { events: file, views: opts.viewsFile, eagerTerms: opts.eagerTerms };
    else this.#engine = new SearchEngine(data.store.db, (key) => sessions.get(key), { eagerTerms: opts.eagerTerms });
  }

  /** Sessions matching `text`, best first, one hit each. */
  search(text: string, limit = 60, now = Date.now()): Promise<SearchHit[]> {
    if (this.#engine) return attempt(() => this.#engine!.search(text, limit, now));
    return this.#ask({ op: "search", text, limit, now }) as Promise<SearchHit[]>;
  }

  /** Commands, pages and files matching `text`, `limit` per kind (search-worker.ts). */
  history(text: string, o: { workspaceId?: string | null; limit?: number } = {}, now = Date.now()): Promise<HistoryHit[]> {
    if (this.#engine) return attempt(() => this.#engine!.history(text, o, now));
    return this.#ask({ op: "history", text, workspaceId: o.workspaceId ?? null, limit: o.limit, now }) as Promise<HistoryHit[]>;
  }

  /** Call after the log grew so typo tolerance sees new words (within a few minutes; at once while the vocabulary is small). */
  invalidate(): void {
    if (this.#engine) this.#engine.invalidate();
    else this.#worker?.postMessage({ op: "invalidate" } satisfies SearchRequest); // a worker started later reads it fresh
  }

  /** Starts the worker and its first vocabulary read, so the first search has typo tolerance (Core.start). */
  warm(): void {
    if (this.#engine) this.#engine.warm();
    else this.#spawn()?.postMessage({ op: "warm" } satisfies SearchRequest);
  }

  /** The worker, while one runs (tests). */
  get worker(): Worker | null {
    return this.#worker;
  }

  close(): void {
    this.#closed = true;
    const w = this.#worker;
    this.#lost(w, "Search is closed");
    void w?.terminate();
  }

  #ask(req: Request): Promise<unknown> {
    const w = this.#spawn();
    if (!w) return Promise.reject(new Error(this.#closed ? "Search is closed" : "Search is restarting. Try again in a moment."));
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Stuck on something (a lock, a runaway query): this request fails, and so does the worker.
        this.#pending.delete(id);
        reject(new Error("Search took too long"));
        log.warn(`a ${req.op} took over ${this.#timeoutMs} ms; restarting the search worker`);
        this.#lost(w, "Search took too long");
        void w.terminate();
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      w.postMessage({ ...req, id } as SearchRequest);
    });
  }

  /** The running worker, or a new one; null while it may not start yet (it just died) or after close. */
  #spawn(): Worker | null {
    if (this.#worker) return this.#worker;
    if (!this.#files || this.#closed || Date.now() < this.#retryAt) return null;
    const w = new Worker(new URL("./search-worker.ts", import.meta.url), { workerData: { search: this.#files } satisfies SearchWorkerData });
    w.unref();
    w.on("message", (m: SearchReply) => {
      const p = this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      clearTimeout(p.timer);
      if ("error" in m) p.reject(new Error(m.error));
      else p.resolve(m.result);
    });
    w.on("error", (err) => {
      log.warn(`the search worker failed: ${err.message}`);
      this.#lost(w, "Search failed. Try again in a moment.");
    });
    w.on("exit", (code) => this.#lost(w, `Search stopped (${code}). Try again in a moment.`));
    this.#worker = w;
    return w;
  }

  /** The worker is gone: what it was asked fails now, and the next one starts after a pause. */
  #lost(w: Worker | null, message: string): void {
    if (!w || this.#worker !== w) return;
    this.#worker = null;
    this.#retryAt = Date.now() + this.#restartMs;
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
      this.#pending.delete(id);
    }
  }
}

/** A result on this thread as a promise (a throw rejects it). */
function attempt<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err as Error);
  }
}
