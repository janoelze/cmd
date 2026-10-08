// The SQLite window's reader (docs/36-sqlite-viewer.md): one worker per open
// database, since node:sqlite is synchronous and a count or a query over a big
// table would stall the core. The file is opened read-only and query_only is
// set, so nothing here can write. Requests carry an id; each gets one reply.

import fs from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type { SqliteColumn, SqliteForeignKey, SqliteIndex, SqliteQuery, SqliteResult, SqliteRowsQuery, SqliteSchema, SqliteTable, SqliteTrigger, SqliteValue } from "@cmd/protocol";

export type SqliteOp = { op: "schema" } | ({ op: "rows" } & Omit<SqliteRowsQuery, "path">) | ({ op: "query" } & Omit<SqliteQuery, "path">);
export type SqliteRequest = { id: number } & SqliteOp;
export type SqliteReply = { id: number; result: unknown } | { id: number; error: string };

/** Text longer than this travels cut, with its length. */
const TEXT_MAX = 10_000;
const ROWS_DEFAULT = 200;
const ROWS_MAX = 1000;
const QUERY_DEFAULT = 500;
const QUERY_MAX = 5000;

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

const cell = (v: unknown): SqliteValue => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return v.length > TEXT_MAX ? { text: v.slice(0, TEXT_MAX), chars: v.length } : v;
  if (v instanceof Uint8Array) return { blob: v.byteLength };
  return String(v);
};

/** Up to `limit` rows of a prepared statement, and whether there were more. */
function take(stmt: StatementSync, args: unknown[], limit: number): { columns: string[]; rows: SqliteValue[][]; truncated: boolean } {
  stmt.setReturnArrays(true);
  const columns = stmt.columns().map((c) => c.name);
  const rows: SqliteValue[][] = [];
  let truncated = false;
  for (const row of stmt.iterate(...(args as never[])) as Iterable<unknown[]>) {
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
    rows.push(row.map(cell));
  }
  return { columns, rows, truncated };
}

export class SqliteReader {
  #db: DatabaseSync;
  #path: string;

  constructor(path: string) {
    this.#path = path;
    this.#db = new DatabaseSync(path, { readOnly: true, timeout: 2000 });
    this.#db.exec("PRAGMA query_only = ON");
  }

  close(): void {
    this.#db.close();
  }

  #one<T>(sql: string, ...args: unknown[]): T {
    return this.#db.prepare(sql).get(...(args as never[])) as T;
  }
  #all<T>(sql: string, ...args: unknown[]): T[] {
    return this.#db.prepare(sql).all(...(args as never[])) as T[];
  }

  schema(): SqliteSchema {
    type Master = { type: string; name: string; tbl_name: string; sql: string | null };
    const master = this.#all<Master>(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`);
    const table = (m: Master): SqliteTable => {
      type Info = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
      const columns: SqliteColumn[] = this.#all<Info>(`PRAGMA table_info(${quote(m.name)})`).map((c) => ({ name: c.name, type: c.type, notNull: !!c.notnull, pk: c.pk, default: c.dflt_value }));
      type Fk = { from: string; table: string; to: string | null };
      const foreignKeys: SqliteForeignKey[] = m.type === "table" ? this.#all<Fk>(`PRAGMA foreign_key_list(${quote(m.name)})`).map((f) => ({ from: f.from, table: f.table, to: f.to })) : [];
      let rows: number | null = null;
      if (m.type === "table") {
        try {
          rows = this.#one<{ n: number }>(`SELECT count(*) AS n FROM ${quote(m.name)}`).n;
        } catch {
          rows = null; // a virtual table whose module is missing
        }
      }
      return { name: m.name, kind: m.type === "view" ? "view" : "table", sql: m.sql, rows, columns, foreignKeys };
    };
    const indexes: SqliteIndex[] = master
      .filter((m) => m.type === "index")
      .map((m) => {
        type Col = { name: string | null };
        const columns = this.#all<Col>(`PRAGMA index_info(${quote(m.name)})`).map((c) => c.name ?? "(expression)");
        const unique = !!this.#all<{ name: string; unique: number }>(`PRAGMA index_list(${quote(m.tbl_name)})`).find((i) => i.name === m.name)?.unique;
        return { name: m.name, table: m.tbl_name, unique, columns, sql: m.sql };
      });
    const triggers: SqliteTrigger[] = master.filter((m) => m.type === "trigger").map((m) => ({ name: m.name, table: m.tbl_name, sql: m.sql }));
    let size = 0;
    try {
      size = fs.statSync(this.#path).size;
    } catch {}
    return {
      size,
      pageSize: this.#one<{ page_size: number }>("PRAGMA page_size").page_size,
      pageCount: this.#one<{ page_count: number }>("PRAGMA page_count").page_count,
      encoding: this.#one<{ encoding: string }>("PRAGMA encoding").encoding,
      userVersion: this.#one<{ user_version: number }>("PRAGMA user_version").user_version,
      wal: this.#one<{ journal_mode: string }>("PRAGMA journal_mode").journal_mode === "wal",
      tables: master.filter((m) => m.type === "table").map(table),
      views: master.filter((m) => m.type === "view").map(table),
      indexes,
      triggers,
    };
  }

  rows(q: Omit<SqliteRowsQuery, "path">): SqliteResult {
    const t0 = performance.now();
    const limit = Math.min(ROWS_MAX, Math.max(1, q.limit ?? ROWS_DEFAULT));
    const offset = Math.max(0, q.offset ?? 0);
    const columns = this.#all<{ name: string }>(`PRAGMA table_info(${quote(q.table)})`).map((c) => c.name);
    if (!columns.length) throw new Error(`no table or view named ${q.table}`);
    const args: unknown[] = [];
    let where = "";
    const filter = q.filter?.trim();
    if (filter) {
      where = ` WHERE ${columns.map((c) => `CAST(${quote(c)} AS TEXT) LIKE ? ESCAPE '\\'`).join(" OR ")}`;
      const like = `%${filter.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      for (const _ of columns) args.push(like);
    }
    const order = q.sort && columns.includes(q.sort.column) ? ` ORDER BY ${quote(q.sort.column)}${q.sort.desc ? " DESC" : ""}` : "";
    const total = this.#one<{ n: number }>(`SELECT count(*) AS n FROM ${quote(q.table)}${where}`, ...args).n;
    const page = take(this.#db.prepare(`SELECT * FROM ${quote(q.table)}${where}${order} LIMIT ? OFFSET ?`), [...args, limit, offset], limit);
    return { columns: page.columns, rows: page.rows, total, truncated: offset + page.rows.length < total, took: Math.round(performance.now() - t0) };
  }

  query(q: Omit<SqliteQuery, "path">): SqliteResult {
    const t0 = performance.now();
    const limit = Math.min(QUERY_MAX, Math.max(1, q.limit ?? QUERY_DEFAULT));
    const sql = q.sql.trim();
    if (!sql) throw new Error("Type a statement to run.");
    const stmt = this.#db.prepare(sql);
    // prepare() compiles the first statement and ignores the rest: say so instead of running half.
    if (stmt.sourceSQL.trim().replace(/;$/, "") !== sql.replace(/;$/, "")) throw new Error("Run one statement at a time.");
    const page = take(stmt, [], limit);
    return { columns: page.columns, rows: page.rows, total: null, truncated: page.truncated, took: Math.round(performance.now() - t0) };
  }

  handle(r: SqliteRequest): unknown {
    switch (r.op) {
      case "schema":
        return this.schema();
      case "rows":
        return this.rows(r);
      case "query":
        return this.query(r);
    }
  }
}

if (parentPort) {
  const port = parentPort;
  const reader = new SqliteReader((workerData as { path: string }).path);
  port.on("message", (r: SqliteRequest) => {
    try {
      port.postMessage({ id: r.id, result: reader.handle(r) } satisfies SqliteReply);
    } catch (e) {
      port.postMessage({ id: r.id, error: (e as Error).message } satisfies SqliteReply);
    }
  });
}
