// Durable state in SQLite (node:sqlite, no native module).
// Agents are stored as JSON documents for now; restore/search tables come later.

import { DatabaseSync } from "node:sqlite";
import type { Agent, AppWindow } from "@cmd/protocol";

export class Store {
  #db: DatabaseSync;

  constructor(file: string) {
    this.#db = new DatabaseSync(file);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        root_id TEXT NOT NULL,
        doc TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agents_parent ON agents(parent_id);
      CREATE TABLE IF NOT EXISTS windows (
        id TEXT PRIMARY KEY,
        doc TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ui_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /** Non-terminal windows (browser, files). */
  windows(): AppWindow[] {
    const rows = this.#db.prepare(`SELECT doc FROM windows`).all() as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as AppWindow);
  }

  saveWindow(w: AppWindow): void {
    this.#db.prepare(`INSERT OR REPLACE INTO windows (id, doc) VALUES (?, ?)`).run(w.id, JSON.stringify(w));
  }

  deleteWindow(id: string): void {
    this.#db.prepare(`DELETE FROM windows WHERE id = ?`).run(id);
  }

  /** UI state (view mode, selection, collapsed rows, …) as JSON values. */
  uiState(): Record<string, unknown> {
    const rows = this.#db.prepare(`SELECT key, value FROM ui_state`).all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  }

  /** undefined/null deletes the key. */
  setUiState(key: string, value: unknown): void {
    if (value === undefined || value === null) {
      this.#db.prepare(`DELETE FROM ui_state WHERE key = ?`).run(key);
      return;
    }
    this.#db
      .prepare(
        `INSERT INTO ui_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  saveAgent(a: Agent): void {
    this.#db
      .prepare(
        `INSERT INTO agents (id, parent_id, root_id, doc, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, root_id = excluded.root_id,
           doc = excluded.doc, updated_at = excluded.updated_at`,
      )
      .run(a.id, a.parentId, a.rootId, JSON.stringify(a), Date.now());
  }

  recentAgents(sinceMs: number): Agent[] {
    const rows = this.#db
      .prepare(`SELECT doc FROM agents WHERE updated_at >= ? ORDER BY updated_at DESC`)
      .all(sinceMs) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as Agent);
  }

  close(): void {
    this.#db.close();
  }
}
