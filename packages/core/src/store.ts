// Durable state in SQLite (node:sqlite, no native module), mostly as JSON
// documents: workspaces, windows, UI state, and what restore.ts needs to bring
// terminals and agents back after a restart (pane records, their last screens,
// the live agents). The file also records where it lives, so a copy of it (a
// test core on a copy of the real state) knows those terminals aren't its own.

import fs from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Agent, AgentId, AppWindow, PaneId, RemoteScope, Workspace } from "@cmd/protocol";
import type { PaneRecord } from "./panes.ts";
import { decodeAgent, decodeDoc, decodePane, decodeRemoteDevice, decodeRows, decodeWorkspace, decodeWindow } from "./stored.ts";

export interface RemoteDeviceRecord {
  id: string;
  name: string;
  scope: RemoteScope;
  /** X25519, base64url. */
  publicKey: string;
  pairedAt: number;
  lastSeenAt: number;
}

/**
 * The file's schema, in meta('schema'): 2 since workspaces (0.24). Files from
 * before have none: 1 when they still have `spaces`, else 2. A file newer than
 * this is refused (StoreTooNew), not opened: this cmd would start over on
 * tables it doesn't know, and the newer one would find its own state gone.
 */
export const STORE_SCHEMA = 2;

/** A cmd.sqlite written by a newer cmd than this one: not opened, not written to. */
export class StoreTooNew extends Error {
  override name = "StoreTooNew";
  readonly file: string;
  readonly schema: number;
  readonly supported: number;
  constructor(file: string, schema: number, supported: number) {
    super(`${file} is from a newer cmd (state schema ${schema}, this cmd knows ${supported}): update cmd to open it`);
    this.file = file;
    this.schema = schema;
    this.supported = supported;
  }
}

/** The schema meta('schema') records, or null without one (a file from before it was recorded, or new). */
function recordedSchema(db: DatabaseSync): number | null {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).get()) return null;
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value: string } | undefined;
  return row ? Number(row.value) || null : null;
}

/** Throws StoreTooNew for a file from a newer cmd; reads only (a missing file stays missing). */
export function checkStoreSchema(file: string): void {
  if (!fs.existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true, timeout: 2000 });
  try {
    const schema = recordedSchema(db);
    if (schema !== null && schema > STORE_SCHEMA) throw new StoreTooNew(file, schema, STORE_SCHEMA);
  } finally {
    db.close();
  }
}

export class Store {
  #db: DatabaseSync;
  #stmts = new Map<string, StatementSync>();
  /** This file's real path; null in memory. */
  #path: string | null;

  constructor(file: string) {
    // Wait out a short lock (another process on the file) rather than throw.
    this.#db = new DatabaseSync(file, { timeout: 2000 });
    const schema = recordedSchema(this.#db);
    if (schema !== null && schema > STORE_SCHEMA) {
      this.#db.close();
      throw new StoreTooNew(file, schema, STORE_SCHEMA);
    }
    this.#renameSpaces();
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
      CREATE TABLE IF NOT EXISTS workspaces (
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
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.#stmt(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)`).run(String(STORE_SCHEMA));
    this.#path = file === ":memory:" ? null : fs.realpathSync(file);
  }

  /** Before 0.24 workspaces were Spaces: their table, and `spaceId` in every window, pane and agent. */
  #renameSpaces(): void {
    const has = (t: string) => !!this.#db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
    if (!has("spaces")) return;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (!has("spaces") || has("workspaces")) return void this.#db.exec("ROLLBACK");
      this.#db.exec(`ALTER TABLE spaces RENAME TO workspaces`);
      for (const t of ["windows", "panes", "agents"]) if (has(t)) this.#db.exec(`UPDATE ${t} SET doc = replace(doc, '"spaceId":', '"workspaceId":')`);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Where this file lived before, when it was copied or moved here; null when it
   * is where it was (or new). Records the current place: the second call is null.
   * Restore asks once, before it resurrects anything (restore.ts).
   */
  claim(): string | null {
    if (!this.#path) return null;
    const row = this.#stmt(`SELECT value FROM meta WHERE key = 'path'`).get() as { value: string } | undefined;
    if (row?.value === this.#path) return null;
    this.#stmt(`INSERT OR REPLACE INTO meta (key, value) VALUES ('path', ?)`).run(this.#path);
    return row?.value ?? null;
  }

  /** For services that keep their own tables in the same file (activity log, agent homes). */
  get db(): DatabaseSync {
    return this.#db;
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
    return decodeRows("window", rows.map((r) => r.doc), decodeWindow);
  }

  saveWindow(w: AppWindow): void {
    this.#stmt(`INSERT OR REPLACE INTO windows (id, doc) VALUES (?, ?)`).run(w.id, JSON.stringify(w));
  }

  deleteWindow(id: string): void {
    this.#stmt(`DELETE FROM windows WHERE id = ?`).run(id);
  }

  workspaces(): Workspace[] {
    const rows = this.#stmt(`SELECT doc FROM workspaces`).all() as { doc: string }[];
    return decodeRows("Workspace", rows.map((r) => r.doc), decodeWorkspace);
  }

  saveWorkspace(s: Workspace): void {
    this.#stmt(`INSERT OR REPLACE INTO workspaces (id, root, doc) VALUES (?, ?, ?)`).run(s.id, s.root, JSON.stringify(s));
  }

  deleteWorkspace(id: string): void {
    this.#stmt(`DELETE FROM workspaces WHERE id = ?`).run(id);
  }

  /** UI state (view mode, selection, collapsed rows, …) as JSON values. */
  uiState(): Record<string, unknown> {
    const rows = this.#stmt(`SELECT key, value FROM ui_state`).all() as { key: string; value: string }[];
    return Object.fromEntries(rows.flatMap((r) => {
      const v = decodeDoc(`UI state value (${r.key})`, r.value, (x) => x);
      return v === null ? [] : [[r.key, v]];
    }));
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
    return decodeRows("agent", rows.map((r) => r.doc), decodeAgent);
  }

  /** UI state of one window: keys ending in ".<window id>" (e.g. files.expanded.<id>). */
  deleteUiStateOf(windowId: string): void {
    const suffix = `.${windowId}`;
    this.#stmt(`DELETE FROM ui_state WHERE substr(key, -?) = ?`).run(suffix.length, suffix);
  }

  /**
   * An agent's identity and current state, for restoring it. Not its turn: the
   * turns view (data/views/activity.ts) has that, and restore takes it from there.
   */
  saveAgent(a: Agent): void {
    const { turn: _turn, ...doc } = a;
    this.#stmt(
        `INSERT INTO agents (id, parent_id, root_id, doc, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, root_id = excluded.root_id,
           doc = excluded.doc, updated_at = excluded.updated_at`,
      )
      .run(a.id, a.parentId, a.rootId, JSON.stringify(doc), Date.now());
  }

  deleteAgent(id: AgentId): void {
    this.#stmt(`DELETE FROM agents WHERE id = ?`).run(id);
  }

  /** Terminals that were open: running in the PTY host, or to resurrect. */
  panes(): PaneRecord[] {
    const rows = this.#stmt(`SELECT doc FROM panes`).all() as { doc: string }[];
    return decodeRows("pane record", rows.map((r) => r.doc), decodePane);
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
    return decodeRows("paired device", rows.map((r) => r.doc), decodeRemoteDevice);
  }

  saveRemoteDevice(d: RemoteDeviceRecord): void {
    this.#stmt(`INSERT OR REPLACE INTO remote_devices (id, public_key, doc) VALUES (?, ?, ?)`).run(d.id, d.publicKey, JSON.stringify(d));
  }

  deleteRemoteDevice(id: string): void {
    this.#stmt(`DELETE FROM remote_devices WHERE id = ?`).run(id);
  }

  close(): void {
    this.#db.close();
  }
}
