// Helpers the built-in list widgets share (Commands, Notifications, Resources):
// their scope menu, their summary in the title bar, going to what a row is
// about, and durations. Their look is @cmd/ui's Panel, ListSection and ListRow;
// no header of their own: the title bar names them and its menu has their options.

import { useEffect } from "react";
import type { AppWindow, WorkspaceId, WindowId } from "@cmd/protocol";
import { setWindowStatus } from "./windowActions.ts";
import type { MenuEntry } from "./context.ts";
import { selectPane } from "./actions.ts";
import { showWorkspace } from "../shell/workspaces.tsx";
import { getState } from "./store.ts";
import { cmd } from "./bridge.ts";

export type Scope = "workspace" | "all";

export const scopeOf = (v: unknown): Scope => (v === "all" ? "all" : "workspace");

/** Patch a widget window's state. */
export const setWidgetState = (id: WindowId, state: Record<string, unknown>) => void cmd.call("window.update", { id, state }).catch(() => {});

/** This Workspace / All Workspaces. */
export function scopeMenu(id: WindowId, scope: Scope): MenuEntry[] {
  return [
    { label: "This Workspace", checked: scope === "workspace", run: () => setWidgetState(id, { scope: "workspace" }) },
    { label: "All Workspaces", checked: scope === "all", run: () => setWidgetState(id, { scope: "all" }) },
  ];
}

// List widgets: the title bar's menu (titleMenu) switches their scope and has their
// options; the same entries are on right-click. Their summary is the title bar's status.
export const scopeLabel = (w: AppWindow) => (scopeOf(w.state.scope) === "all" ? "All Workspaces" : "This Workspace");
export const scoped = (extra: (w: AppWindow) => MenuEntry[]) => (w: AppWindow) => [...scopeMenu(w.id, scopeOf(w.state.scope)), "-" as const, ...extra(w)];

/** Show a terminal or window: here, or in its own workspace. */
export function goTo(id: WindowId, workspaceId: WorkspaceId | undefined): void {
  if (!workspaceId || workspaceId === getState().workspaceId) selectPane(id);
  else showWorkspace(workspaceId, { select: id });
}

/** "4 s", "7 min" (protocol format.ts, which widgets' `fmt.dur(s, { coarse: true })` is too). */
export { durationText } from "@cmd/protocol";

/** A widget's one-line summary ("1 failed", "ends 14:30") in its title bar; null: none. */
export function useWidgetStatus(id: WindowId, label: string | null, key?: string): void {
  useEffect(() => setWindowStatus(id, label ? { label, key: key ?? label } : null), [id, label, key]);
  useEffect(() => () => setWindowStatus(id, null), [id]);
}
