// Mirror of core state (panes, agents, windows, workspaces) plus the workspace this app
// window shows. Terminal output bypasses this store and goes straight to the
// xterm instances (see terminals.ts).

import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import type { Agent, AgentId, AppNotification, AppWindow, CommandRun, CoreEvent, Pane, PaneId, RemotePairRequest, RemoteStatus, SearchStatus, SettingsSnapshot, Workspace, WorkspaceId, StartupStatus, WidgetEntry, WindowId, DataEvent, DataQuery, SessionInfo, TurnRow, ViewQuery } from "@cmd/protocol";
import { DEFAULT_SETTINGS, HOME_WORKSPACE_ID } from "@cmd/protocol";
import { reducedMotion } from "@cmd/ui";
import { cmd } from "./bridge.ts";
import { terminals } from "./terminals.ts";
import { applyFonts } from "./fonts.ts";
import { applyLookSettings } from "./look.ts";
import { applyThemeSettings } from "./theme.ts";
import { setWindowTypes } from "./windows/registry.ts";
import { handleMagicEvent } from "./magic.ts";
import { countEvent, perf } from "./perf.ts";
import { cleanTitle } from "./model.ts";

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
  /** The core's startup phase and what it is still doing (core.startup); null until the core said. */
  startup: StartupStatus | null;
  /** Persisted UI state (see usePersisted). Loaded with the first snapshot. */
  ui: Record<string, unknown>;
  /** Open workspaces (docs/11-workspaces.md). */
  workspaces: Map<WorkspaceId, Workspace>;
  /** The workspace this app window shows; main decides (see main/workspaces.ts). */
  workspaceId: WorkspaceId;
  /** Remote access (docs/13-remote-access.md): who is connected and what they watch. */
  remote: RemoteStatus | null;
  /** Devices waiting for the person at this Mac to allow them. */
  pairRequests: RemotePairRequest[];
  /** Terminals a remote device just typed into: pane → device name (cleared after a moment). */
  remoteInput: Map<PaneId, string>;
  /** The Widget Library (docs/16-widgets.md): built-in widgets, then yours by last use. */
  library: WidgetEntry[];
}

let state: State = {
  connected: false,
  panes: new Map(),
  agents: new Map(),
  windows: new Map(),
  settings: { settings: DEFAULT_SETTINGS, overrides: [], errors: [], path: "" },
  ui: {},
  search: null,
  startup: null,
  workspaces: new Map(),
  workspaceId: new URLSearchParams(location.search).get("workspace") || HOME_WORKSPACE_ID,
  remote: null,
  pairRequests: [],
  remoteInput: new Map(),
  library: [],
};
const inputTimers = new Map<PaneId, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const focusListeners = new Set<(id: WindowId) => void>();
const fsListeners = new Set<(path: string) => void>();
const actionsListeners = new Set<(root: string) => void>();
const notificationListeners = new Set<(n: AppNotification) => void>();

/** A notification from the core (packages/core/src/notifications.ts); the UI decides whether to show it. */
export function onNotification(fn: (n: AppNotification) => void): () => void {
  notificationListeners.add(fn);
  return () => notificationListeners.delete(fn);
}

/** Commands terminals run (core/commands.ts), for the Commands widget. */
/**
 * A live query over the event log (data.subscribe): `fn` gets the events now
 * (initial) and then every event recorded or updated that answers the query,
 * to merge by id. Subscriptions are made again after a reconnect.
 */
interface DataSub {
  query: DataQuery;
  fn: (events: DataEvent[], initial: boolean) => void;
  id: string | null;
  stale: boolean;
}
const dataSubs = new Set<DataSub>();
const dataById = new Map<string, DataSub>();
async function openDataSub(sub: DataSub): Promise<void> {
  try {
    const r = await cmd.call("data.subscribe", { query: sub.query });
    if (sub.stale) return void cmd.call("data.unsubscribe", { id: r.id }).catch(() => {});
    sub.id = r.id;
    dataById.set(r.id, sub);
    sub.fn(r.events, true);
  } catch {
    // an older core, or none yet: tried again on the next connection
  }
}
export function subscribeData(query: DataQuery, fn: (events: DataEvent[], initial: boolean) => void): () => void {
  const sub: DataSub = { query, fn, id: null, stale: false };
  dataSubs.add(sub);
  if (state.connected) void openDataSub(sub);
  return () => {
    sub.stale = true;
    dataSubs.delete(sub);
    if (sub.id) {
      dataById.delete(sub.id);
      void cmd.call("data.unsubscribe", { id: sub.id }).catch(() => {});
      sub.id = null;
    }
  };
}
function reopenDataSubs(): void {
  dataById.clear();
  for (const sub of dataSubs) (sub.id = null), void openDataSub(sub);
  viewById.clear();
  for (const sub of viewSubs) (sub.id = null), void openViewSub(sub);
}

/** A live query over a view (turns, sessions): rows now (initial), then the rows that change; initial again when the core resets it. Made again after a reconnect. */
interface ViewSub {
  query: ViewQuery;
  fn: (rows: (TurnRow | SessionInfo)[], initial: boolean) => void;
  id: string | null;
  stale: boolean;
}
const viewSubs = new Set<ViewSub>();
const viewById = new Map<string, ViewSub>();
async function openViewSub(sub: ViewSub): Promise<void> {
  try {
    const r = await cmd.call("data.subscribeView", { query: sub.query });
    if (sub.stale) return void cmd.call("data.unsubscribe", { id: r.id }).catch(() => {});
    sub.id = r.id;
    viewById.set(r.id, sub);
    sub.fn(r.rows, true);
  } catch {
    // an older core, or none yet
  }
}
export function subscribeView(query: ViewQuery, fn: (rows: (TurnRow | SessionInfo)[], initial: boolean) => void): () => void {
  const sub: ViewSub = { query, fn, id: null, stale: false };
  viewSubs.add(sub);
  if (state.connected) void openViewSub(sub);
  return () => {
    sub.stale = true;
    viewSubs.delete(sub);
    if (sub.id) {
      viewById.delete(sub.id);
      void cmd.call("data.unsubscribe", { id: sub.id }).catch(() => {});
      sub.id = null;
    }
  };
}


/** A watched file or folder changed on disk (see fs.watch). */
export function onFsChanged(fn: (path: string) => void): () => void {
  fsListeners.add(fn);
  return () => fsListeners.delete(fn);
}

/** A folder's Workspace Actions changed (actions.list again). */
export function onActionsChanged(fn: (root: string) => void): () => void {
  actionsListeners.add(fn);
  return () => actionsListeners.delete(fn);
}

/** The core asks to bring a window forward (e.g. `open .` in a terminal). */
export function onWindowFocus(fn: (id: WindowId) => void): () => void {
  focusListeners.add(fn);
  return () => focusListeners.delete(fn);
}

function set(next: Partial<State>): void {
  perf.sets++;
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
/** The Widget Library as the core just listed it. */
export function setLibrary(library: WidgetEntry[]): void {
  set({ library });
}

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
window.addEventListener("beforeunload", () => (flushUi(), flushWorkspaceViews()));

// ── per-workspace view state ─────────────────────────────────
// Layout and selection live in workspace.view in the core. Writes apply locally at
// once and reach the core debounced; until the core echoes a value back, it is
// re-applied over incoming workspace updates so an older echo can't undo it.

const pendingView = new Map<WorkspaceId, Map<string, unknown>>();
const viewTimers = new Map<WorkspaceId, ReturnType<typeof setTimeout>>();

/**
 * A workspace from the core, as the UI should hold it: values still waiting to be
 * echoed stay, and values equal to what we have keep their identity. The core
 * sends the whole view on every change; without this, one key's echo would hand
 * every consumer of every other key a "new" value (re-layout mid-drag).
 */
const withPending = (s: Workspace, prev?: Workspace): Workspace => {
  const p = pendingView.get(s.id);
  if (p) for (const [k, v] of p) if (JSON.stringify(s.view[k] ?? null) === JSON.stringify(v ?? null)) p.delete(k);
  const view: Record<string, unknown> = { ...s.view, ...(p?.size ? Object.fromEntries(p) : {}) };
  if (prev) for (const k of Object.keys(view)) if (k in prev.view && JSON.stringify(prev.view[k]) === JSON.stringify(view[k])) view[k] = prev.view[k];
  return { ...s, view };
};

/** Equal fields, and view values identical (withPending keeps unchanged ones identical). */
function sameWorkspace(a: Workspace, b: Workspace): boolean {
  const keys = Object.keys(b.view);
  return (
    a.name === b.name && a.root === b.root && a.order === b.order && a.icon === b.icon && a.closedAt === b.closedAt && a.lastActiveAt === b.lastActiveAt &&
    keys.length === Object.keys(a.view).length && keys.every((k) => a.view[k] === b.view[k])
  );
}

function sendView(workspaceId: WorkspaceId): void {
  clearTimeout(viewTimers.get(workspaceId));
  viewTimers.delete(workspaceId);
  const p = pendingView.get(workspaceId);
  if (!p?.size) return;
  void cmd.call("workspace.update", { id: workspaceId, view: Object.fromEntries([...p].map(([k, v]) => [k, v ?? null])) }).catch(() => {});
}

function flushWorkspaceViews(): void {
  for (const id of [...viewTimers.keys()]) sendView(id);
}

/** Set a view key of a workspace (any workspace, not only this window's). */
export function setWorkspaceView(workspaceId: WorkspaceId, key: string, value: unknown): void {
  const workspace = state.workspaces.get(workspaceId);
  if (!workspace || JSON.stringify(workspace.view[key]) === JSON.stringify(value)) return;
  if (!pendingView.has(workspaceId)) pendingView.set(workspaceId, new Map());
  pendingView.get(workspaceId)!.set(key, value);
  const workspaces = new Map(state.workspaces);
  workspaces.set(workspaceId, { ...workspace, view: { ...workspace.view, [key]: value } });
  set({ workspaces });
  clearTimeout(viewTimers.get(workspaceId));
  viewTimers.set(workspaceId, setTimeout(() => sendView(workspaceId), 250));
}

export function getWorkspaceView<T>(workspaceId: WorkspaceId, key: string, fallback: T): T {
  const v = state.workspaces.get(workspaceId)?.view[key];
  return v === undefined ? fallback : (v as T);
}

/**
 * Like usePersisted, for the shown workspace's layout and selection. The setter
 * writes to the workspace shown when it is called, so callbacks stay correct after a switch.
 */
export function useWorkspaceView<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void] {
  const stored = useStoreValue((s) => {
    const view = s.workspaces.get(s.workspaceId)?.view;
    return view && key in view ? view[key] : MISSING;
  });
  const value = (stored === MISSING ? fallback : stored) as T;
  const setter = (v: T | ((prev: T) => T)) => {
    const workspaceId = state.workspaceId;
    const prev = getWorkspaceView(workspaceId, key, fallback);
    setWorkspaceView(workspaceId, key, typeof v === "function" ? (v as (p: T) => T)(prev) : v);
  };
  return [value, setter];
}

/** The window (terminal or other) a selection id stands for lives in which workspace? */
export function workspaceOfWindow(id: string): WorkspaceId | null {
  return state.panes.get(id)?.workspaceId ?? state.windows.get(id)?.workspaceId ?? null;
}

/** Main says which workspace this window shows (and maybe what to select there). */
cmd.onShowWorkspace(({ workspaceId, select }) => {
  const show = () => {
    if (workspaceId !== state.workspaceId) set({ workspaceId });
    if (select) {
      setWorkspaceView(workspaceId, "selection.pane", select);
      const history = getWorkspaceView<string[]>(workspaceId, "selection.history", []);
      setWorkspaceView(workspaceId, "selection.history", [select, ...history.filter((x) => x !== select)].slice(0, 50));
    }
  };
  if (workspaceId === state.workspaceId) show();
  else switchWorkspace(state.workspaceId, workspaceId, show);
  // A reload (⌘R) loads the URL again: keep it naming the workspace shown now.
  const url = new URL(location.href);
  url.searchParams.set("workspace", workspaceId);
  history.replaceState(history.state, "", url);
  void cmd.call("workspace.update", { id: workspaceId, active: true }).catch(() => {});
});

/**
 * Switching workspaces moves through a vertical stack of them: everything in the old
 * Workspace (sidebars, windows, widgets) leaves out the top while the next one's rises
 * from the bottom; the previous workspace comes the other way (styles.css). One
 * element-scoped View Transition on the stage, so the top bar and footer stay put,
 * the new side stays live, and the slide runs on the compositor while the view
 * re-lays out. `update` must commit synchronously.
 */
function switchWorkspace(from: WorkspaceId, to: WorkspaceId, update: () => void): void {
  const stage = document.querySelector<HTMLElement & { startViewTransition?: (o: { update: () => void; types?: string[] }) => unknown }>(".stage");
  const a = state.workspaces.get(from);
  const b = state.workspaces.get(to);
  if (!stage?.startViewTransition || !a || !b || reducedMotion()) return update();
  stage.startViewTransition({ update: () => flushSync(update), types: [b.order > a.order ? "workspace-next" : "workspace-prev"] });
}

/** This window's workspace was closed or forgotten (here or elsewhere). */
function checkWorkspace(): void {
  if (state.connected && !state.workspaces.has(state.workspaceId)) cmd.workspaceLost();
}

/** The pane whose resource usage this window shows (the selected one; see setUsageShown). */
let usageShown: PaneId | null = null;

/** The selected pane changed: its usage, kept current without re-renders, shows now. */
export function setUsageShown(id: PaneId | null): void {
  if (id === usageShown) return;
  usageShown = id;
  set({});
}

/**
 * The same pane as far as anything shows it: only its title's spinner glyphs
 * differ, its activity time (which only orders the sidebar; the next render that
 * happens anyway sorts by the fresh value), or the usage of a pane not selected.
 */
function looksSame(a: Pane, b: Pane): boolean {
  if (a.title !== b.title && cleanTitle(a.title) !== cleanTitle(b.title)) return false;
  for (const k of Object.keys(b) as (keyof Pane)[]) {
    if (k === "title" || k === "lastActivityAt" || a[k] === b[k]) continue;
    // Resource samples (every 2 s per busy terminal) only show in the status bar, for the selected one.
    if (k === "usage" && b.id !== usageShown) continue;
    // Nested values arrive as new objects with every event.
    if (typeof b[k] !== "object" || JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
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
  countEvent(e.type);
  switch (e.type) {
    case "pane.output":
      if (!awaitingSnapshot.has(e.paneId)) terminals.write(e.paneId, e.data);
      return;
    case "pane.updated": {
      const prev = state.panes.get(e.pane.id);
      // Agents animate a spinner in their title many times a second; the UI shows titles
      // without it (cleanTitle). Keep the pane current, but don't re-render for that.
      if (prev && looksSame(prev, e.pane)) {
        state.panes.set(e.pane.id, e.pane);
        return;
      }
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
    case "workspace.updated": {
      const prev = state.workspaces.get(e.workspace.id);
      const next = e.workspace.closedAt === null ? withPending(e.workspace, prev) : null;
      // Most updates are echoes of our own view writes: nothing new, no re-render.
      if (prev && next && sameWorkspace(prev, next)) return;
      const workspaces = new Map(state.workspaces);
      if (next) workspaces.set(e.workspace.id, next);
      else workspaces.delete(e.workspace.id);
      set({ workspaces });
      checkWorkspace();
      return;
    }
    case "workspace.removed": {
      const workspaces = new Map(state.workspaces);
      workspaces.delete(e.id);
      set({ workspaces });
      checkWorkspace();
      return;
    }
    case "magic.stream":
    case "magic.data":
      handleMagicEvent(e);
      return;
    case "fs.changed":
      for (const fn of fsListeners) fn(e.path);
      return;
    case "actions.changed":
      for (const fn of actionsListeners) fn(e.root);
      return;
    case "widget.library":
      set({ library: e.entries });
      return;
    case "notification":
      for (const fn of notificationListeners) fn(e.notification);
      return;
    case "data.changed":
      dataById.get(e.id)?.fn(e.events, false);
      return;
    case "view.changed":
      viewById.get(e.id)?.fn(e.rows, !!e.reset);
      return;
    case "window.focus":
      for (const fn of focusListeners) fn(e.id);
      return;
    case "search.status":
      set({ search: e.status });
      return;
    case "core.startup":
      set({ startup: e.status });
      return;
    case "settings.updated":
      terminals.configure(e.snapshot.settings);
      applyFonts(e.snapshot.settings);
      applyThemeSettings(e.snapshot.settings);
      applyLookSettings(e.snapshot.settings);
      set({ settings: e.snapshot });
      return;
    case "agent.removed": {
      const agents = new Map(state.agents);
      agents.delete(e.agentId);
      set({ agents });
      return;
    }
    case "remote.updated":
      set({ remote: e.status });
      return;
    case "remote.pairRequest":
      set({ pairRequests: [...state.pairRequests.filter((r) => r.requestId !== e.request.requestId), e.request] });
      return;
    case "remote.pairEnded":
      set({ pairRequests: state.pairRequests.filter((r) => r.requestId !== e.requestId) });
      return;
    case "remote.input": {
      clearTimeout(inputTimers.get(e.paneId));
      set({ remoteInput: new Map(state.remoteInput).set(e.paneId, e.name) });
      inputTimers.set(
        e.paneId,
        setTimeout(() => {
          const remoteInput = new Map(state.remoteInput);
          remoteInput.delete(e.paneId);
          set({ remoteInput });
        }, 4000),
      );
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
  applyLookSettings(snap.settings.settings);
  setWindowTypes(snap.windowTypes ?? []);
  set({
    connected: true,
    error: undefined,
    settings: snap.settings,
    ui: snap.ui ?? {},
    panes: new Map(snap.panes.map((p) => [p.id, p])),
    agents: new Map(snap.agents.map((a) => [a.id, a])),
    windows: new Map((snap.windows ?? []).map((w) => [w.id, w])),
    workspaces: new Map((snap.workspaces ?? []).map((sp) => [sp.id, withPending(sp, state.workspaces.get(sp.id))])),
  });
  checkWorkspace();
  void cmd.call("search.status", {}).then((search) => set({ search }), () => {});
  void cmd.call("widget.list", {}).then((library) => set({ library }), () => {});
  // An older core has no remote access: leave it null.
  void cmd.call("remote.status", {}).then((remote) => set({ remote, pairRequests: remote.requests ?? [] }), () => {});
  // The windows show now; each terminal opens once its content is written (hold).
  // Answers come back in the order asked (one socket): the selected terminal first,
  // then the rest of this window's workspace, then other workspaces.
  const selected = state.workspaces.get(state.workspaceId)?.view?.["selection.pane"];
  const rank = (p: Pane) => (p.id === selected ? 0 : p.workspaceId === state.workspaceId ? 1 : 2);
  await Promise.allSettled(
    [...snap.panes].sort((a, b) => rank(a) - rank(b)).map(async (p) => {
      try {
        const { data, cols, rows } = await cmd.call("pane.snapshot", { paneId: p.id });
        terminals.reset(p.id);
        terminals.replay(p.id, data, { cols, rows });
      } finally {
        awaitingSnapshot.delete(p.id);
        terminals.release(p.id);
      }
    }),
  );
  performance.mark("boot:terminals");
  reopenDataSubs();
});
