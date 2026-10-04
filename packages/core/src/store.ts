// Durable state in SQLite (node:sqlite, no native module), mostly as JSON
// documents: Spaces, windows, UI state, and what restore.ts needs to bring
// terminals and agents back after a restart (pane records, their last screens,
// the live agents).

import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Agent, AgentId, AppWindow, PaneId, RemoteScope, Space } from "@cmd/protocol";
import type { PaneRecord } from "./panes.ts";

export interface RemoteDeviceRecord {
  id: string;
  name: string;
  scope: RemoteScope;
  /** X25519, base64url. */
  publicKey: string;
  pairedAt: number;
  lastSeenAt: number;
}

export class Store {
  #db: DatabaseSync;
  #stmts = new Map<string, StatementSync>();

  constructor(file: string) {
    // Wait out a short lock (another process on the file) rather than throw.
    this.#db = new DatabaseSync(file, { timeout: 2000 });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
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
      CREATE TABLE IF NOT EXISTS remote_devices (
        id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL UNIQUE,
        doc TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS remote_log (
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        device_id TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS remote_log_at ON remote_log(at);
    `);
  }

  /** Prepared once, reused: most writes are small and frequent. */
  #stmt(sql: string): StatementSync {
    let st = this.#stmts.get(sql);
    if (!st) this.#stmts.set(sql, (st = this.#db.prepare(sql)));
    return st;
  }

  /** Run `fn`'s writes as one transaction (one commit). */
  transaction(fn: () => void): void {
    this.#db.exec("BEGIN");
    try {
      fn();
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Non-terminal windows (browser, files). */
  windows(): AppWindow[] {
    const rows = this.#stmt(`SELECT doc FROM windows`).all() as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as AppWindow);
  }

  saveWindow(w: AppWindow): void {
    this.#stmt(`INSERT OR REPLACE INTO windows (id, doc) VALUES (?, ?)`).run(w.id, JSON.stringify(w));
  }

  deleteWindow(id: string): void {
    this.#stmt(`DELETE FROM windows WHERE id = ?`).run(id);
  }

  spaces(): Space[] {
    const rows = this.#stmt(`SELECT doc FROM spaces`).all() as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as Space);
  }

  saveSpace(s: Space): void {
    this.#stmt(`INSERT OR REPLACE INTO spaces (id, root, doc) VALUES (?, ?, ?)`).run(s.id, s.root, JSON.stringify(s));
  }

  deleteSpace(id: string): void {
    this.#stmt(`DELETE FROM spaces WHERE id = ?`).run(id);
  }

  /** UI state (view mode, selection, collapsed rows, …) as JSON values. */
  uiState(): Record<string, unknown> {
    const rows = this.#stmt(`SELECT key, value FROM ui_state`).all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  }

  /** undefined/null deletes the key. */
  setUiState(key: string, value: unknown): void {
    if (value === undefined || value === null) {
      this.#stmt(`DELETE FROM ui_state WHERE key = ?`).run(key);
      return;
    }
    this.#stmt(
        `INSERT INTO ui_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  /** Live agents; a row goes when its agent does. */
  agents(): Agent[] {
    const rows = this.#stmt(`SELECT doc FROM agents ORDER BY updated_at`).all() as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as Agent);
  }

  /** UI state of one window: keys ending in ".<window id>" (e.g. files.expanded.<id>). */
  deleteUiStateOf(windowId: string): void {
    const suffix = `.${windowId}`;
    this.#stmt(`DELETE FROM ui_state WHERE substr(key, -?) = ?`).run(suffix.length, suffix);
  }

  saveAgent(a: Agent): void {
    this.#stmt(
        `INSERT INTO agents (id, parent_id, root_id, doc, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, root_id = excluded.root_id,
           doc = excluded.doc, updated_at = excluded.updated_at`,
      )
      .run(a.id, a.parentId, a.rootId, JSON.stringify(a), Date.now());
  }

  deleteAgent(id: AgentId): void {
    this.#stmt(`DELETE FROM agents WHERE id = ?`).run(id);
  }

  /** Terminals that were open: running in the PTY host, or to resurrect. */
  panes(): PaneRecord[] {
    const rows = this.#stmt(`SELECT doc FROM panes`).all() as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as PaneRecord);
  }

  savePane(p: PaneRecord): void {
    this.#stmt(`INSERT OR REPLACE INTO panes (id, doc) VALUES (?, ?)`).run(p.id, JSON.stringify(p));
  }

  /** The record and its screen. */
  deletePane(id: PaneId): void {
    this.#stmt(`DELETE FROM panes WHERE id = ?`).run(id);
    this.#stmt(`DELETE FROM pane_screens WHERE id = ?`).run(id);
  }

  /** A pane's screen and scrollback, serialized for writing into a new terminal. */
  screen(id: PaneId): { data: string; savedAt: number } | null {
    const r = this.#stmt(`SELECT data, saved_at FROM pane_screens WHERE id = ?`).get(id) as { data: string; saved_at: number } | undefined;
    return r ? { data: r.data, savedAt: r.saved_at } : null;
  }

  saveScreen(id: PaneId, data: string): void {
    this.#stmt(`INSERT OR REPLACE INTO pane_screens (id, data, saved_at) VALUES (?, ?, ?)`).run(id, data, Date.now());
  }

  /** Paired remote devices (remote/service.ts); public keys are base64url. */
  remoteDevices(): RemoteDeviceRecord[] {
    const rows = this.#stmt(`SELECT doc FROM remote_devices`).all() as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as RemoteDeviceRecord);
  }

  saveRemoteDevice(d: RemoteDeviceRecord): void {
    this.#stmt(`INSERT OR REPLACE INTO remote_devices (id, public_key, doc) VALUES (?, ?, ?)`).run(d.id, d.publicKey, JSON.stringify(d));
  }

  deleteRemoteDevice(id: string): void {
    this.#stmt(`DELETE FROM remote_devices WHERE id = ?`).run(id);
  }

  /** The remote access audit log: sessions, pairings, revocations, denied calls, failed handshakes. */
  logRemote(kind: string, deviceId: string | null, detail: string | null, keepMs = 30 * 86400_000): void {
    const now = Date.now();
    this.#stmt(`INSERT INTO remote_log (at, kind, device_id, detail) VALUES (?, ?, ?, ?)`).run(now, kind, deviceId, detail);
    this.#stmt(`DELETE FROM remote_log WHERE at < ?`).run(now - keepMs);
  }

  remoteLog(limit = 100): { at: number; kind: string; deviceId: string | null; detail: string | null }[] {
    const rows = this.#stmt(`SELECT at, kind, device_id, detail FROM remote_log ORDER BY at DESC, rowid DESC LIMIT ?`).all(limit) as { at: number; kind: string; device_id: string | null; detail: string | null }[];
    return rows.map((r) => ({ at: r.at, kind: r.kind, deviceId: r.device_id, detail: r.detail }));
  }

  close(): void {
    this.#db.close();
  }
}
