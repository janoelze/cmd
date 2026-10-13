// The tools (docs/54): task-shaped verbs over the core's methods that a model calls (an agent in
// a pane through `cmd mcp` or `cmd tool`, the Operator), whoever calls them under one access
// table. What a call waiting for the person looks like, the approvals remembered per workspace,
// and the methods for both. The tools themselves live in the core (packages/core/src/tools/).

import type { WorkspaceId } from "./model.ts";

/** An approval the person chose to remember for a workspace: this kind of action runs without asking there. */
export interface RememberedApproval {
  key: string;
  /** What it allows, in words ("commands starting “pnpm test”"). */
  label: string;
  at: number;
}

/** The tools' RPC methods, part of `Methods` (rpc.ts). */
export interface ToolsMethods {
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
