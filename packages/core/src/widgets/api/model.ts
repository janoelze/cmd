// The core's things in the widget API's words (docs/56, principle 1: "widgets speak the
// product's vocabulary, never the core's"): agents, terminals, windows, workspaces and events
// as protocol widget-tree.ts's Api* shapes. When the core's model moves, this file moves with
// it and no widget notices.

import path from "node:path";
import { agentIcon, agentLight, bucketOf, type ActionsList, type Agent, type ApiAction, type ApiAgent, type ApiAgentState, type ApiEvent, type ApiTerminal, type ApiWindow, type ApiWorkspace, type AppWindow, type DataEvent, type Pane, type WireValue, type Workspace, type WorkspaceAction } from "@cmd/protocol";

const STATE: Record<Agent["state"], ApiAgentState> = { starting: "starting", working: "working", idle: "idle", needs_input: "waiting", done: "done", exited: "exited", failed: "failed" };

/** An agent; `byId` finds its hosts, for a subagent that lives in its host's terminal. */
export function apiAgent(a: Agent, byId: (id: string) => Agent | null): ApiAgent {
  let host: Agent | null = a;
  while (host && !host.paneId && host.parentId) host = byId(host.parentId);
  const state = STATE[a.state] ?? "idle";
  const bucket = bucketOf(a);
  return {
    id: a.id,
    name: a.name ?? a.kind.charAt(0).toUpperCase() + a.kind.slice(1),
    kind: a.kind,
    state,
    stateSince: a.stateSince,
    bucket,
    light: agentLight(state, bucket),
    icon: agentIcon(a.kind),
    statusLine: a.detail,
    place: a.git?.branch ?? (path.basename(a.git?.top ?? a.cwd) || null),
    cwd: a.cwd,
    workspaceId: a.workspaceId,
    windowId: host?.paneId ?? null,
    terminalId: a.paneId,
    parentId: a.parentId,
    depth: a.depth,
  };
}

export function apiTerminal(p: Pane, command: string | null): ApiTerminal {
  return { id: p.id, title: p.title, cwd: p.cwd, workspaceId: p.workspaceId, windowId: p.id, command, agentId: p.agentId };
}

export function apiWindow(w: AppWindow, selected: string | null): ApiWindow {
  return { id: w.id, kind: w.kind, title: w.title, workspaceId: w.workspaceId, selected: w.id === selected };
}

/** The window a workspace has selected (the board's selection, kept in its view). */
export const selectedIn = (ws: Workspace | undefined): string | null => (typeof ws?.view["selection.pane"] === "string" ? (ws.view["selection.pane"] as string) : null);

export function apiWorkspace(ws: Workspace, branch: string | null): ApiWorkspace {
  return { id: ws.id, name: ws.name, root: ws.root || null, branch };
}

export function apiEvent(e: DataEvent): ApiEvent {
  return { id: e.seq, at: e.at, type: e.type, workspaceId: e.workspaceId, data: (e.data ?? {}) as { [key: string]: WireValue }, key: e.id, until: e.until ?? null, terminalId: e.paneId ?? null, text: e.text ?? null, windowId: e.windowId ?? null };
}

/** A Workspace Action with its latest run in the folder (`runs`: the list's, from any window). */
export function apiAction(a: WorkspaceAction, list: Pick<ActionsList, "runs" | "primary">): ApiAction {
  const run = list.runs.filter((r) => r.actionId === a.id).sort((x, y) => y.startedAt - x.startedAt)[0];
  const running = !!run && run.endedAt === null;
  return {
    name: a.name,
    title: a.description ?? a.command,
    risky: a.risky,
    command: a.command,
    kind: a.kind,
    package: a.package ?? null,
    pinned: !!a.pinned,
    primary: list.primary === a.id,
    running,
    terminalId: run?.paneId ?? null,
    url: running ? (run.url ?? a.url ?? null) : null,
    exitCode: run && run.endedAt !== null ? run.exitCode : null,
  };
}
