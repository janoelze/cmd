// A window's storage verbs (API 1.3, docs/56 "Storage"): `storage.*` in the scope a call names,
// and 1.0's `state.*`, which are the window scope under their old names. Which window,
// workspace and package a call is about is this window's, as the core knows it (its id, the
// workspace it is in now, its package): a call names only the scope. The window scope stays in
// the window's state (`state.kv`, `state.series`), where every widget before 1.3 kept it, so
// it needs no migration and goes with the window; the shared scopes are rows of
// widgets/storage.ts. Quotas (limits.ts) are checked at each set. While a migration runs, the
// window running it writes to a staging area that is kept, with the new version, only when the
// migration ends well, and every other window's storage call waits for it to end.

import { API_STORAGE_SCOPES, type ApiMethods, type ApiStorageMigrate, type ApiStorageQuery, type ApiStorageScope, type AppWindow, type WireValue } from "@cmd/protocol";
import type { CoreContext } from "../../kernel/context.ts";
import { SERIES_MAX, STORAGE_LIMITS } from "../limits.ts";
import { rowSize, type Kind, type Place, type WidgetStorage, type Write } from "../storage.ts";
import { failed, invalid } from "./access.ts";

export interface StorageScope {
  windowId: string;
  /** The window's workspace now. */
  own(): string;
  /** Whose rows these are (library.ts storageOwner: the package, or "link:<name>" for a linked one). */
  owner: string;
  /** package.json's `cmd.storage.version`. */
  declared: number;
  storage: WidgetStorage;
}

/** The storage verbs and the window scope's `state.*`, as the adapter serves them. */
export type StorageVerbs = { [V in Extract<keyof ApiMethods, `storage.${string}` | `state.${string}`>]: (...p: ApiMethods[V]["params"]) => Promise<ApiMethods[V]["result"]> };

export interface WindowStorage {
  verbs: StorageVerbs;
  /** The live `storage` topic's read: one key of one scope. */
  read(q: ApiStorageQuery): Promise<WireValue>;
  /** At the start of the window's process: the migration it runs now (holding the package's lock), or null when its data is current. */
  migrateStart(): Promise<ApiStorageMigrate | null>;
  /** The migration ended: kept with the new version (ok), or dropped. The error when keeping it failed. */
  migrateEnd(ok: boolean): string | null;
  dispose(): void;
}

/** A value, or a delete (null), staged by a migration. */
type Staged = { scope: ApiStorageScope; kind: Kind; key: string; value: WireValue | null };

const SHARED_FULL = { workspace: "This widget's storage in this workspace is full (10 MB). Delete something first.", package: "This widget's storage is full (10 MB). Delete something first." } as const;
/** The documented refusals (docs/56, "Storage"). */
export const STORAGE_ERRORS = {
  window: "This window's storage is full (256 KB). Delete something first.",
  ...SHARED_FULL,
  value: "That value is too big to keep: 1 MB at most.",
} as const;

export function windowStorage(core: Pick<CoreContext, "windows">, s: StorageScope): WindowStorage {
  const { storage, owner } = s;
  /** This window's migration's writes while it runs. */
  let staged: Map<string, Staged> | null = null;
  let migrating: ApiStorageMigrate | null = null;
  let disposed = false;

  const win = (): AppWindow => {
    const w = core.windows.others().find((x) => x.id === s.windowId);
    if (!w) throw failed("This widget's window is gone.");
    return w;
  };
  const scopeOf = (verb: string, scope: unknown): ApiStorageScope => {
    if (!(API_STORAGE_SCOPES as readonly unknown[]).includes(scope)) throw invalid(`${verb}: name the scope: "window", "workspace" or "package"`);
    return scope as ApiStorageScope;
  };
  const keyOf = (verb: string, key: unknown): string => {
    if (typeof key !== "string" || !key || key.length > STORAGE_LIMITS.key) throw invalid(`${verb}: the key should be a string of 1 to ${STORAGE_LIMITS.key} characters`);
    return key;
  };
  const place = (scope: "workspace" | "package"): Place => ({ owner, scope, id: scope === "workspace" ? s.own() : "" });
  const sk = (scope: ApiStorageScope, kind: Kind, key: string) => `${scope}\n${kind}\n${key}`;
  /** Another window's migration of this package ends before this window reads or writes. */
  const ready = async () => {
    if (!staged) await storage.settled(owner);
  };

  // ── the window scope: its state ──
  const kvOf = (w = win()) => ({ ...((w.state.kv as Record<string, WireValue> | undefined) ?? {}) });
  const seriesOf = (w = win()) => ({ ...((w.state.series as Record<string, number[]> | undefined) ?? {}) });

  // ── reads, through a migration's staging ──
  const base = (scope: ApiStorageScope, kind: Kind, key: string): WireValue | undefined => {
    if (scope === "window") return kind === "kv" ? kvOf()[key] : seriesOf()[key];
    return storage.get(place(scope), kind, key);
  };
  const get = (scope: ApiStorageScope, kind: Kind, key: string): WireValue | undefined => {
    const st = staged?.get(sk(scope, kind, key));
    if (st) return st.value ?? undefined;
    return base(scope, kind, key);
  };
  const keys = (scope: ApiStorageScope, prefix: string): string[] => {
    const all = new Set(scope === "window" ? Object.keys(kvOf()).filter((k) => k.startsWith(prefix)) : storage.keys(place(scope), prefix));
    for (const st of staged?.values() ?? []) {
      if (st.scope !== scope || st.kind !== "kv" || !st.key.startsWith(prefix)) continue;
      if (st.value === null) all.delete(st.key);
      else all.add(st.key);
    }
    return [...all].sort();
  };

  // ── writes: checked, then staged or kept ──
  const put = (scope: ApiStorageScope, kind: Kind, key: string, value: WireValue | null) => {
    const json = value === null ? null : JSON.stringify(value);
    if (json !== null && Buffer.byteLength(json) > STORAGE_LIMITS.value) throw failed(STORAGE_ERRORS.value);
    if (scope === "window") {
      if (kind === "kv" && json !== null) {
        // As cmd.state always counted it: the JSON of every value of the window.
        const next = { ...kvOf(), ...windowStaged("kv"), [key]: value };
        for (const [k, v] of Object.entries(next)) if (v === null) delete next[k];
        if (JSON.stringify(next).length > STORAGE_LIMITS.window) throw failed(STORAGE_ERRORS.window);
      }
    } else {
      const p = place(scope);
      const size = json === null ? 0 : rowSize(key, json);
      if (json !== null && sharedUsage(scope, p) - sizeNow(scope, p, kind, key) + size > STORAGE_LIMITS[scope]) throw failed(SHARED_FULL[scope]);
    }
    if (staged) return void staged.set(sk(scope, kind, key), { scope, kind, key, value });
    if (scope === "window") {
      const w = win();
      if (kind === "kv") {
        const next = kvOf(w);
        if (value === null) delete next[key];
        else next[key] = value;
        core.windows.update(s.windowId, { state: { kv: next } });
      } else core.windows.update(s.windowId, { state: { series: { ...seriesOf(w), [key]: value as number[] } } });
    } else storage.write([{ place: place(scope), kind, key, value }]);
  };
  const windowStaged = (kind: Kind): Record<string, WireValue | null> => Object.fromEntries([...(staged?.values() ?? [])].filter((x) => x.scope === "window" && x.kind === kind).map((x) => [x.key, x.value]));
  const sizeNow = (scope: "workspace" | "package", p: Place, kind: Kind, key: string): number => {
    const st = staged?.get(sk(scope, kind, key));
    return st ? (st.value === null ? 0 : rowSize(key, JSON.stringify(st.value))) : storage.sizeOf(p, kind, key);
  };
  const sharedUsage = (scope: "workspace" | "package", p: Place): number => {
    let n = storage.usage(p);
    for (const st of staged?.values() ?? []) if (st.scope === scope) n += (st.value === null ? 0 : rowSize(st.key, JSON.stringify(st.value))) - storage.sizeOf(p, st.kind, st.key);
    return n;
  };

  /** A number appended to a series, its last `max` back: cmd.state.history's semantics in every scope. */
  const history = (scope: ApiStorageScope, key: string, value: unknown, max: unknown): number[] => {
    const keep = Math.max(1, Math.min(Math.floor(Number(max) || 60), SERIES_MAX));
    const was = get(scope, "series", key);
    const list = Array.isArray(was) ? (was as number[]).slice() : [];
    if (typeof value === "number" && Number.isFinite(value)) {
      list.push(value);
      put(scope, "series", key, list.slice(-SERIES_MAX));
    }
    return list.slice(-keep);
  };

  const verbs: StorageVerbs = {
    "storage.get": async (scope, key) => {
      const sc = scopeOf("storage.get", scope);
      const k = keyOf("storage.get", key);
      await ready();
      return get(sc, "kv", k) ?? null;
    },
    "storage.set": async (scope, key, value) => {
      const sc = scopeOf("storage.set", scope);
      const k = keyOf("storage.set", key);
      await ready();
      put(sc, "kv", k, value ?? null);
      return null;
    },
    "storage.delete": async (scope, key) => {
      const sc = scopeOf("storage.delete", scope);
      const k = keyOf("storage.delete", key);
      await ready();
      put(sc, "kv", k, null);
      return null;
    },
    "storage.keys": async (scope, prefix) => {
      const sc = scopeOf("storage.keys", scope);
      if (prefix !== undefined && prefix !== null && typeof prefix !== "string") throw invalid("storage.keys: the prefix should be a string");
      await ready();
      return keys(sc, prefix ?? "");
    },
    "storage.history": async (scope, key, value, max) => {
      const sc = scopeOf("storage.history", scope);
      const k = keyOf("storage.history", key);
      await ready();
      return history(sc, k, value, max);
    },
    // 1.0: the window scope, as it always was.
    "state.get": async (key) => {
      await ready();
      return get("window", "kv", String(key)) ?? null;
    },
    "state.set": async (key, value) => {
      const k = keyOf("state.set", key);
      await ready();
      put("window", "kv", k, value ?? null);
      return null;
    },
    "state.history": async (key, value, max) => {
      const k = keyOf("state.history", key);
      await ready();
      return history("window", k, value, max);
    },
  };

  return {
    verbs,
    read: (q) => verbs["storage.get"](q?.scope, q?.key),
    async migrateStart() {
      const m = await storage.lock(owner, s.declared, s.windowId);
      if (m && disposed) storage.unlock(owner, s.windowId);
      if (!m || disposed) return null;
      staged = new Map();
      migrating = m;
      return m;
    },
    migrateEnd(ok) {
      const writes = staged;
      const m = migrating;
      staged = null;
      migrating = null;
      if (!writes || !m) return null;
      try {
        if (!ok) return null;
        const rows: Write[] = [];
        const kv: Record<string, WireValue | null> = {};
        const series: Record<string, WireValue | null> = {};
        for (const w of writes.values()) {
          if (w.scope !== "window") rows.push({ place: place(w.scope), kind: w.kind, key: w.key, value: w.value });
          else (w.kind === "kv" ? kv : series)[w.key] = w.value;
        }
        storage.write(rows, { owner, version: m.to });
        if (Object.keys(kv).length || Object.keys(series).length) {
          const nextKv = { ...kvOf(), ...kv };
          const nextSeries = { ...seriesOf(), ...series };
          for (const o of [nextKv, nextSeries]) for (const [k, v] of Object.entries(o)) if (v === null) delete o[k];
          core.windows.update(s.windowId, { state: { kv: nextKv, series: nextSeries } });
        }
        return null;
      } catch (e) {
        return (e as Error).message;
      } finally {
        storage.unlock(owner, s.windowId);
      }
    },
    dispose() {
      disposed = true;
      if (staged) {
        staged = null;
        migrating = null;
        storage.unlock(owner, s.windowId);
      }
    },
  };
}
