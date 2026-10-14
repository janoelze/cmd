// The tools (docs/54): task-shaped verbs over the core's methods that a model calls (an agent in
// a pane through `cmd mcp` or `cmd tool`, or a model in a widget), whoever calls them under one access
// table. What a call waiting for the person looks like, the approvals remembered per workspace,
// and the methods for both. The tools themselves live in the core (packages/core/src/tools/).

import type { PaneId, WindowId, WorkspaceId } from "./model.ts";
import type { SettingDef as Def } from "./settings.ts";

/**
 * The kinds of action a tool call can be (docs/55), each with a level in Settings → Agents →
 * Permissions (`agents.permissions.<id>`): ask, allow or never. Reading the workspace is not one:
 * it is always allowed.
 */
export const PERMISSIONS = [
  { id: "web", title: "Open websites", default: "ask", bySite: true, description: "Open a page in a browser window. Pages on this Mac never ask." },
  { id: "type", title: "Type into terminals and agents", default: "ask", bySite: false, description: "Commands and keys in a terminal, messages to another agent." },
  { id: "page", title: "Act on web pages", default: "ask", bySite: true, description: "Click, fill in, choose and submit on a page." },
  { id: "stop", title: "Stop agents and close windows", default: "ask", bySite: false, description: "Windows it didn't open itself." },
  { id: "run", title: "Run project commands", default: "allow", bySite: false, description: "Workspace Actions. Risky ones, like deploys, always ask." },
  { id: "agents", title: "Start agents", default: "allow", bySite: false, description: "Another coding agent, in a terminal of its own." },
  { id: "show", title: "Show things", default: "allow", bySite: false, description: "Open files, folders and terminals, focus and arrange windows." },
  { id: "edit", title: "Edit files", default: "ask", bySite: false, description: "Only the Operator: agents edit files with their own tools." },
] as const;

export type Permission = (typeof PERMISSIONS)[number]["id"];
export type PermissionLevel = "ask" | "allow" | "never";
/** How long a yes holds: this call, the caller's session (until the agent exits), or always in the workspace. */
export type ApprovalScope = "once" | "session" | "always";

export const permissionOf = (id: string) => PERMISSIONS.find((p) => p.id === id);

const LEVELS = { type: "enum", options: ["ask", "allow", "never"], labels: { ask: "Ask", allow: "Allow", never: "Never" } } as const;

/** Each permission's level, in Settings → Agents → Permissions (part of SETTINGS_SCHEMA). */
export const PERMISSION_SETTINGS = {
  "agents.permissions.web": { title: "Open websites", ...LEVELS, default: "ask", description: "Pages on this Mac never ask." },
  "agents.permissions.type": { title: "Type into terminals and agents", ...LEVELS, default: "ask", description: "Commands, keys and messages to other agents." },
  "agents.permissions.page": { title: "Act on web pages", ...LEVELS, default: "ask", description: "Click, fill in, choose and submit." },
  "agents.permissions.stop": { title: "Stop agents and close windows", ...LEVELS, default: "ask", description: "Windows it didn't open itself." },
  "agents.permissions.run": { title: "Run project commands", ...LEVELS, default: "allow", description: "Risky ones, like deploys, always ask." },
  "agents.permissions.agents": { title: "Start agents", ...LEVELS, default: "allow", description: "In a terminal of their own." },
  "agents.permissions.show": { title: "Show things", ...LEVELS, default: "allow", description: "Open files, folders and terminals, arrange windows." },
  "agents.permissions.edit": { title: "Edit files", ...LEVELS, default: "ask", description: "The Operator only: agents edit files themselves." },
} as const satisfies Record<`agents.permissions.${Permission}`, Def>;

/** What a remembered or asked approval is about: a kind of action, and the site for those remembered by site. */
export const approvalKey = (permission: Permission, site?: string | null) => (site ? `${permission}:${site}` : permission);
/** "Open websites: github.com". */
export const approvalLabel = (permission: Permission, site?: string | null) => `${permissionOf(permission)?.title ?? permission}${site ? `: ${site}` : ""}`;

/** What a yes for a widget package is kept under: the permission, for that package alone ("run:widget/ci-runs"; a package name has no "/"). */
export const widgetApprovalKey = (permission: Permission, pkg: string) => `${permission}:widget/${pkg}`;
/** "Run project commands, for the widget ci-runs". */
export const widgetApprovalLabel = (permission: Permission, pkg: string) => `${permissionOf(permission)?.title ?? permission}, for the widget ${pkg}`;

/** An approval the person chose to keep for a workspace: this kind of action (on this site) runs without asking there. */
export interface RememberedApproval {
  workspaceId: WorkspaceId;
  /** `approvalKey`: the permission, and the site where it is by site. */
  key: string;
  /** What it allows, in words ("Open websites: github.com"). */
  label: string;
  at: number;
}

/** A call the person said no to, lately (Settings → Agents → Permissions, Recently denied). */
export interface DeniedCall {
  id: string;
  at: number;
  workspaceId: WorkspaceId;
  caller: string;
  /** What it asked, in words. */
  title: string;
  reason: string | null;
  permission: Permission | null;
  site: string | null;
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

/** A widget package asking (docs/56, phase 4): a yes is kept for it alone, in its workspace; "this session" lasts while its window is open. */
export interface ToolWidget {
  /** package.json's name and version. */
  name: string;
  version: string;
  /** The widget's title in the Library ("CI"). */
  title: string;
  /** Its SF Symbol. */
  icon: string;
}

export type ToolCallState = "running" | "waiting" | "done" | "failed" | "denied";

/** A tool call the board shows: the window acted on lights up and says who acts; one waiting for the person can be answered there. */
export interface ToolActivity {
  /** The call's id; approvals.answer takes it. */
  id: string;
  workspaceId: WorkspaceId;
  /** Who calls, as people say it ("Claude “Bug hunt”"). */
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
  /** The caller's kind ("claude", "codex", "operator"), for its icon. */
  callerKind?: string;
  /** While waiting: what it asks, in words and exactly, the kind of action and its site, and how long a yes may hold. */
  approval?: { title: string; exact?: string; permission: Permission; site?: string; risky?: boolean; scopes: ApprovalScope[]; widget?: ToolWidget };
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
   * `reason` goes back to the caller with a denial. `scope`: how long a yes holds (once, the
   * caller's session, always in the workspace), one of the approval's `scopes`.
   */
  "approvals.answer": { params: { workspaceId: WorkspaceId; itemId: string; allow: boolean; reason?: string; scope?: ApprovalScope }; result: null };
  /** The approvals kept for a workspace (every workspace without one), newest first. */
  "approvals.list": { params: { workspaceId?: WorkspaceId }; result: RememberedApproval[] };
  /** Keep one: this kind of action (on this site) runs without asking in the workspace (Recently denied's "Allow from now on"). */
  "approvals.allow": { params: { workspaceId: WorkspaceId; permission: Permission; site?: string | null }; result: null };
  /** Forget a kept approval: that kind of action asks again. */
  "approvals.forget": { params: { workspaceId: WorkspaceId; key: string }; result: null };
  /** Calls the person said no to lately, newest first. */
  "approvals.denied": { params: { limit?: number }; result: DeniedCall[] };
}
