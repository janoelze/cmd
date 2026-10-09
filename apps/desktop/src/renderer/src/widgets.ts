// Helpers the built-in list widgets share (Commands, Notifications, Resources):
// their scope menu, their summary in the title bar, going to what a row is
// about, and durations. Their look is @cmd/ui's Panel, ListSection and ListRow;
// no header of their own: the title bar names them and its menu has their options.

import { useEffect } from "react";
import type { WorkspaceId, WindowId } from "@cmd/protocol";
import { setWindowStatus } from "./windowActions.ts";
import type { MenuEntry } from "./context.ts";
import { selectPane } from "./actions.ts";
import { showWorkspace } from "./workspaces.tsx";
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

/** Show a terminal or window: here, or in its own workspace. */
export function goTo(id: WindowId, workspaceId: WorkspaceId | undefined): void {
  if (!workspaceId || workspaceId === getState().workspaceId) selectPane(id);
  else showWorkspace(workspaceId, { select: id });
}

/** "0.4 s", "4 s", "7 min", "1 h 5 min" (the copywriting skill's durations). */
export function durationText(ms: number): string {
  if (ms > 0 && ms < 1000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** A widget's one-line summary ("1 failed", "ends 14:30") in its title bar; null: none. */
export function useWidgetStatus(id: WindowId, label: string | null, key?: string): void {
  useEffect(() => setWindowStatus(id, label ? { label, key: key ?? label } : null), [id, label, key]);
  useEffect(() => () => setWindowStatus(id, null), [id]);
}
