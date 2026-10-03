// Core API. Transport: newline-delimited JSON-RPC 2.0 over a Unix socket.
// Every method is reachable from the UI, the `cmd` CLI and (later) MCP.

import type { Agent, AgentId, AgentKind, AgentState, Pane, PaneId } from "./model.ts";
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
  /** Raw recent output, for re-attaching a view after a UI reload. */
  "pane.snapshot": { params: { paneId: PaneId }; result: { data: string } };
  /** Plain-text tail of the pane (ANSI stripped). */
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
    params: {};
    result: { panes: Pane[]; agents: Agent[]; settings: SettingsSnapshot; ui: Record<string, unknown> };
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
  | { type: "search.status"; status: SearchStatus };

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
