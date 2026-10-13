// The tools (docs/54): task-shaped verbs over the core's methods that a model calls (an agent in
// a pane through `cmd mcp` or `cmd tool`, the Operator), whoever calls them under one access
// table. What a call waiting for the person looks like, the approvals remembered per workspace,
// and the methods for both. The tools themselves live in the core (packages/core/src/tools/).

import type { PaneId, WindowId, WorkspaceId } from "./model.ts";

/** An approval the person chose to remember for a workspace: this kind of action runs without asking there. */
export interface RememberedApproval {
  key: string;
  /** What it allows, in words ("commands starting “pnpm test”"). */
  label: string;
  at: number;
}

/** A tool as a caller sees it (tools.list): MCP's tool, with hints derived from the access table. */
export interface ToolInfo {
  name: string;
  description: string;
  /** JSON Schema of its input (an object). */
  inputSchema: Record<string, unknown>;
  /** It changes something (marked on the board, one at a time per caller). */
  acts: boolean;
  /** Every method it calls only reads. */
  readOnly: boolean;
  /** It calls a method that asks the person first (typing into a terminal, acting on a page, stopping an agent). */
  destructive: boolean;
}

/**
 * Who calls (tools.list, tools.call): an agent's pane, proven by the pane's CMD_PANE_TOKEN; else
 * found from `pids`, the caller's process and its ancestors, when its env didn't reach it. A
 * caller without the token gets only the tools that read.
 */
export interface ToolCaller {
  paneId?: PaneId | null;
  token?: string | null;
  pids?: number[];
}

export type ToolCallState = "running" | "waiting" | "done" | "failed" | "denied";

/** A tool call the board shows: the window acted on lights up and says who acts; one waiting for the person can be answered there. */
export interface ToolActivity {
  /** The call's id; approvals.answer takes it. */
  id: string;
  workspaceId: WorkspaceId;
  /** Who calls, as people say it ("Claude “Bug hunt”", "Operator"). */
  caller: string;
  /** The caller's own window (its pane, its widget). */
  callerWindowId: WindowId | null;
  tool: string;
  /** One line on what this step does. */
  why: string;
  acts: boolean;
  /** The window it acts on, else null. */
  target: WindowId | null;
  state: ToolCallState;
  /** While waiting: what it asks, in words and exactly, and what Always Allow would remember. */
  approval?: { title: string; exact?: string; offer?: string };
}

/** A tool call started, waits for the person, or ended. Part of CoreEvent (rpc.ts). */
export type ToolsEvent = { type: "tool.acting"; call: ToolActivity };

/** The tools' RPC methods, part of `Methods` (rpc.ts). */
export interface ToolsMethods {
  /**
   * The tools this caller may use, with what an MCP server says about them (`instructions`).
   * None when Agent integration is off, or outside a cmd pane (`paneId` null).
   */
  "tools.list": { params: ToolCaller; result: { paneId: PaneId | null; tools: ToolInfo[]; instructions: string } };
  /** Runs a tool for a caller, checked against the access table; waits for the person's approval when it must. */
  "tools.call": { params: ToolCaller & { name: string; input: Record<string, unknown> }; result: { output: string; isError: boolean } };
  /** Tool calls waiting for the person now (the app asks again after it reconnects). */
  "approvals.waiting": { params: {}; result: ToolActivity[] };
  /**
   * Allow or deny a tool call waiting for the person's approval (`itemId`: the call's id);
   * `reason` goes back to the caller with a denial. `remember`: allow this kind of action in
   * the workspace from now on (the approval's `offer`).
   */
  "approvals.answer": { params: { workspaceId: WorkspaceId; itemId: string; allow: boolean; reason?: string; remember?: boolean }; result: null };
  /** The approvals remembered for a workspace, newest first. */
  "approvals.list": { params: { workspaceId: WorkspaceId }; result: RememberedApproval[] };
  /** Forget a remembered approval: that kind of action asks again. */
  "approvals.forget": { params: { workspaceId: WorkspaceId; key: string }; result: null };
}
