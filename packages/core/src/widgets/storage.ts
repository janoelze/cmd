// Widget packages' storage (docs/56, "Storage"; API 1.3): one row per value, in the core's
// SQLite file, keyed by owner (the package; a linked one, `cmd widget link`/`dev`, apart as
// "link:<name>"), scope ("workspace" with the workspace's id, "package" with ""), kind ("kv",
// or "series" for `history`) and key, so a set writes one row. A window's own scope isn't
// here: it stays in the window's state (`state.kv`, `state.series`), where `cmd.state` has
// always kept it (api/storage.ts). Each place's schema version (the package's, each
// workspace's) is kept beside its rows, and a migration of a place holds that place's lock (one
// window at a time) until it ends. Sizes are kept
// per row and summed per scope (cached) for the quotas, which api/storage.ts checks.
// Lifecycle (library.ts): an owner's rows go on uninstall, a workspace's when it is deleted.

import { EventEmitter } from "node:events";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { WireValue } from "@cmd/protocol";

/** A shared place: this package in a workspace (id: the workspace's), or the package's own (id ""). */
export interface Place {
  owner: string;
  scope: "workspace" | "package";
  id: string;
}

export type Kind = "kv" | "series";

/** One row to write: a value, or null to delete it. */
export interface Write {
  place: Place;
  kind: Kind;
  key: string;
  value: WireValue | null;
}

/** What a set or delete changed, for live subscribers (api/topics.ts's `storage`). */
export interface StorageChange {
  owner: string;
  scope: "workspace" | "package";
  id: string;
  key: string;
}

/** The bytes a row counts against its quota: its key and its JSON. */
export const rowSize = (key: string, json: string): number => Buffer.byteLength(key) + Buffer.byteLength(json);

interface Lock {
  windowId: string;
  done: Promise<void>;
  release: () => void;
}

export class WidgetStorage extends EventEmitter<{ changed: [StorageChange] }> {
  #db: DatabaseSync;
  #stmts = new Map<string, StatementSync>();
  /** Bytes per place (owner, scope, id), summed once and kept up to date. */
  #usage = new Map<string, number>();
  #locks = new Map<string, Lock>();

  constructor(db: DatabaseSync) {
    super();
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS widget_storage (
        owner TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
        value TEXT NOT NULL, size INTEGER NOT NULL,
        PRIMARY KEY (owner, scope, scope_id, kind, key)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS widget_storage_scope ON widget_storage (scope, scope_id);
      CREATE TABLE IF NOT EXISTS widget_storage_places (owner TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (owner, scope, scope_id)) WITHOUT ROWID;
    `);
  }

  #stmt(sql: string): StatementSync {
    let st = this.#stmts.get(sql);
    if (!st) this.#stmts.set(sql, (st = this.#db.prepare(sql)));
    return st;
  }

  get(p: Place, kind: Kind, key: string): WireValue | undefined {
    const row = this.#stmt(`SELECT value FROM widget_storage WHERE owner = ? AND scope = ? AND scope_id = ? AND kind = ? AND key = ?`).get(p.owner, p.scope, p.id, kind, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as WireValue) : undefined;
  }

  /** The bytes one row counts now (0: none). */
  sizeOf(p: Place, kind: Kind, key: string): number {
    const row = this.#stmt(`SELECT size FROM widget_storage WHERE owner = ? AND scope = ? AND scope_id = ? AND kind = ? AND key = ?`).get(p.owner, p.scope, p.id, kind, key) as { size: number } | undefined;
    return row?.size ?? 0;
  }

  /** The keys of a place's values (kind "kv"), sorted, those starting with `prefix` only. */
  keys(p: Place, prefix = ""): string[] {
    const rows = this.#stmt(`SELECT key FROM widget_storage WHERE owner = ? AND scope = ? AND scope_id = ? AND kind = 'kv' AND substr(key, 1, ?) = ? ORDER BY key`).all(p.owner, p.scope, p.id, prefix.length, prefix) as { key: string }[];
    return rows.map((r) => r.key);
  }

  /** The bytes a place holds. */
  usage(p: Place): number {
    const k = placeKey(p);
    let n = this.#usage.get(k);
    if (n === undefined) {
      const row = this.#stmt(`SELECT COALESCE(SUM(size), 0) AS n FROM widget_storage WHERE owner = ? AND scope = ? AND scope_id = ?`).get(p.owner, p.scope, p.id) as { n: number };
      this.#usage.set(k, (n = Number(row.n)));
    }
    return n;
  }

  /**
   * Write rows in one transaction; subscribers hear each key after. `version`: the place's new
   * schema version (a migration's end), or with `stamp` its version only when it has none yet
   * (a place first written at that version).
   */
  write(writes: Write[], version?: { place: Place; version: number; stamp?: boolean }): void {
    if (!writes.length && !version) return;
    this.#db.exec("BEGIN");
    try {
      for (const w of writes) this.#put(w);
      if (version) this.#stmt(`INSERT OR ${version.stamp ? "IGNORE" : "REPLACE"} INTO widget_storage_places (owner, scope, scope_id, version) VALUES (?, ?, ?, ?)`).run(version.place.owner, version.place.scope, version.place.id, version.version);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      this.#usage.clear();
      throw e;
    }
    for (const w of writes) this.emit("changed", { owner: w.place.owner, scope: w.place.scope, id: w.place.id, key: w.key });
  }

  #put(w: Write): void {
    const { place: p, kind, key } = w;
    const was = this.sizeOf(p, kind, key);
    let now = 0;
    if (w.value === null) this.#stmt(`DELETE FROM widget_storage WHERE owner = ? AND scope = ? AND scope_id = ? AND kind = ? AND key = ?`).run(p.owner, p.scope, p.id, kind, key);
    else {
      const json = JSON.stringify(w.value);
      now = rowSize(key, json);
      this.#stmt(`INSERT OR REPLACE INTO widget_storage (owner, scope, scope_id, kind, key, value, size) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(p.owner, p.scope, p.id, kind, key, json, now);
    }
    const k = placeKey(p);
    const n = this.#usage.get(k);
    if (n !== undefined) this.#usage.set(k, n - was + now);
  }

  /** The schema version a place's data has, or null when none was recorded (a place from before versions, or never written). */
  version(p: Place): number | null {
    const row = this.#stmt(`SELECT version FROM widget_storage_places WHERE owner = ? AND scope = ? AND scope_id = ?`).get(p.owner, p.scope, p.id) as { version: number } | undefined;
    return row?.version ?? null;
  }

  /** Owners with anything kept (rows or a version). */
  owners(): string[] {
    const rows = this.#stmt(`SELECT owner FROM widget_storage_places UNION SELECT DISTINCT owner FROM widget_storage`).all() as { owner: string }[];
    return rows.map((r) => r.owner);
  }

  /** Workspaces with rows. */
  workspaces(): string[] {
    const rows = this.#stmt(`SELECT scope_id FROM widget_storage WHERE scope = 'workspace' UNION SELECT scope_id FROM widget_storage_places WHERE scope = 'workspace'`).all() as { scope_id: string }[];
    return rows.map((r) => r.scope_id);
  }

  /** An owner is uninstalled: every row and its version go, in one statement each. */
  purgeOwner(owner: string): void {
    this.#stmt(`DELETE FROM widget_storage WHERE owner = ?`).run(owner);
    this.#stmt(`DELETE FROM widget_storage_places WHERE owner = ?`).run(owner);
    this.#usage.clear();
  }

  /** A workspace is deleted: every package's data in it goes. */
  purgeWorkspace(id: string): void {
    this.#stmt(`DELETE FROM widget_storage WHERE scope = 'workspace' AND scope_id = ?`).run(id);
    this.#stmt(`DELETE FROM widget_storage_places WHERE scope = 'workspace' AND scope_id = ?`).run(id);
    this.#usage.clear();
  }

  // ── migrations: a lock per place (placeKey) ──

  /** Hold `key` for `windowId`, once no other window holds it (at once when it holds it already). */
  async lock(key: string, windowId: string): Promise<void> {
    for (;;) {
      const held = this.#locks.get(key);
      if (!held) break;
      if (held.windowId === windowId) return;
      await held.done;
    }
    let release = () => {};
    const done = new Promise<void>((r) => (release = r));
    this.#locks.set(key, { windowId, done, release });
  }

  /** The window holding `key`, if one does. */
  locked(key: string): string | null {
    return this.#locks.get(key)?.windowId ?? null;
  }

  /** Resolves once no other window than `windowId` holds `key`. */
  async settled(key: string, windowId: string): Promise<void> {
    for (let held = this.#locks.get(key); held && held.windowId !== windowId; held = this.#locks.get(key)) await held.done;
  }

  /** `windowId` lets go of `key`: the next window may look. */
  unlock(key: string, windowId: string): void {
    const held = this.#locks.get(key);
    if (!held || held.windowId !== windowId) return;
    this.#locks.delete(key);
    held.release();
  }
}

/** A place's lock and cache key. */
export const placeKey = (p: Place) => `${p.owner}\n${p.scope}\n${p.id}`;
