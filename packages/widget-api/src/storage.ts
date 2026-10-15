// `cmd.storage` (API 1.3, docs/56 "Storage"): JSON values kept by cmd under keys, in three
// scopes. `window` is this window's (what `cmd.state` has always kept: the same data);
// `workspace` this package's in the window's workspace, shared by its windows there; `package`
// this package's everywhere. cmd decides which window, workspace and package a call reaches:
// a widget names only the scope, so it never sees another package's data or another window's.
// The migration a widget registers (`cmd.storage.migrate`) runs once per new
// `cmd.storage.version` in package.json, in the first window that starts, before any window
// reads storage (runMigration, called by the runtime when `ready` says one is due).

import type { ApiMethods, ApiStorageMigrate, ApiStorageScope, WireValue } from "@cmd/protocol/widget-tree";
import { connection, type Connection } from "./connection.ts";

/** Where a value lives: `"window"`, `"workspace"` or `"package"` (see `cmd.storage`). @since 1.3 */
export type StorageScope = ApiStorageScope;

/**
 * One scope of storage: `cmd.storage.window`, `.workspace` or `.package`. Values are JSON (at most
 * 1 MB each), keys strings of 1 to 200 characters. A set that would go over the scope's quota
 * (a window 256 KB, a workspace 10 MB, the package 10 MB) rejects, saying which is full.
 * @since 1.3
 */
export interface Store {
  /** The value under `key`, or null. @since 1.3 */
  get<T extends WireValue = WireValue>(key: string): Promise<T | null>;
  /** Keeps `value` under `key`; null or undefined deletes it. @since 1.3 */
  set(key: string, value: WireValue | null | undefined): Promise<void>;
  /** Deletes the value under `key`. @since 1.3 */
  delete(key: string): Promise<void>;
  /** The keys with a value, sorted; only those starting with `prefix` when given (`"note:"`). @since 1.3 */
  keys(prefix?: string): Promise<string[]>;
  /** Appends a number to a series kept under `key` (no number: just reads it) and returns its last `max` (default 60, at most 1000) values: a sparkline's history. @since 1.3 */
  history(key: string, value?: number | null, max?: number): Promise<number[]>;
}

/** A migration: reshape what `from` stored into what `to` reads, with `cmd.storage`. @since 1.3 */
export type Migration = (from: number, to: number) => void | Promise<void>;

let registered: Migration | null = null;

/** Registers the migration (the last one registered wins). @since 1.3 */
export function registerMigration(fn: Migration): void {
  if (typeof fn !== "function") throw new TypeError("cmd.storage.migrate: give it a function (from, to) => …");
  registered = fn;
}

const call = <V extends keyof ApiMethods & `storage.${string}`>(verb: V, args: ApiMethods[V]["params"]) => connection().call(verb, args) as Promise<ApiMethods[V]["result"]>;

/** A scope's Store. */
export function store(scope: ApiStorageScope): Store {
  return {
    get: <T extends WireValue = WireValue>(key: string) => call("storage.get", [scope, key]) as Promise<T | null>,
    async set(key, value) {
      if (scope === "window") connection().setState(key, value ?? null);
      await call("storage.set", [scope, key, value ?? null]);
    },
    async delete(key) {
      if (scope === "window") connection().setState(key, null);
      await call("storage.delete", [scope, key]);
    },
    keys: (prefix) => call("storage.keys", prefix === undefined ? [scope] : [scope, prefix]),
    history: (key, value, max) => call("storage.history", max === undefined ? [scope, key, value ?? null] : [scope, key, value ?? null, max]),
  };
}

/** The words a failed migration shows in the window (the core also stops the window, saying so). */
export const migrationFailed = (message: string): string => `Couldn't update this widget's stored data: ${message.replace(/([^.!?])$/, "$1.")} Its data is as it was.`;

/** The migration `ready` asked for runs here, then the core hears how it went (`migrated`). Returns the error, or null. */
export async function runMigration(conn: Connection, m: ApiStorageMigrate): Promise<string | null> {
  try {
    await registered?.(m.from, m.to);
    conn.send({ kind: "migrated", ok: true });
    return null;
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500) || "the migration failed.";
    conn.send({ kind: "migrated", ok: false, message });
    return message;
  }
}
