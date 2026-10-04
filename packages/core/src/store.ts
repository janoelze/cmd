// Durable state in SQLite (node:sqlite, no native module), mostly as JSON
// documents: Spaces, windows, UI state, and what restore.ts needs to bring
// terminals and agents back after a restart (pane records, their last screens,
// the live agents).

import { DatabaseSync } from "node:sqlite";
import type { Agent, AgentId, AppWindow, PaneId, Space } from "@cmd/protocol";
import type { PaneRecord } from "./panes.ts";

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
      CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY,
        root TEXT NOT NULL UNIQUE,
        doc TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS panes (
        id TEXT PRIMARY KEY,
        doc TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pane_screens (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        saved_at INTEGER NOT NULL
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

  spaces(): Space[] {
    const rows = this.#db.prepare(`SELECT doc FROM spaces`).all() as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as Space);
  }

  saveSpace(s: Space): void {
    this.#db.prepare(`INSERT OR REPLACE INTO spaces (id, root, doc) VALUES (?, ?, ?)`).run(s.id, s.root, JSON.stringify(s));
  }

  deleteSpace(id: string): void {
    this.#db.prepare(`DELETE FROM spaces WHERE id = ?`).run(id);
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

  /** Live agents; a row goes when its agent does. */
  agents(): Agent[] {
    const rows = this.#db.prepare(`SELECT doc FROM agents ORDER BY updated_at`).all() as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as Agent);
  }

  /** UI state of one window: keys ending in ".<window id>" (e.g. files.expanded.<id>). */
  deleteUiStateOf(windowId: string): void {
    const suffix = `.${windowId}`;
    this.#db.prepare(`DELETE FROM ui_state WHERE substr(key, -?) = ?`).run(suffix.length, suffix);
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

  deleteAgent(id: AgentId): void {
    this.#db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
  }

  /** Terminals that were open: running in the PTY host, or to resurrect. */
  panes(): PaneRecord[] {
    const rows = this.#db.prepare(`SELECT doc FROM panes`).all() as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as PaneRecord);
  }

  savePane(p: PaneRecord): void {
    this.#db.prepare(`INSERT OR REPLACE INTO panes (id, doc) VALUES (?, ?)`).run(p.id, JSON.stringify(p));
  }

  /** The record and its screen. */
  deletePane(id: PaneId): void {
    this.#db.prepare(`DELETE FROM panes WHERE id = ?`).run(id);
    this.#db.prepare(`DELETE FROM pane_screens WHERE id = ?`).run(id);
  }

  /** A pane's screen and scrollback, serialized for writing into a new terminal. */
  screen(id: PaneId): { data: string; savedAt: number } | null {
    const r = this.#db.prepare(`SELECT data, saved_at FROM pane_screens WHERE id = ?`).get(id) as { data: string; saved_at: number } | undefined;
    return r ? { data: r.data, savedAt: r.saved_at } : null;
  }

  saveScreen(id: PaneId, data: string): void {
    this.#db.prepare(`INSERT OR REPLACE INTO pane_screens (id, data, saved_at) VALUES (?, ?, ?)`).run(id, data, Date.now());
  }

  close(): void {
    this.#db.close();
  }
}
