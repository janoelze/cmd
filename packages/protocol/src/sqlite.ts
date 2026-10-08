// The SQLite window (docs/36-sqlite-viewer.md): what the core reads out of a
// database file for it. Everything is read-only; the core opens the file that
// way and never writes to it.

/**
 * A cell as SQLite holds it: a number (REAL, or an INTEGER that fits), text,
 * NULL, a BLOB as its size, or text cut for transport with its full length.
 */
export type SqliteValue = number | string | null | { blob: number } | { text: string; chars: number };

export interface SqliteColumn {
  name: string;
  /** The declared type, as written ("INTEGER", "varchar(80)"); empty when none. */
  type: string;
  notNull: boolean;
  /** 1-based position in the primary key; 0 when not part of it. */
  pk: number;
  /** The default, as written in the schema. */
  default: string | null;
}

export interface SqliteForeignKey {
  /** Column of this table. */
  from: string;
  table: string;
  /** Column of `table`; null means its primary key. */
  to: string | null;
}

export interface SqliteIndex {
  name: string;
  table: string;
  unique: boolean;
  columns: string[];
  /** null for an index SQLite made itself (a PRIMARY KEY or UNIQUE constraint). */
  sql: string | null;
}

export interface SqliteTable {
  name: string;
  kind: "table" | "view";
  /** The CREATE statement; null for sqlite's own tables. */
  sql: string | null;
  /** Rows now; null for views (counting one can mean running it in full). */
  rows: number | null;
  columns: SqliteColumn[];
  foreignKeys: SqliteForeignKey[];
}

export interface SqliteTrigger {
  name: string;
  table: string;
  sql: string | null;
}

export interface SqliteSchema {
  /** Bytes on disk, the main file. */
  size: number;
  pageSize: number;
  pageCount: number;
  encoding: string;
  userVersion: number;
  /** Write-ahead log in use. */
  wal: boolean;
  tables: SqliteTable[];
  views: SqliteTable[];
  indexes: SqliteIndex[];
  triggers: SqliteTrigger[];
}

/** Rows of a table or a query. */
export interface SqliteResult {
  columns: string[];
  rows: SqliteValue[][];
  /** Rows the table (with the filter) has in all; null for a query. */
  total: number | null;
  /** The query had more rows than `rows` holds. */
  truncated: boolean;
  /** Milliseconds. */
  took: number;
}

export interface SqliteRowsQuery {
  path: string;
  table: string;
  sort?: { column: string; desc: boolean };
  /** Text to find in any column (case-insensitive, as text). */
  filter?: string;
  offset?: number;
  /** Default 200, at most 1000. */
  limit?: number;
}

export interface SqliteQuery {
  path: string;
  /** One read-only statement. */
  sql: string;
  /** Default 500, at most 5000. */
  limit?: number;
}
