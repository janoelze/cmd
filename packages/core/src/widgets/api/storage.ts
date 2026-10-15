// A window's storage verbs (API 1.3, docs/56 "Storage"): `storage.*` in the scope a call names,
// and 1.0's `state.*`, which are the window scope under their old names. Which window,
// workspace and package a call is about is this window's, as the core knows it (its id, the
// workspace it is in now, its package): a call names only the scope. The window scope stays in
// the window's state (`state.kv`, `state.series`), where every widget before 1.3 kept it, so
// it needs no migration and goes with the window; the shared scopes are rows of
// widgets/storage.ts. Quotas (limits.ts) are checked at each set.
// Each place has its own schema version: the package's and each workspace's in
// widgets/storage.ts, the window's in its state (`state.storageVersion`); none recorded is 1 for
// a place with data, and a place without data is simply at package.json's version. When the
// window's process starts, each of its places that is behind is migrated, in order package,
// workspace, window: a shared place under its lock (other windows' calls there wait), its
// writes staged and kept with the new version only when that step ends well. A place behind
// that this window isn't migrating (a window moved to another workspace) refuses until the
// window starts again (host.ts restarts it).

import { API_STORAGE_SCOPES, type ApiMethods, type ApiStorageMigrate, type ApiStorageQuery, type ApiStorageScope, type AppWindow, type WireValue } from "@cmd/protocol";
import type { CoreContext } from "../../kernel/context.ts";
import { SERIES_MAX, STORAGE_LIMITS } from "../limits.ts";
import { placeKey, rowSize, type Kind, type Place, type WidgetStorage, type Write } from "../storage.ts";
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
  /** At the start of the window's process: the places it migrates now (holding their locks), in order; none when its data is current. */
  migrateStart(): Promise<ApiStorageMigrate[]>;
  /** A place's migration ended: kept with the new version (ok), or dropped with the later ones. The error when keeping it failed (or it isn't the place due). */
  migrateEnd(scope: ApiStorageScope, ok: boolean): string | null;
  /** Its workspace's data is behind and it isn't migrating it (it moved there): its process should start again. */
  behind(): boolean;
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

/** A place being migrated: the step due first, then the next. */
type Step = ApiStorageMigrate & { place: Place | null; lock: string | null };

/** A place behind package.json's version that this window isn't migrating. */
const BEHIND = "This widget's data here is from an older version of it. Restart the widget to update it.";

export function windowStorage(core: Pick<CoreContext, "windows">, s: StorageScope): WindowStorage {
  const { storage, owner, declared } = s;
  /** The places this window migrates, the one due first; its writes staged until that step ends. */
  let steps: Step[] = [];
  let staged: Map<string, Staged> | null = null;
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
  /** A place's version: recorded, else 1 with data, else (never written) package.json's. */
  const versionOf = (scope: ApiStorageScope): number => {
    if (scope === "window") {
      const w = win();
      const v = w.state.storageVersion;
      if (typeof v === "number") return v;
      return Object.keys(kvOf(w)).length || Object.keys(seriesOf(w)).length ? 1 : declared;
    }
    const p = place(scope);
    return storage.version(p) ?? (storage.usage(p) > 0 ? 1 : declared);
  };
  const migrating = (scope: ApiStorageScope) => steps.some((x) => x.scope === scope);
  /** Before a read or write: another window's migration of the place ends; a place behind that no one migrates refuses. */
  const ready = async (scope: ApiStorageScope) => {
    if (scope !== "window") await storage.settled(placeKey(place(scope)), s.windowId);
    if (!migrating(scope) && versionOf(scope) < declared) throw failed(BEHIND);
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
    if (steps.length) {
      // A migration reshapes the store due now, and only that.
      if (steps[0]!.scope !== scope) throw failed(`A migration of the ${steps[0]!.scope} storage changes only that storage.`);
      return void staged!.set(sk(scope, kind, key), { scope, kind, key, value });
    }
    if (scope === "window") {
      const w = win();
      // A window first written at this version records it, so a later version knows what it has.
      const stamp = typeof w.state.storageVersion === "number" ? {} : { storageVersion: declared };
      if (kind === "kv") {
        const next = kvOf(w);
        if (value === null) delete next[key];
        else next[key] = value;
        core.windows.update(s.windowId, { state: { kv: next, ...stamp } });
      } else core.windows.update(s.windowId, { state: { series: { ...seriesOf(w), [key]: value as number[] }, ...stamp } });
    } else storage.write([{ place: place(scope), kind, key, value }], { place: place(scope), version: declared, stamp: true });
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
      await ready(sc);
      return get(sc, "kv", k) ?? null;
    },
    "storage.set": async (scope, key, value) => {
      const sc = scopeOf("storage.set", scope);
      const k = keyOf("storage.set", key);
      await ready(sc);
      put(sc, "kv", k, value ?? null);
      return null;
    },
    "storage.delete": async (scope, key) => {
      const sc = scopeOf("storage.delete", scope);
      const k = keyOf("storage.delete", key);
      await ready(sc);
      put(sc, "kv", k, null);
      return null;
    },
    "storage.keys": async (scope, prefix) => {
      const sc = scopeOf("storage.keys", scope);
      if (prefix !== undefined && prefix !== null && typeof prefix !== "string") throw invalid("storage.keys: the prefix should be a string");
      await ready(sc);
      return keys(sc, prefix ?? "");
    },
    "storage.history": async (scope, key, value, max) => {
      const sc = scopeOf("storage.history", scope);
      const k = keyOf("storage.history", key);
      await ready(sc);
      return history(sc, k, value, max);
    },
    // 1.0: the window scope, as it always was.
    "state.get": async (key) => {
      await ready("window");
      return get("window", "kv", String(key)) ?? null;
    },
    "state.set": async (key, value) => {
      const k = keyOf("state.set", key);
      await ready("window");
      put("window", "kv", k, value ?? null);
      return null;
    },
    "state.history": async (key, value, max) => {
      const k = keyOf("state.history", key);
      await ready("window");
      return history("window", k, value, max);
    },
  };

  return {
    verbs,
    // Checked at once, so a subscription to a scope or key that can't be is refused, not silent.
    read: (q) => verbs["storage.get"](scopeOf("storage", q?.scope), keyOf("storage", q?.key)),
    async migrateStart() {
      const due: Step[] = [];
      for (const scope of ["package", "workspace"] as const) {
        const p = place(scope);
        const lock = placeKey(p);
        await storage.lock(lock, s.windowId);
        if (disposed) {
          storage.unlock(lock, s.windowId);
          break;
        }
        const v = storage.version(p);
        if (v === null && storage.usage(p) === 0) {
          // Never written: at package.json's version, nothing to migrate.
          if (declared > 1) storage.write([], { place: p, version: declared });
          storage.unlock(lock, s.windowId);
        } else if ((v ?? 1) < declared) due.push({ scope, from: v ?? 1, to: declared, place: p, lock });
        else storage.unlock(lock, s.windowId);
      }
      if (disposed) {
        for (const d of due) storage.unlock(d.lock!, s.windowId);
        return [];
      }
      const w = win();
      const v = w.state.storageVersion;
      const has = Object.keys(kvOf(w)).length > 0 || Object.keys(seriesOf(w)).length > 0;
      if (typeof v !== "number" && !has) {
        if (declared > 1) core.windows.update(s.windowId, { state: { storageVersion: declared } });
      } else if ((typeof v === "number" ? v : 1) < declared) due.push({ scope: "window", from: typeof v === "number" ? v : 1, to: declared, place: null, lock: null });
      steps = due;
      staged = due.length ? new Map() : null;
      return due.map(({ scope, from, to }) => ({ scope, from, to }));
    },
    migrateEnd(scope, ok) {
      const step = steps[0];
      if (!step) return null;
      const writes = staged!;
      const drop = () => {
        for (const x of steps) if (x.lock) storage.unlock(x.lock, s.windowId);
        steps = [];
        staged = null;
      };
      if (step.scope !== scope) {
        drop();
        return `The migration answered for the ${scope} storage while the ${step.scope} storage was due.`;
      }
      if (!ok) {
        drop();
        return null;
      }
      try {
        if (step.place) {
          const rows: Write[] = [...writes.values()].map((w) => ({ place: step.place!, kind: w.kind, key: w.key, value: w.value }));
          storage.write(rows, { place: step.place, version: step.to });
        } else {
          const kv: Record<string, WireValue | null> = { ...kvOf() };
          const series: Record<string, WireValue | null> = { ...seriesOf() };
          for (const w of writes.values()) (w.kind === "kv" ? kv : series)[w.key] = w.value;
          for (const o of [kv, series]) for (const [k, v] of Object.entries(o)) if (v === null) delete o[k];
          core.windows.update(s.windowId, { state: { kv, series, storageVersion: step.to } });
        }
      } catch (e) {
        drop();
        return (e as Error).message;
      }
      if (step.lock) storage.unlock(step.lock, s.windowId);
      steps = steps.slice(1);
      staged = steps.length ? new Map() : null;
      return null;
    },
    behind: () => !steps.length && versionOf("workspace") < declared,
    dispose() {
      disposed = true;
      for (const x of steps) if (x.lock) storage.unlock(x.lock, s.windowId);
      steps = [];
      staged = null;
    },
  };
}
