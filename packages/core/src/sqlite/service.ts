// SQLite windows' reads (docs/36-sqlite-viewer.md): a worker per open database
// (worker.ts), started on first use and stopped after a minute idle, so the
// core's thread never waits on a file. A request that takes too long ends its
// worker (and every request waiting on it) rather than hang the window for
// good; the next request starts a fresh one. Opening is what tells whether a
// file is a database, so an error reaches the caller as a plain message.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { SqliteQuery, SqliteResult, SqliteRowsQuery, SqliteSchema } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import type { SqliteOp, SqliteReply, SqliteRequest } from "./worker.ts";

const log = logger("sqlite");

/** A worker with nothing to do stops after this. */
const IDLE_MS = 60_000;
/** A request taking longer ends its worker; an export (a whole table to disk) gets longer. */
const TIMEOUT_MS = 30_000;
const EXPORT_TIMEOUT_MS = 10 * 60_000;

const MAGIC = "SQLite format 3\0";

/** The file starts like a SQLite database (an empty file is one too: SQLite opens it as such). */
export function isSqliteFile(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    return n === 0 || (n === 16 && buf.toString("latin1") === MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The database a `-wal`, `-shm` or `-journal` sidecar belongs to, if that exists; else the path itself. */
export function databaseOf(file: string): string {
  const m = /^(.*)-(wal|shm|journal)$/.exec(file);
  if (m && fs.existsSync(m[1]!)) return m[1]!;
  return file;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class Database {
  worker: Worker;
  pending = new Map<number, Pending>();
  idle: NodeJS.Timeout | null = null;
  #next = 1;

  readonly file: string;
  #onGone: () => void;

  constructor(file: string, onGone: () => void) {
    this.file = file;
    this.#onGone = onGone;
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { path: file } });
    this.worker.unref();
    this.worker.on("message", (m: SqliteReply) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if ("error" in m) p.reject(new Error(m.error));
      else p.resolve(m.result);
      this.#rest();
    });
    // The worker died (it couldn't open the file, or crashed): everything waiting fails with why.
    this.worker.on("error", (err) => this.#fail(err.message));
    this.worker.on("exit", () => this.#fail("The database can't be read right now."));
  }

  ask(req: SqliteOp, timeoutMs = TIMEOUT_MS): Promise<unknown> {
    if (this.idle) clearTimeout(this.idle), (this.idle = null);
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        log.warn(`${path.basename(this.file)}: ${req.op} took over ${timeoutMs / 1000} s, stopping its reader`);
        this.#fail("That took too long and was stopped.");
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, ...req } as SqliteRequest);
    });
  }

  #rest(): void {
    if (this.pending.size) return;
    this.idle = setTimeout(() => this.close(), IDLE_MS);
    this.idle.unref();
  }

  #fail(message: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
    this.close();
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.#onGone();
    void this.worker.terminate().catch(() => {});
  }
}

export class SqliteService {
  #open = new Map<string, Database>();

  #db(file: string): Database {
    const abs = path.resolve(file);
    let db = this.#open.get(abs);
    if (!db) {
      if (!fs.existsSync(abs)) throw new Error(`There's no file at ${abs}.`);
      if (!isSqliteFile(abs)) throw new Error(`${path.basename(abs)} isn't a SQLite database.`);
      db = new Database(abs, () => {
        if (this.#open.get(abs) === db) this.#open.delete(abs);
      });
      this.#open.set(abs, db);
    }
    return db;
  }

  async schema(file: string): Promise<SqliteSchema> {
    return (await this.#db(file).ask({ op: "schema" })) as SqliteSchema;
  }

  async rows(q: SqliteRowsQuery): Promise<SqliteResult> {
    const { path: file, ...rest } = q;
    return (await this.#db(file).ask({ op: "rows", ...rest })) as SqliteResult;
  }

  async query(q: SqliteQuery): Promise<SqliteResult> {
    const { path: file, ...rest } = q;
    return (await this.#db(file).ask({ op: "query", ...rest })) as SqliteResult;
  }

  /** A whole table or view to a CSV file. */
  async export(file: string, table: string, to: string): Promise<{ rows: number; bytes: number }> {
    return (await this.#db(file).ask({ op: "export", table, file: path.resolve(to.replace(/^~(?=$|\/)/, os.homedir())) }, EXPORT_TIMEOUT_MS)) as { rows: number; bytes: number };
  }

  /** Databases with a reader running now. */
  open(): string[] {
    return [...this.#open.keys()];
  }

  close(): void {
    for (const db of [...this.#open.values()]) db.close();
    this.#open.clear();
  }
}
