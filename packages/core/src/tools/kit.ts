// What the tools share (docs/54): the context they run with (ToolContext: the caller, the
// workspace, its methods checked against TOOL_ACCESS, the window refs), the shape of a tool and
// of an approval, the input schema every tool starts from (with its `why`), and helpers for
// windows, agents and paths in the workspace.

import path from "node:path";
import type { Agent, AgentId, AppWindow, Method, PaneId, Params, Permission, Result, WindowId, Workspace, WorkspaceId } from "@cmd/protocol";
import type { ToolSpec } from "../magic/tools.ts";
import { isDeniedPath, remotePrivatePaths } from "../lib/paths-deny.ts";
import type { Refs } from "./board.ts";

/** Who calls a tool: an agent (a coding agent in a pane, or a model in a widget) or the person. */
export interface Caller {
  kind: "agent" | "person";
  workspaceId: WorkspaceId;
  /** As the board's acting mark names it ("Claude “Bug hunt”"). */
  name: string;
  /** The caller's own window (its pane, or its widget): listed as itself, never closed or typed into. */
  windowId?: WindowId | null;
  /** The coding agent calling, and its pane. */
  agentId?: AgentId | null;
  paneId?: PaneId | null;
}

/** What tools run with: the caller, its workspace, the core's methods (checked against TOOL_ACCESS), the refs. */
export interface ToolContext {
  caller: Caller;
  workspace: () => Workspace;
  call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>>;
  refs: Refs;
  /** What it started reports back: an agent when done, failed or needing input; a command when it ends, a server its address. */
  started?: { agent(agentId: string): void; command(paneId: string, label: string): void };
  /** Windows the caller opened itself (closing those is showing things, not stopping them). */
  opened?: Set<string>;
  /** The next reports of what it started (reports.ts): at once if some are waiting, else when one comes, or none after `ms`. */
  reports?(ms: number, signal?: AbortSignal): Promise<string[]>;
  signal: AbortSignal;
}

export interface Tool {
  spec: ToolSpec;
  /** It changes something: marked on the board, never run beside another act. */
  acts: boolean;
  /** The methods it may call (TOOL_ACCESS decides each; MCP's hints are derived from them; tools.test.ts checks them against the code). */
  calls: readonly Method[];
  /** Who may call it; left out: every caller. Coding agents edit files themselves, so `edit` is only for models without their own tools. */
  for?: "models";
  /** The window it is about, for the board's mark. */
  target?(input: Input, b: ToolContext): WindowId | null;
  /** What the call would do, for approvals.ts to decide on (every tool that acts has one; null: nothing to decide). Throws to refuse outright. */
  confirm?(input: Input, b: ToolContext): Promise<Approval | null>;
  run(input: Input, b: ToolContext): Promise<string>;
}

export type Input = Record<string, unknown>;

/**
 * What a call that acts would do, for deciding whether it runs (approvals.ts) and for asking: the
 * kind of action (docs/55), in words (`title`, naming windows as people do), and exactly what would
 * happen (`exact`: the text, the URL, a diff). `site`: what a yes is kept for beside the
 * permission (the site, for websites and pages; the action, for a risky one). `risky` always
 * asks and is never kept for always; `free` never asks (a page on this Mac).
 */
export interface Approval {
  permission: Permission;
  title: string;
  exact?: string;
  site?: string;
  risky?: boolean;
  free?: boolean;
}

const why = { type: "string", description: "One short line for the person watching, saying what this step does and why, in their words, e.g. \"Running the tests to see what fails\". Name windows by what they are, never by ref." };
export const ref = { type: "string", description: "A window's ref from look: w1, w2… (for tools only; never write refs to the person)." };
export const schema = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: { why, ...props }, required: ["why", ...required], additionalProperties: false });

export const str = (v: unknown) => (typeof v === "string" ? v : undefined);
export const num = (v: unknown, d: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : d);

/** The workspace's windows, panes and agents, read through the bench. */
export async function board(b: ToolContext) {
  const [windows, panes, agents] = await Promise.all([b.call("window.list", {}), b.call("pane.list", {}), b.call("agent.list", {})]);
  return { workspace: b.workspace(), windows, panes, agents, self: b.caller.windowId ?? null };
}

export async function windowOf(b: ToolContext, r: unknown): Promise<AppWindow> {
  const id = b.refs.id(r);
  const w = (await b.call("window.list", {})).find((x) => x.id === id);
  if (!w) throw new Error(`${String(r)} is closed: look again`);
  if (w.workspaceId !== b.workspace().id) throw new Error(`${String(r)} is in another workspace`);
  return w;
}

/** A window to act on: never the caller's own. */
export async function otherWindow(b: ToolContext, r: unknown, what: string): Promise<AppWindow> {
  const w = await windowOf(b, r);
  if (w.id === b.caller.windowId) throw new Error(`${String(r)} is your own window: you can't ${what} it`);
  return w;
}

const KIND_NAMES: Record<string, string> = { text: "editor", files: "file browser", markdown: "Markdown window", json: "JSON viewer", diff: "Live Diff", actions: "Workspace Actions" };

/** A window as people say it: the terminal “tests”, the editor “README.md”. */
export const windowName = (w: AppWindow) => `the ${KIND_NAMES[w.kind] ?? w.kind} “${w.title}”`;

export async function agentIn(b: ToolContext, w: AppWindow): Promise<Agent | null> {
  if (w.kind !== "terminal") return null;
  const pane = (await b.call("pane.list", {})).find((p) => p.id === w.id);
  return pane?.agentId ? ((await b.call("agent.list", {})).find((a) => a.id === pane.agentId) ?? null) : null;
}

/** A path for reading: inside the workspace's folder, never a private one. */
export function readablePath(b: ToolContext, p: string): string {
  const root = b.workspace().root;
  const abs = path.resolve(root, p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`${p} is outside the workspace's folder (${root})`);
  if (isDeniedPath(abs, remotePrivatePaths())) throw new Error(`${p} stays private`);
  return abs;
}

export const fmtTime = (at: number) => new Date(at).toTimeString().slice(0, 5);
