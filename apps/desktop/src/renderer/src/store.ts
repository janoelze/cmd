// Mirror of core state (panes, agents, windows, Spaces) plus the Space this app
// window shows. Terminal output bypasses this store and goes straight to the
// xterm instances (see terminals.ts).

import { useSyncExternalStore } from "react";
import type { Agent, AgentId, AppNotification, AppWindow, CoreEvent, Pane, PaneId, SearchStatus, SettingsSnapshot, Space, SpaceId, WindowId } from "@cmd/protocol";
import { DEFAULT_SETTINGS, HOME_SPACE_ID } from "@cmd/protocol";
import { cmd } from "./bridge.ts";
import { terminals } from "./terminals.ts";
import { applyFonts } from "./fonts.ts";
import { applyThemeSettings } from "./themes/registry.ts";
import { setWindowTypes } from "./windows/registry.ts";
import { handleMagicEvent } from "./magic.ts";

export interface State {
  connected: boolean;
  panes: Map<PaneId, Pane>;
  agents: Map<AgentId, Agent>;
  /** Browser and file windows (terminal windows are the panes). */
  windows: Map<WindowId, AppWindow>;
  settings: SettingsSnapshot;
  /** Why the UI is not connected, if known. */
  error?: string;
  /** Transcript index status (search). */
  search: SearchStatus | null;
  /** Persisted UI state (see usePersisted). Loaded with the first snapshot. */
  ui: Record<string, unknown>;
  /** Open Spaces (docs/11-spaces.md). */
  spaces: Map<SpaceId, Space>;
  /** The Space this app window shows; main decides (see main/spaces.ts). */
  spaceId: SpaceId;
}

let state: State = {
  connected: false,
  panes: new Map(),
  agents: new Map(),
  windows: new Map(),
  settings: { settings: DEFAULT_SETTINGS, overrides: [], errors: [], path: "" },
  ui: {},
  search: null,
  spaces: new Map(),
  spaceId: new URLSearchParams(location.search).get("space") || HOME_SPACE_ID,
};
const listeners = new Set<() => void>();
const focusListeners = new Set<(id: WindowId) => void>();
const fsListeners = new Set<(path: string) => void>();
const notificationListeners = new Set<(n: AppNotification) => void>();

/** A notification from the core (packages/core/src/notifications.ts); the UI decides whether to show it. */
export function onNotification(fn: (n: AppNotification) => void): () => void {
  notificationListeners.add(fn);
  return () => notificationListeners.delete(fn);
}

/** A watched file or folder changed on disk (see fs.watch). */
export function onFsChanged(fn: (path: string) => void): () => void {
  fsListeners.add(fn);
  return () => fsListeners.delete(fn);
}

/** The core asks to bring a window forward (e.g. `open .` in a terminal). */
export function onWindowFocus(fn: (id: WindowId) => void): () => void {
  focusListeners.add(fn);
  return () => focusListeners.delete(fn);
}

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));

/** The whole state: re-renders on every change (panes, agents, usage…). Prefer useStoreValue. */
export function useStore(): State {
  return useSyncExternalStore(subscribe, () => state);
}

/**
 * One value from the state; re-renders only when it changes (by identity). The
 * selector must return something stable, e.g. `s.settings.settings` or a primitive,
 * not a new object per call.
 */
export function useStoreValue<T>(select: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

export function getState(): State {
  return state;
}

// ── persisted UI state ───────────────────────────────────

const pendingUi = new Map<string, ReturnType<typeof setTimeout>>();

/** Update UI state now; write it to the core shortly after (debounced per key). */
export function setUi(key: string, value: unknown): void {
  if (JSON.stringify(state.ui[key]) === JSON.stringify(value)) return;
  set({ ui: { ...state.ui, [key]: value } });
  clearTimeout(pendingUi.get(key));
  pendingUi.set(
    key,
    setTimeout(() => {
      pendingUi.delete(key);
      void cmd.call("ui.set", { key, value: value ?? null }).catch(() => {});
    }, 250),
  );
}

/** Flush pending writes, e.g. before the window unloads. */
export function flushUi(): void {
  for (const [key, t] of pendingUi) {
    clearTimeout(t);
    void cmd.call("ui.set", { key, value: state.ui[key] ?? null }).catch(() => {});
  }
  pendingUi.clear();
}
window.addEventListener("beforeunload", () => (flushUi(), flushSpaceViews()));

// ── per-Space view state ─────────────────────────────────
// Layout and selection live in Space.view in the core. Writes apply locally at
// once and reach the core debounced; until the core echoes a value back, it is
// re-applied over incoming Space updates so an older echo can't undo it.

const pendingView = new Map<SpaceId, Map<string, unknown>>();
const viewTimers = new Map<SpaceId, ReturnType<typeof setTimeout>>();

/**
 * A Space from the core, as the UI should hold it: values still waiting to be
 * echoed stay, and values equal to what we have keep their identity. The core
 * sends the whole view on every change; without this, one key's echo would hand
 * every consumer of every other key a "new" value (re-layout mid-drag).
 */
const withPending = (s: Space, prev?: Space): Space => {
  const p = pendingView.get(s.id);
  if (p) for (const [k, v] of p) if (JSON.stringify(s.view[k] ?? null) === JSON.stringify(v ?? null)) p.delete(k);
  const view: Record<string, unknown> = { ...s.view, ...(p?.size ? Object.fromEntries(p) : {}) };
  if (prev) for (const k of Object.keys(view)) if (k in prev.view && JSON.stringify(prev.view[k]) === JSON.stringify(view[k])) view[k] = prev.view[k];
  return { ...s, view };
};

/** Equal fields, and view values identical (withPending keeps unchanged ones identical). */
function sameSpace(a: Space, b: Space): boolean {
  const keys = Object.keys(b.view);
  return (
    a.name === b.name && a.root === b.root && a.order === b.order && a.hue === b.hue && a.closedAt === b.closedAt && a.lastActiveAt === b.lastActiveAt &&
    keys.length === Object.keys(a.view).length && keys.every((k) => a.view[k] === b.view[k])
  );
}

function sendView(spaceId: SpaceId): void {
  clearTimeout(viewTimers.get(spaceId));
  viewTimers.delete(spaceId);
  const p = pendingView.get(spaceId);
  if (!p?.size) return;
  void cmd.call("space.update", { id: spaceId, view: Object.fromEntries([...p].map(([k, v]) => [k, v ?? null])) }).catch(() => {});
}

function flushSpaceViews(): void {
  for (const id of [...viewTimers.keys()]) sendView(id);
}

/** Set a view key of a Space (any Space, not only this window's). */
export function setSpaceView(spaceId: SpaceId, key: string, value: unknown): void {
  const space = state.spaces.get(spaceId);
  if (!space || JSON.stringify(space.view[key]) === JSON.stringify(value)) return;
  if (!pendingView.has(spaceId)) pendingView.set(spaceId, new Map());
  pendingView.get(spaceId)!.set(key, value);
  const spaces = new Map(state.spaces);
  spaces.set(spaceId, { ...space, view: { ...space.view, [key]: value } });
  set({ spaces });
  clearTimeout(viewTimers.get(spaceId));
  viewTimers.set(spaceId, setTimeout(() => sendView(spaceId), 250));
}

export function getSpaceView<T>(spaceId: SpaceId, key: string, fallback: T): T {
  const v = state.spaces.get(spaceId)?.view[key];
  return v === undefined ? fallback : (v as T);
}

/**
 * Like usePersisted, for the shown Space's layout and selection. The setter
 * writes to the Space shown when it is called, so callbacks stay correct after a switch.
 */
export function useSpaceView<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void] {
  const stored = useStoreValue((s) => {
    const view = s.spaces.get(s.spaceId)?.view;
    return view && key in view ? view[key] : MISSING;
  });
  const value = (stored === MISSING ? fallback : stored) as T;
  const setter = (v: T | ((prev: T) => T)) => {
    const spaceId = state.spaceId;
    const prev = getSpaceView(spaceId, key, fallback);
    setSpaceView(spaceId, key, typeof v === "function" ? (v as (p: T) => T)(prev) : v);
  };
  return [value, setter];
}

/** The window (terminal or other) a selection id stands for lives in which Space? */
export function spaceOfWindow(id: string): SpaceId | null {
  return state.panes.get(id)?.spaceId ?? state.windows.get(id)?.spaceId ?? null;
}

/** Main says which Space this window shows (and maybe what to select there). */
cmd.onShowSpace(({ spaceId, select }) => {
  if (spaceId !== state.spaceId) set({ spaceId });
  if (select) {
    setSpaceView(spaceId, "selection.pane", select);
    const history = getSpaceView<string[]>(spaceId, "selection.history", []);
    setSpaceView(spaceId, "selection.history", [select, ...history.filter((x) => x !== select)].slice(0, 50));
  }
  void cmd.call("space.update", { id: spaceId, active: true }).catch(() => {});
});

/** This window's Space was closed or forgotten (here or elsewhere). */
function checkSpace(): void {
  if (state.connected && !state.spaces.has(state.spaceId)) cmd.spaceLost();
}

const MISSING = Symbol("missing");

/**
 * Like useState, but remembered across app restarts (stored in the core).
 * Until the core's snapshot arrives the fallback is used.
 */

export function usePersisted<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void] {
  // Only this key: other UI state and pane updates don't re-render the caller.
  const stored = useStoreValue((s) => (key in s.ui ? s.ui[key] : MISSING));
  const value = (stored === MISSING ? fallback : stored) as T;
  const setter = (v: T | ((prev: T) => T)) => {
    const prev = (key in state.ui ? state.ui[key] : fallback) as T;
    setUi(key, typeof v === "function" ? (v as (p: T) => T)(prev) : v);
  };
  return [value, setter];
}

// Output for panes that existed before we subscribed is held back until their
// snapshot arrives. Events and responses share one ordered socket, so anything
// received before the snapshot response is already contained in the snapshot.
const awaitingSnapshot = new Set<PaneId>();

function handle(e: CoreEvent): void {
  switch (e.type) {
    case "pane.output":
      if (!awaitingSnapshot.has(e.paneId)) terminals.write(e.paneId, e.data);
      return;
    case "pane.updated": {
      const panes = new Map(state.panes);
      panes.set(e.pane.id, e.pane);
      set({ panes });
      return;
    }
    case "pane.removed": {
      const panes = new Map(state.panes);
      panes.delete(e.paneId);
      terminals.dispose(e.paneId);
      set({ panes });
      return;
    }
    case "agent.updated": {
      const agents = new Map(state.agents);
      agents.set(e.agent.id, e.agent);
      set({ agents });
      return;
    }
    case "window.updated": {
      const windows = new Map(state.windows);
      windows.set(e.window.id, e.window);
      set({ windows });
      return;
    }
    case "window.removed": {
      const windows = new Map(state.windows);
      windows.delete(e.id);
      set({ windows });
      return;
    }
    case "space.updated": {
      const prev = state.spaces.get(e.space.id);
      const next = e.space.closedAt === null ? withPending(e.space, prev) : null;
      // Most updates are echoes of our own view writes: nothing new, no re-render.
      if (prev && next && sameSpace(prev, next)) return;
      const spaces = new Map(state.spaces);
      if (next) spaces.set(e.space.id, next);
      else spaces.delete(e.space.id);
      set({ spaces });
      checkSpace();
      return;
    }
    case "space.removed": {
      const spaces = new Map(state.spaces);
      spaces.delete(e.id);
      set({ spaces });
      checkSpace();
      return;
    }
    case "magic.stream":
    case "magic.data":
      handleMagicEvent(e);
      return;
    case "fs.changed":
      for (const fn of fsListeners) fn(e.path);
      return;
    case "notification":
      for (const fn of notificationListeners) fn(e.notification);
      return;
    case "window.focus":
      for (const fn of focusListeners) fn(e.id);
      return;
    case "search.status":
      set({ search: e.status });
      return;
    case "settings.updated":
      terminals.configure(e.snapshot.settings);
      applyFonts(e.snapshot.settings);
      applyThemeSettings(e.snapshot.settings);
      set({ settings: e.snapshot });
      return;
    case "agent.removed": {
      const agents = new Map(state.agents);
      agents.delete(e.agentId);
      set({ agents });
      return;
    }
  }
}

cmd.onEvent(handle);

cmd.onStatus(async (status) => {
  if (status !== "connected") {
    set({ connected: false });
    return;
  }
  performance.mark("boot:connected");
  let snap;
  try {
    snap = await cmd.call("events.subscribe", {});
    performance.mark("boot:snapshot");
    if (!snap.settings) throw new Error("core is running older code; restart it (relaunch the app to be asked)");
  } catch (err) {
    console.error("cmd: subscribe failed", err);
    set({ connected: false, error: (err as Error).message });
    return;
  }
  for (const p of snap.panes) awaitingSnapshot.add(p.id), terminals.hold(p.id);
  terminals.configure(snap.settings.settings);
  applyFonts(snap.settings.settings);
  applyThemeSettings(snap.settings.settings);
  setWindowTypes(snap.windowTypes ?? []);
  set({
    connected: true,
    error: undefined,
    settings: snap.settings,
    ui: snap.ui ?? {},
    panes: new Map(snap.panes.map((p) => [p.id, p])),
    agents: new Map(snap.agents.map((a) => [a.id, a])),
    windows: new Map((snap.windows ?? []).map((w) => [w.id, w])),
    spaces: new Map((snap.spaces ?? []).map((sp) => [sp.id, withPending(sp, state.spaces.get(sp.id))])),
  });
  checkSpace();
  void cmd.call("search.status", {}).then((search) => set({ search }), () => {});
  // The windows show now; each terminal opens once its content is written (hold).
  await Promise.allSettled(
    snap.panes.map(async (p) => {
      try {
        const { data } = await cmd.call("pane.snapshot", { paneId: p.id });
        terminals.reset(p.id);
        terminals.write(p.id, data);
      } finally {
        awaitingSnapshot.delete(p.id);
        terminals.release(p.id);
      }
    }),
  );
  performance.mark("boot:terminals");
});
