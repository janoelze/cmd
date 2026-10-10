// The views file (docs/28 §3): every derived table lives here, under a name and
// a version. A view whose version changed is dropped and rebuilt from the
// events by its owner; nothing in this file is the only copy of anything, so
// deleting it costs a rebuild and no more.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { logger } from "@cmd/protocol/node";

const log = logger("views");

export class ViewsStore {
  readonly db: DatabaseSync;
  /** views.sqlite; null: in memory. */
  readonly file: string | null;
  #stmts = new Map<string, StatementSync>();

  /** `file`: views.sqlite; null: in memory (tests). */
  constructor(file: string | null) {
    this.file = file;
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file ?? ":memory:", { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS view_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  stmt(sql: string): StatementSync {
    let st = this.#stmts.get(sql);
    if (!st) this.#stmts.set(sql, (st = this.db.prepare(sql)));
    return st;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Makes sure a view's tables exist at `version`: a different stored version
   * drops `tables` first and returns true, so the owner rebuilds from the events.
   */
  ensure(name: string, version: number, tables: string[], create: string): { rebuilt: boolean } {
    const row = this.stmt(`SELECT version FROM view_versions WHERE name = ?`).get(name) as { version: number } | undefined;
    let rebuilt = false;
    if (row && row.version !== version) {
      log.info(`view ${name}: version ${row.version} → ${version}, rebuilding`);
      for (const t of tables) this.db.exec(`DROP TABLE IF EXISTS ${t}`);
      rebuilt = true;
    }
    this.db.exec(create);
    this.stmt(`INSERT INTO view_versions (name, version, cursor, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(name) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at, cursor = CASE WHEN version = excluded.version THEN cursor ELSE 0 END`).run(name, version, Date.now());
    return { rebuilt: rebuilt || !row };
  }

  /** How far (events.seq) an incremental view has consumed. */
  cursor(name: string): number {
    return (this.stmt(`SELECT cursor FROM view_versions WHERE name = ?`).get(name) as { cursor: number } | undefined)?.cursor ?? 0;
  }

  setCursor(name: string, seq: number): void {
    this.stmt(`UPDATE view_versions SET cursor = ?, updated_at = ? WHERE name = ?`).run(seq, Date.now(), name);
  }

  versions(): { name: string; version: number; cursor: number; updatedAt: number }[] {
    return (this.stmt(`SELECT name, version, cursor, updated_at AS updatedAt FROM view_versions ORDER BY name`).all() as { name: string; version: number; cursor: number; updatedAt: number }[]);
  }
}
