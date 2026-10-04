// Core API. Transport: newline-delimited JSON-RPC 2.0 over a Unix socket.
// Every method is reachable from the UI, the `cmd` CLI and (later) MCP.

import type { Agent, AgentId, AgentKind, AgentState, AppNotification, AppWindow, FileEntry, GitStatus, Pane, PaneId, ProcessStat, Space, SpaceId, WindowId, WindowTypeInfo } from "./model.ts";
import type { SettingKey, Settings } from "./settings.ts";
import type { MagicModel, MagicProgress } from "./magic.ts";
import type { SecretsStatus } from "./secrets.ts";

export interface CoreInfo {
  pid: number;
  build: string;
  /** Folder the core runs from (the repo, or the app's runtime copy). */
  root: string;
  node: string;
  /** Epoch ms. */
  startedAt: number;
  rssBytes: number;
  heapBytes: number;
  /** CPU time used since start, user + system. */
  cpuSeconds: number;
  panes: number;
  connections: number;
  socket: string;
  dbPath: string | null;
  settingsPath: string | null;
  /** Where terminals run: the PTY host process, or null for in the core (it couldn't start). */
  ptyHost: { pid: number; startedAt: number; root: string } | null;
}

export interface SettingsSnapshot {
  settings: Settings;
  /** Keys set explicitly in the user's file. */
  overrides: SettingKey[];
  /** Validation problems in the user's file (those entries are ignored). */
  errors: string[];
  path: string;
}

/**
 * Where something new goes (docs/11-spaces.md). Resolved in order: `spaceId`,
 * the calling pane's Space (`callerPaneId`, the CLI's CMD_PANE_ID), the parent
 * agent's, the open Space whose root most deeply contains the cwd or path, Home.
 */
export interface Placement {
  spaceId?: SpaceId;
  callerPaneId?: PaneId;
}

export interface Methods {
  /** stateDir: the core's $CMD_HOME, so an app can tell its own core from another instance's (older cores omit it). */
  "core.hello": { params: {}; result: { version: string; pid: number; socket: string; build: string; stateDir?: string } };
  /** Diagnostics for the Settings window's About page. */
  "core.info": { params: {}; result: CoreInfo };
  /** The core's and PTY host's own usage (Task Manager); CPU% is since the previous call. Null where unknown. */
  "core.processes": { params: {}; result: { core: ProcessStat | null; ptyHost: ProcessStat | null } };

  /** cwd defaults to the Space's root. */
  "pane.create": {
    params: Placement & { cwd?: string; command?: string; cols?: number; rows?: number; env?: Record<string, string> };
    result: Pane;
  };
  "pane.list": { params: {}; result: Pane[] };
  "pane.write": { params: { paneId: PaneId; data: string }; result: null };
  "pane.resize": { params: { paneId: PaneId; cols: number; rows: number }; result: null };
  "pane.kill": { params: { paneId: PaneId }; result: null };
  /** Notifications (packages/core/src/notifications.ts). */
  "pane.setMuted": { params: { paneId: PaneId; muted: boolean }; result: null };
  "pane.clearAttention": { params: { paneId: PaneId }; result: null };
  /** `cmd notify`: from a terminal (paneId) or from anywhere. */
  "notify.send": { params: { paneId?: PaneId | null; title?: string; body: string }; result: null };
  /** Terminal state, for re-attaching a view after a UI reload; replay it into a terminal of `cols` x `rows`. */
  "pane.snapshot": { params: { paneId: PaneId }; result: { data: string; cols: number; rows: number } };
  /** Clear stuck terminal state (modes a crashed program left on). */
  "pane.reset": { params: { paneId: PaneId }; result: null };
  /** Plain-text tail of the pane, as displayed. */
  "pane.read": { params: { paneId: PaneId; lines?: number }; result: { text: string } };

  "agent.list": { params: {}; result: Agent[] };
  "agent.spawn": {
    params: Placement & {
      kind: AgentKind;
      prompt?: string;
      cwd?: string;
      name?: string;
      /** Defaults to the caller's agent when called from inside a pane. */
      parentId?: AgentId | null;
      operationId?: string;
    };
    result: Agent;
  };
  "agent.send": { params: { agentId: AgentId; text: string; submit?: boolean }; result: null };
  "agent.wait": {
    params: {
      agentIds: AgentId[];
      until: AgentState[];
      mode?: "any" | "all";
      timeoutMs?: number;
    };
    result: { agents: Agent[]; timedOut: boolean };
  };
  "agent.kill": { params: { agentId: AgentId; tree?: boolean }; result: { killed: AgentId[] } };
  "agent.markSeen": { params: { agentId: AgentId }; result: null };

  /** Called by `cmd hook` from inside agent hooks. */
  "hook.ingest": {
    params: { paneId: PaneId; agent: AgentKind; event: string; payload: Record<string, unknown> };
    result: { agentId: AgentId | null };
  };
  "identify": { params: { paneId: PaneId }; result: { pane: Pane | null; agent: Agent | null } };

  "settings.get": { params: {}; result: SettingsSnapshot };
  "settings.set": { params: { key: string; value: unknown }; result: SettingsSnapshot };
  "settings.reset": { params: { key: string }; result: SettingsSnapshot };
  /** Which secrets (API keys) are set, never their values (secrets.ts). */
  "secrets.status": { params: {}; result: SecretsStatus };
  /** Store a secret, or remove it with null. */
  "secrets.set": { params: { key: string; value: string | null }; result: SecretsStatus };

  /**
   * Open a window of a registered type. `input` is the type's create input:
   * terminal { cwd?, command? }, browser { url? }, files { path? }, text { path }.
   */
  "window.open": { params: Placement & { kind: string; input?: Record<string, unknown> }; result: AppWindow };
  /** Windows report navigation (state patches, applied by their type) and titles here. */
  /** `kind` switches the window to another type in place (state re-created from the current one). */
  "window.update": {
    params: { id: WindowId; title?: string; state?: Record<string, unknown>; kind?: string };
    result: AppWindow;
  };
  /** Registered window types (built-in and plugins). */
  "window.types": { params: {}; result: WindowTypeInfo[] };
  "window.close": { params: { id: WindowId }; result: null };
  /**
   * Open a path or URL in the window type that handles it (registry rules +
   * the open.handlers setting). null = no type handles it (use the default app).
   */
  "window.openTarget": { params: Placement & { target: string }; result: AppWindow | null };
  /** Move a window to another Space; a terminal takes its agent tree (and their terminals) along. */
  "window.move": { params: { id: WindowId; spaceId: SpaceId }; result: AppWindow };

  /** Open Spaces in switcher order; closed: also the closed (recent) ones. */
  "space.list": { params: { closed?: boolean }; result: Space[] };
  /**
   * Attach-or-create by root: the Space whose root is this path (canonicalized),
   * reopened if it was closed, else a new one. Relative paths resolve against
   * `cwd`. gitRoot: use the enclosing repository's root (a worktree's own root).
   * show: ask the UI to show it (space.show event; newWindow: in a new app window).
   */
  "space.open": {
    params: { path: string; cwd?: string; gitRoot?: boolean; show?: boolean; newWindow?: boolean };
    result: { space: Space; created: boolean };
  };
  /** The Space a path belongs to (longest open root containing it, else Home), without creating one. */
  "space.match": { params: { path: string; cwd?: string }; result: Space };
  /** view: keys merged into the Space's view (null deletes a key). active: it was just shown (recency for the picker). icon: an SF Symbol name, null for the default. */
  "space.update": { params: { id: SpaceId; name?: string; icon?: string | null; order?: number; view?: Record<string, unknown>; active?: boolean }; result: Space };
  /** Kill its terminals and agents, remove its windows; the Space stays as a recent one. Home can't be closed. */
  "space.close": { params: { id: SpaceId }; result: null };
  /** Delete a closed Space's record. */
  "space.forget": { params: { id: SpaceId }; result: null };
  /** All windows, terminals included. */
  "window.list": { params: {}; result: AppWindow[] };

  /**
   * Make a Magic window's content from a request (docs/12-magic-windows.md), or
   * refine what it shows. Returns at once; progress arrives as magic.stream
   * events and the result in the window's state.
   */
  "magic.run": { params: { id: WindowId; prompt: string }; result: null };
  /** Stop a run in progress. */
  "magic.cancel": { params: { id: WindowId }; result: null };
  /** Run the widget's data source now (then on its interval again). */
  "magic.refresh": { params: { id: WindowId }; result: null };
  /** Set how often the widget's data source runs, in seconds (0 = only on Refresh Now); kept across refinements. */
  "magic.setRefresh": { params: { id: WindowId; seconds: number }; result: null };
  /** The models a provider offers to the user's stored API key, newest first (fails without a key). */
  "magic.models": { params: { provider: string; refresh?: boolean }; result: MagicModel[] };
  /** Allow (or decline) the media origins the widget asks for (MagicState.media); the frame's CSP opens only allowed ones. */
  "magic.media": { params: { id: WindowId; allow: boolean }; result: null };

  /** Directory listing for file windows (dirs first, then by name). */
  "fs.list": { params: { path: string }; result: { path: string; parent: string | null; entries: FileEntry[] } };
  /** Which of these paths exist, resolved against `cwd` (~ expanded): the absolute path, or null. For terminal links. */
  "fs.resolve": { params: { paths: string[]; cwd: string }; result: (string | null)[] };
  /** Read a text file (first 5 MB). */
  "fs.read": {
    params: { path: string };
    result: { text: string; size: number; mtime: number; truncated: boolean; binary: boolean };
  };
  /** Get fs.changed events for a file or folder (released when the connection closes). */
  "fs.watch": { params: { path: string }; result: { watching: boolean } };
  "fs.unwatch": { params: { path: string }; result: null };
  /** Write a text file; fails if it changed on disk since `expectMtime`. */
  "fs.write": { params: { path: string; text: string; expectMtime?: number }; result: { size: number; mtime: number } };
  /** Rename in place (`name` has no slashes); fails if the name is taken. Returns the new path. */
  "fs.rename": { params: { path: string; name: string }; result: string };
  /** Copy a file or folder next to itself as "name copy", "name copy 2"…; returns the copy's path. */
  "fs.duplicate": { params: { path: string }; result: string };
  /** New empty file or folder in `dir`, named "untitled" / "untitled folder" (then " 2"…); returns its path. */
  "fs.create": { params: { dir: string; kind: "file" | "dir" }; result: string };
  /** Git state of the repository a folder is in, limited to that folder; null outside a work tree or without git. */
  "git.status": { params: { path: string }; result: GitStatus | null };

  /** Full-text search over Claude Code / Codex transcripts. */
  "search.query": { params: { text: string; limit?: number }; result: SearchHit[] };
  /** The most recently active past sessions, newest first; `exclude`: session ids to leave out (open ones). */
  "search.recent": { params: { limit?: number; exclude?: string[] }; result: SearchHit[] };
  "search.status": { params: {}; result: SearchStatus };
  /** Rebuild the transcript index from scratch; progress arrives as search.status events. Fails when search is off. */
  "search.reindex": { params: {}; result: null };
  /** Resume (or fork) a past session in a new pane, typed into the user's shell. */
  /**
   * Shell command that resumes an agent's session from anywhere (cd + env + the
   * agent's resume command), e.g. to copy; null if it has no resumable session.
   */
  "agent.resumeCommand": { params: { agentId: AgentId }; result: string | null };
  "agent.resume": {
    params: Placement & { agent: AgentKind; sessionId: string; cwd?: string | null; env?: Record<string, string> | null; fork?: boolean };
    result: Agent;
  };

  /** Persisted UI state, owned by the UI; the core only stores it. */
  "ui.get": { params: {}; result: Record<string, unknown> };
  /** null deletes the key. Values must be JSON, ≤ 64 KiB. */
  "ui.set": { params: { key: string; value: unknown }; result: null };

  /** After this call the connection receives `event` notifications. */
  "events.subscribe": {
    /** types: receive only these events (e.g. the Settings window wants settings.updated); omitted = all. */
    params: { types?: CoreEvent["type"][] };
    result: {
      panes: Pane[];
      agents: Agent[];
      /** Non-terminal windows (terminal windows are the panes). */
      windows: AppWindow[];
      /** Open Spaces in switcher order. */
      spaces: Space[];
      windowTypes: WindowTypeInfo[];
      settings: SettingsSnapshot;
      ui: Record<string, unknown>;
    };
  };
}

export type Method = keyof Methods;
export type Params<M extends Method> = Methods[M]["params"];
export type Result<M extends Method> = Methods[M]["result"];

export type CoreEvent =
  | { type: "pane.output"; paneId: PaneId; data: string }
  | { type: "pane.updated"; pane: Pane }
  | { type: "pane.removed"; paneId: PaneId }
  | { type: "agent.updated"; agent: Agent }
  | { type: "agent.removed"; agentId: AgentId }
  | { type: "settings.updated"; snapshot: SettingsSnapshot }
  | { type: "secrets.updated"; status: SecretsStatus }
  | { type: "search.status"; status: SearchStatus }
  | { type: "window.updated"; window: AppWindow }
  | { type: "window.removed"; id: WindowId }
  | { type: "space.updated"; space: Space }
  | { type: "space.removed"; id: SpaceId }
  /** Show this Space (cmd ., ⌘O from elsewhere); the app picks or creates the app window. */
  | { type: "space.show"; spaceId: SpaceId; newWindow: boolean }
  /** A Magic window's run: agent steps, the header, the body so far, done or failed. */
  | { type: "magic.stream"; id: WindowId; progress: MagicProgress }
  /** New data from a Magic widget's source (error: the source failed; the widget keeps its last data). */
  | { type: "magic.data"; id: WindowId; data: unknown; at: number; error?: string }
  /** A watched file or folder changed on disk (see fs.watch). */
  | { type: "fs.changed"; path: string }
  /** Bring a window to the front (e.g. `open .` in a terminal). */
  | { type: "window.focus"; id: WindowId }
  | { type: "notification"; notification: AppNotification };

export interface SearchHit {
  sessionId: string;
  agent: AgentKind;
  path: string;
  /** Environment the agent needs to resume this session (e.g. CLAUDE_CONFIG_DIR for a profile); null = none. */
  env: Record<string, string> | null;
  cwd: string | null;
  branch: string | null;
  title: string;
  updatedAt: number | null;
  /** Matching passage; \x01…\x02 mark highlighted terms. */
  snippet: string | null;
  fuzzy: boolean;
}

export interface SearchStatus {
  sessions: number;
  files: number;
  indexing: boolean;
  done: number;
  total: number;
}

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}
export interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}
export interface RpcNotification {
  jsonrpc: "2.0";
  method: "event";
  params: CoreEvent;
}
export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

/** Env vars injected into every pane. */
export const ENV = {
  socket: "CMD_SOCKET",
  paneId: "CMD_PANE_ID",
  agentId: "CMD_AGENT_ID",
  parentId: "CMD_PARENT_ID",
} as const;
