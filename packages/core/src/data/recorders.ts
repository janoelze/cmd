// What the core records as it happens because nothing else keeps it (docs/28
// §5): pages browser windows show and files windows open (a window's state only
// holds the current one), windows and workspaces opening and closing, notifications
// shown, agents' names. Commands are the CommandLog's, hook events the ActivityView's, git the
// journal's sync. Listens to the services' emitters, not the core's broadcast.

import path from "node:path";
import type { Agent, AppNotification, AppWindow, NameSource, Workspace } from "@cmd/protocol";
import { HOME_WORKSPACE_ID, outputLanguage } from "@cmd/protocol";
import { sessionIdOf, type AgentTracker } from "../agents/tracker.ts";
import { projectOf } from "../journal/backfill.ts";
import type { NotificationCenter } from "../notifications.ts";
import type { WorkspaceManager } from "../workspaces/manager.ts";
import type { WindowManager } from "../windows/manager.ts";
import type { DataService } from "./service.ts";
import { describeWorkspace, describeWindow } from "./describe.ts";
import { projectIdOf } from "./project.ts";
import type { SessionsView } from "./views/sessions.ts";

/** A page seen again within this long is the same visit (its title arrives after its URL). */
const VISIT_MS = 30 * 60_000;
const FILE_KINDS = new Set(["text", "markdown", "pdf", "files"]);

export function recordWindows(data: DataService, windows: WindowManager): void {
  const seen = new Set<string>();
  const closed = new Map<string, AppWindow>();
  windows.on("updated", (w: AppWindow) => {
    const now = Date.now();
    describeWindow(data, w);
    closed.set(w.id, w);
    if (!seen.has(w.id)) {
      seen.add(w.id);
      data.record({ id: `window:${w.id}:open`, at: w.createdAt || now, type: "window.open", source: "window", workspaceId: w.workspaceId, windowId: w.id, text: w.title || w.kind, data: { kind: w.kind, title: w.title } });
    }
    if (w.kind === "browser" && typeof w.state.url === "string" && /^https?:/.test(w.state.url)) {
      const url = w.state.url;
      const title = w.title && w.title !== url && w.title !== "Browser" ? w.title : null;
      data.record({ id: `visit:${w.id}:${url}:${Math.floor(now / VISIT_MS)}`, at: now, type: "browser.visit", source: "window", workspaceId: w.workspaceId, windowId: w.id, text: title ?? url, body: title, data: { url, title } });
    } else if (FILE_KINDS.has(w.kind) && typeof w.state.path === "string") {
      const p = w.state.path;
      const dir = w.kind === "files" ? p : path.dirname(p);
      data.record({ id: `file:${w.id}:${p}`, at: now, type: "file.open", source: "window", workspaceId: w.workspaceId, windowId: w.id, projectId: `dir:${projectOf(dir) ?? dir}`, text: p, data: { path: p, windowKind: w.kind } });
    }
  });
  windows.on("removed", (id: string) => {
    const w = closed.get(id);
    closed.delete(id);
    seen.delete(id);
    if (w) data.record({ id: `window:${id}:close:${Date.now()}`, at: Date.now(), type: "window.close", source: "window", workspaceId: w.workspaceId, windowId: id, text: w.title || w.kind, data: { kind: w.kind, title: w.title } });
  });
}

export function recordWorkspaces(data: DataService, workspaces: WorkspaceManager): void {
  const known = new Map<string, Workspace>();
  for (const s of workspaces.list()) known.set(s.id, s), describeWorkspace(data, s);
  workspaces.on("updated", (s: Workspace) => {
    describeWorkspace(data, s);
    const first = !known.has(s.id);
    known.set(s.id, s);
    if (first && s.id !== HOME_WORKSPACE_ID) data.record({ id: `workspace:${s.id}:open:${Date.now()}`, at: Date.now(), type: "workspace.open", source: "user", workspaceId: s.id, projectId: `dir:${projectOf(s.root) ?? s.root}`, text: s.name, data: { name: s.name, root: s.root } });
  });
  workspaces.on("removed", (id: string) => {
    const s = known.get(id);
    known.delete(id);
    if (s) data.record({ id: `workspace:${id}:close:${Date.now()}`, at: Date.now(), type: "workspace.close", source: "user", workspaceId: id, projectId: `dir:${projectOf(s.root) ?? s.root}`, text: s.name, data: { name: s.name, root: s.root } });
  });
}

export function recordNotifications(data: DataService, center: NotificationCenter): void {
  center.on("notification", (n: AppNotification) => {
    data.record({ id: `notification:${n.id}`, at: n.at, type: "notification", source: "cmd", workspaceId: n.workspaceId ?? null, paneId: n.paneId, windowId: n.windowId ?? null, text: n.title, body: n.body, data: { source: n.source, title: n.title, body: n.body, urgent: n.urgent, alert: n.alert } });
  });
}

/**
 * Agents' names as session.name events (docs/32-session-names.md), and into the
 * sessions view, so a name outlives its agent (Recent, the Journal, a resume).
 * An agent named before its session began is recorded again once it has one.
 */
export function recordNames(data: DataService, agents: AgentTracker, sessions: SessionsView): void {
  const recorded = new Map<string, string>();
  const record = (a: Agent, by: NameSource, was: string | null, reason: string) => {
    const sid = sessionIdOf(a);
    const key = sid ? `${a.kind}:${sid}` : null;
    const at = a.namedAt ?? Date.now();
    data.record({ id: `name:${a.id}:${key ?? "-"}:${at}`, at, type: "session.name", source: by === "user" ? "user" : "cmd", sessionId: key, agentId: a.id, paneId: a.paneId, workspaceId: a.workspaceId, projectId: projectIdOf(a.cwd), text: a.name, data: { name: a.name, by, lang: outputLanguage().code, was, reason } });
    if (key) sessions.applyName(key, a.name, by, at);
    recorded.set(a.id, `${key}|${a.name}`);
  };
  agents.on("named", (a, c) => record(a, c.by, c.was, c.reason));
  agents.on("updated", (a) => {
    const sid = sessionIdOf(a);
    if (!a.name || !sid || recorded.get(a.id) === `${a.kind}:${sid}|${a.name}`) return;
    record(a, a.nameBy ?? "user", null, "session");
  });
}
