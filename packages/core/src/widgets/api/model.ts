// The core's things in the widget API's words (docs/56, principle 1: "widgets speak the
// product's vocabulary, never the core's"): agents, terminals, windows, workspaces and events
// as protocol widget-tree.ts's Api* shapes. When the core's model moves, this file moves with
// it and no widget notices.

import path from "node:path";
import { agentIcon, agentLight, bucketOf, type ActionsList, type Agent, type ApiAction, type ApiActionSource, type ApiAgent, type ApiAgentState, type ApiEvent, type ApiTerminal, type ApiWindow, type ApiWorkspace, type AppWindow, type DataEvent, type Pane, type WireValue, type Workspace, type WorkspaceAction } from "@cmd/protocol";

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

/**
 * A Workspace Action with its latest run in the folder (`runs`: the list's, from any window).
 * 1.3: where it came from, relative to the list's root (never an absolute path), and the same
 * action running in the repository's other worktrees, those whose terminal `sees` (the widget's reach).
 */
export function apiAction(a: WorkspaceAction, list: Pick<ActionsList, "runs" | "primary"> & Partial<Pick<ActionsList, "root" | "elsewhere">>, sees: (paneId: string) => boolean = () => true): ApiAction {
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
    script: a.script && a.script !== a.command ? a.script : null,
    args: !!a.args,
    hidden: !!a.hidden,
    source: apiSource(a, list.root ?? null),
    history: a.history ? { runs: a.history.runs } : null,
    startedAt: run?.startedAt ?? null,
    endedAt: run?.endedAt ?? null,
    elsewhere: (list.elsewhere ?? []).filter((x) => x.actionId === a.id && x.endedAt === null && sees(x.paneId)).map((x) => ({ branch: x.branch, terminalId: x.paneId, url: x.url })),
  };
}

/** A path for a widget: relative to the root, or null when it isn't inside it (never an absolute path). */
export function relativeIn(root: string | null, file: string): string | null {
  if (!file) return null;
  const rel = (path.isAbsolute(file) ? (root ? path.relative(root, file) : "") : path.normalize(file)).replace(/\/+$/, "");
  if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel;
}

function apiSource(a: WorkspaceAction, root: string | null): ApiActionSource {
  if (a.source.kind === "history") return { kind: "history", file: null, line: null };
  if (a.source.kind === "readme") return { kind: "readme", file: relativeIn(root, a.source.file), line: a.source.line ?? null };
  // A folder of scripts is listed as itself ("scripts/"): kept with its slash.
  const file = relativeIn(root, a.source.file);
  return { kind: "file", file: file && a.source.file.endsWith("/") ? `${file}/` : file, line: a.source.line ?? null };
}
