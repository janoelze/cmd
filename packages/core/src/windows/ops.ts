// What happens to windows across services: opening one where a call belongs, reopening a
// closed one as it was (docs/11 ⇧⌘T), moving one with its agents, closing a workspace with
// everything in it, the selection's focus spans, and the shells' `open` requests.

import os from "node:os";
import type { AppWindow, Params, WindowId, WorkspaceId } from "@cmd/protocol";
import type { CoreContext } from "../kernel/context.ts";
import { isDir, restoredText } from "../terminals/restore.ts";
import { terminalWindow } from "./manager.ts";

type OpsCore = Pick<CoreContext, "windows" | "panes" | "agents" | "workspaces" | "closed" | "data" | "store" | "broadcast" | "opened" | "place" | "library">;

export class WindowOps {
  #core: OpsCore;
  /** Per workspace, the pane or window selected there and the focus event that says so (its span ends when the selection moves). */
  #focus = new Map<string, { id: string; eventId: string; at: number }>();
  /** Workspaces whose app window doesn't have focus: the selection to start a span on when it's back. */
  #away = new Map<string, string | null>();
  /** Workspaces being closed: their windows go with them, not as closed windows to reopen. */
  #closing = new Set<WorkspaceId>();

  constructor(core: OpsCore) {
    this.#core = core;
  }

  /** A window of `p.kind` where the call belongs. */
  open(p: Params<"window.open">): AppWindow {
    const { windows, place, opened } = this.#core;
    const input = p.input ?? {};
    const at = [input.cwd, input.path].find((v): v is string => typeof v === "string");
    const w = windows.open(p.kind, input, place(p, { path: at }));
    return opened(windows.others().find((x) => x.id === w.id) ?? w);
  }

  /** Move a window, a terminal with its agent tree, to another workspace. */
  move(id: WindowId, workspaceId: WorkspaceId): AppWindow {
    const { windows, panes, agents, workspaces } = this.#core;
    workspaces.mustOpen(workspaceId);
    const pane = panes.get(id);
    if (!pane) return windows.move(id, workspaceId);
    const agent = pane.agentId ? agents.get(pane.agentId) : null;
    if (agent) agents.moveTree(agent.id, workspaceId);
    else panes.setWorkspace(id, workspaceId);
    return terminalWindow(panes.get(id)!);
  }

  /** End a terminal, its screen saved first so it reopens as it looked. */
  async closeTerminal(id: WindowId): Promise<void> {
    await this.#core.panes.saveScreen(id).catch(() => {});
    this.#core.panes.kill(id);
  }

  async close(id: WindowId): Promise<void> {
    if (this.#core.panes.get(id)) await this.closeTerminal(id);
    else this.#core.windows.close(id);
  }

  /** Kill the workspace's terminals (their agents go with them) and remove its windows; keep it as a recent workspace. */
  closeWorkspace(id: WorkspaceId): void {
    const { workspaces, panes, agents, windows } = this.#core;
    const workspace = workspaces.mustOpen(id);
    if (workspace.home) throw new Error("Home can't be closed");
    // Its windows go with it, not one by one: none of them is a closed window to reopen.
    this.#closing.add(id);
    for (const p of panes.list()) if (p.workspaceId === id) panes.kill(p.id);
    for (const a of agents.list()) if (a.workspaceId === id && !a.paneId) agents.kill(a.id);
    for (const w of windows.inWorkspace(id)) windows.close(w.id);
    workspaces.markClosed(id);
    this.#closing.delete(id);
  }

  /** The selection in a workspace moved: the previous focus span ends, a new one starts (user.focus). While the app is away, only remembered. */
  focused(workspaceId: string, id: string): void {
    const prev = this.#focus.get(workspaceId);
    if (prev?.id === id) return;
    if (this.#away.has(workspaceId)) return void this.#away.set(workspaceId, id);
    this.#end(workspaceId);
    this.#start(workspaceId, id);
  }

  /**
   * Whether a workspace's app window has the person's focus (docs/49 "Gaps"): away, its focus
   * span ends; back, the selection's span starts again and every other workspace's ends, so
   * focus time is one span at a time and never runs while cmd is in the background.
   */
  present(workspaceId: string, present: boolean): void {
    if (!present) {
      const cur = this.#focus.get(workspaceId);
      this.#end(workspaceId);
      this.#away.set(workspaceId, cur?.id ?? this.#away.get(workspaceId) ?? null);
      return;
    }
    for (const other of [...this.#focus.keys()]) if (other !== workspaceId) this.#away.set(other, this.#focus.get(other)!.id), this.#end(other);
    const sel = this.#away.get(workspaceId);
    this.#away.delete(workspaceId);
    if (sel && !this.#focus.has(workspaceId)) this.#start(workspaceId, sel);
  }

  #end(workspaceId: string): void {
    const prev = this.#focus.get(workspaceId);
    if (!prev) return;
    const { data, panes } = this.#core;
    data.record({ id: prev.eventId, at: prev.at, until: Date.now(), type: "user.focus", source: "user", workspaceId, ...(panes.get(prev.id) ? { paneId: prev.id, data: { paneId: prev.id } } : { windowId: prev.id, data: { windowId: prev.id } }) });
    this.#focus.delete(workspaceId);
  }

  #start(workspaceId: string, id: string): void {
    const { data, panes } = this.#core;
    const now = Date.now();
    const eventId = `focus:${workspaceId}:${id}:${now}`;
    const pane = panes.get(id);
    data.record({ id: eventId, at: now, type: "user.focus", source: "user", workspaceId, ...(pane ? { paneId: id, agentId: pane.agentId, data: { paneId: id } } : { windowId: id, data: { windowId: id } }) });
    this.#focus.set(workspaceId, { id, eventId, at: now });
  }

  /**
   * Reopen a closed window under its old id, in its workspace (else the caller's,
   * else Home). A terminal is a new shell in its folder with its last screen; it
   * runs nothing, not even what was running when it closed.
   */
  reopen(p: Params<"window.reopen">): AppWindow | null {
    const { closed, panes, windows, workspaces, place, opened, broadcast } = this.#core;
    const rec = p.id ? closed.get(p.id) : closed.latest(p.workspaceId ?? workspaces.home().id);
    if (!rec) return null;
    if (panes.get(rec.id) || windows.others().some((w) => w.id === rec.id)) {
      closed.take(rec.id);
      return null;
    }
    const kept = workspaces.get(rec.workspaceId);
    const workspace = kept && kept.closedAt === null ? kept : place({ workspaceId: p.workspaceId });
    let w: AppWindow;
    if (rec.terminal) {
      const t = rec.terminal;
      const cwd = isDir(t.cwd) ? t.cwd : isDir(workspace.root) ? workspace.root : os.homedir();
      const pane = panes.create({
        id: rec.id,
        workspaceId: workspace.id,
        cwd,
        cols: t.cols,
        rows: t.rows,
        replay: restoredText(t.screen, t.command, cwd === t.cwd ? null : { was: t.cwd, now: cwd }, "Reopened"),
        restored: { title: rec.title, createdAt: t.createdAt, muted: t.muted, attention: null },
      });
      w = terminalWindow(pane);
    } else if (rec.window) {
      w = windows.restore({ ...rec.window, workspaceId: workspace.id });
    } else {
      closed.forget(rec.id);
      return null;
    }
    closed.take(rec.id);
    opened(w);
    broadcast({ type: "window.focus", id: w.id });
    return windows.list().find((x) => x.id === w.id) ?? w;
  }

  /** A window closed in this workspace can be reopened: not one closed with its workspace (its terminals end after it is marked closed). */
  #keepsClosed(workspaceId: WorkspaceId): boolean {
    return !this.#closing.has(workspaceId) && this.#core.workspaces.get(workspaceId)?.closedAt === null;
  }

  /** A closed window becomes one to reopen (or goes, with its state, when it can't come back). */
  watchWindows(): void {
    const { windows, closed, store, broadcast } = this.#core;
    windows.on("removed", (id, w) => {
      if (this.#keepsClosed(w.workspaceId)) {
        closed.add({ id, workspaceId: w.workspaceId, kind: w.kind, title: w.title, closedAt: Date.now(), window: w, terminal: null });
        // A Magic window that never made anything (a request, a build stopped by closing it): nothing to reopen.
        if (w.kind === "magic" && w.state.phase !== "ready") queueMicrotask(() => closed.forget(id));
      } else store.deleteUiStateOf(id);
      broadcast({ type: "window.removed", id });
      this.#core.library.changed();
    });
  }

  /** A closed terminal too, with its last screen; registered after the services' own listeners (see watchAgents). */
  watchTerminals(): void {
    const { panes, closed, store, broadcast } = this.#core;
    panes.on("removed", (paneId, { pane, record, screen }) => {
      if (this.#keepsClosed(pane.workspaceId)) {
        const terminal = { cwd: pane.cwd, cols: record.cols, rows: record.rows, createdAt: pane.createdAt, muted: pane.muted, command: record.command, screen };
        closed.add({ id: paneId, workspaceId: pane.workspaceId, kind: "terminal", title: pane.title, closedAt: Date.now(), window: null, terminal });
      } else {
        store.deleteUiStateOf(paneId);
        panes.forgetHistory(paneId);
      }
      broadcast({ type: "pane.removed", paneId });
    });
  }

  /** Requests from a pane's shell integration, e.g. `open .` → file window in the pane's workspace. */
  watchShells(): void {
    const { panes, windows, place, opened, broadcast } = this.#core;
    panes.on("request", (paneId, action, arg) => {
      if (action !== "open" || !arg) return;
      try {
        const w = opened(windows.openTarget(arg, place({ callerPaneId: paneId })));
        if (w) broadcast({ type: "window.focus", id: w.id });
      } catch {
        // not a folder / URL: ignore
      }
    });
  }

  /** Windows of a workspace that is gone or closed (e.g. the core died mid-close) go Home. */
  homeless(): void {
    const { windows, workspaces } = this.#core;
    for (const w of windows.others()) {
      if (workspaces.get(w.workspaceId)?.closedAt !== null) windows.move(w.id, workspaces.home().id);
    }
  }
}
