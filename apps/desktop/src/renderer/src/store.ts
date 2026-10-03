// Mirror of core state (panes + agents). Terminal output bypasses this store and
// goes straight to the xterm instances (see terminals.ts).

import { useSyncExternalStore } from "react";
import type { Agent, AgentId, AppWindow, CoreEvent, Pane, PaneId, SearchStatus, SettingsSnapshot, WindowId } from "@cmd/protocol";
import { DEFAULT_SETTINGS } from "@cmd/protocol";
import { cmd } from "./bridge.ts";
import { terminals } from "./terminals.ts";

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
const agentListeners = new Set<(prev: Agent | undefined, next: Agent) => void>();
const focusListeners = new Set<(id: WindowId) => void>();

/** The core asks to bring a window forward (e.g. `open .` in a terminal). */
export function onWindowFocus(fn: (id: WindowId) => void): () => void {
  focusListeners.add(fn);
  return () => focusListeners.delete(fn);
}

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

export function useStore(): State {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => state,
  );
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
export function usePersisted<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void] {
  const s = useStore();
  const value = (key in s.ui ? s.ui[key] : fallback) as T;
  const setter = (v: T | ((prev: T) => T)) => {
    const prev = (key in state.ui ? state.ui[key] : fallback) as T;
    setUi(key, typeof v === "function" ? (v as (p: T) => T)(prev) : v);
  };
  return [value, setter];
}

/** For notifications: called on every agent transition. */
export function onAgentChange(fn: (prev: Agent | undefined, next: Agent) => void): () => void {
  agentListeners.add(fn);
  return () => agentListeners.delete(fn);
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
      const prev = state.agents.get(e.agent.id);
      const agents = new Map(state.agents);
      agents.set(e.agent.id, e.agent);
      set({ agents });
      for (const fn of agentListeners) fn(prev, e.agent);
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
    case "window.focus":
      for (const fn of focusListeners) fn(e.id);
      return;
    case "search.status":
      set({ search: e.status });
      return;
    case "settings.updated":
      terminals.configure(e.snapshot.settings);
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
  let snap;
  try {
    snap = await cmd.call("events.subscribe", {});
    if (!snap.settings) throw new Error("core is running older code; restart it (relaunch the app to be asked)");
  } catch (err) {
    console.error("cmd: subscribe failed", err);
    set({ connected: false, error: (err as Error).message });
    return;
  }
  for (const p of snap.panes) awaitingSnapshot.add(p.id);
  terminals.configure(snap.settings.settings);
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
  await Promise.all(
    snap.panes.map(async (p) => {
      try {
        const { data } = await cmd.call("pane.snapshot", { paneId: p.id });
        terminals.reset(p.id);
        terminals.write(p.id, data);
      } finally {
        awaitingSnapshot.delete(p.id);
      }
    }),
  );
});
