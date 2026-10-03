// Mirror of core state (panes + agents). Terminal output bypasses this store and
// goes straight to the xterm instances (see terminals.ts).

import { useSyncExternalStore } from "react";
import type { Agent, AgentId, AppNotification, AppWindow, CoreEvent, Pane, PaneId, SearchStatus, SettingsSnapshot, WindowId } from "@cmd/protocol";
import { DEFAULT_SETTINGS } from "@cmd/protocol";
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
}

let state: State = {
  connected: false,
  panes: new Map(),
  agents: new Map(),
  windows: new Map(),
  settings: { settings: DEFAULT_SETTINGS, overrides: [], errors: [], path: "" },
  ui: {},
  search: null,
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
window.addEventListener("beforeunload", flushUi);

/**
 * Like useState, but remembered across app restarts (stored in the core).
 * Until the core's snapshot arrives the fallback is used.
 */
const MISSING = Symbol("missing");

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
  });
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
