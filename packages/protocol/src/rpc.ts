// Core API. Transport: newline-delimited JSON-RPC 2.0 over a Unix socket.
// Every method is reachable from the UI, the `cmd` CLI and (later) MCP.

import type { Agent, AgentId, AgentKind, AgentState, AppNotification, AppWindow, FileEntry, Pane, PaneId, WindowId, WindowTypeInfo } from "./model.ts";
import type { SettingKey, Settings } from "./settings.ts";

export interface SettingsSnapshot {
  settings: Settings;
  /** Keys set explicitly in the user's file. */
  overrides: SettingKey[];
  /** Validation problems in the user's file (those entries are ignored). */
  errors: string[];
  path: string;
}

export interface Methods {
  "core.hello": { params: {}; result: { version: string; pid: number; socket: string; build: string } };

  "pane.create": {
    params: { cwd?: string; command?: string; cols?: number; rows?: number; env?: Record<string, string> };
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
  /** Raw recent output, for re-attaching a view after a UI reload. */
  "pane.snapshot": { params: { paneId: PaneId }; result: { data: string } };
  /** Clear stuck terminal state (modes a crashed program left on). */
  "pane.reset": { params: { paneId: PaneId }; result: null };
  /** Plain-text tail of the pane, as displayed. */
  "pane.read": { params: { paneId: PaneId; lines?: number }; result: { text: string } };

  "agent.list": { params: {}; result: Agent[] };
  "agent.spawn": {
    params: {
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

  /**
   * Open a window of a registered type. `input` is the type's create input:
   * terminal { cwd?, command? }, browser { url? }, files { path? }, text { path }.
   */
  "window.open": { params: { kind: string; input?: Record<string, unknown> }; result: AppWindow };
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
  "window.openTarget": { params: { target: string }; result: AppWindow | null };
  /** All windows, terminals included. */
  "window.list": { params: {}; result: AppWindow[] };

  /** Directory listing for file windows (dirs first, then by name). */
  "fs.list": { params: { path: string }; result: { path: string; parent: string | null; entries: FileEntry[] } };
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

  /** Full-text search over Claude Code / Codex transcripts. */
  "search.query": { params: { text: string; limit?: number }; result: SearchHit[] };
  "search.status": { params: {}; result: SearchStatus };
  /** Resume (or fork) a past session in a new pane, typed into the user's shell. */
  "agent.resume": {
    params: { agent: "claude" | "codex"; sessionId: string; cwd?: string | null; configDir?: string | null; fork?: boolean };
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
  | { type: "search.status"; status: SearchStatus }
  | { type: "window.updated"; window: AppWindow }
  | { type: "window.removed"; id: WindowId }
  /** A watched file or folder changed on disk (see fs.watch). */
  | { type: "fs.changed"; path: string }
  /** Bring a window to the front (e.g. `open .` in a terminal). */
  | { type: "window.focus"; id: WindowId }
  | { type: "notification"; notification: AppNotification };

export interface SearchHit {
  sessionId: string;
  agent: "claude" | "codex";
  path: string;
  configDir: string | null;
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
