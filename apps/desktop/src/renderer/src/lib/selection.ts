// The selection in the shown workspace: which window is selected and the ones before it (most
// recent first), kept in the workspace's view (selection.pane, selection.history), so it
// survives a restart. Anything may select; selecting a window of another workspace shows that
// workspace (main decides where) and selects it there.

import type { PaneId, WindowId } from "@cmd/protocol";
import { cmd } from "./bridge.ts";
import { pushHistory } from "./model.ts";
import { getState, getWorkspaceView, setWorkspaceView, workspaceOfWindow } from "./store.ts";

/** Nothing selected on purpose (a click on the empty canvas): the board doesn't pick a window again. */
let deselected = false;

export function selected(): WindowId | null {
  const s = getState();
  return getWorkspaceView<WindowId | null>(s.workspaceId, "selection.pane", null);
}

export function history(): WindowId[] {
  return getWorkspaceView<WindowId[]>(getState().workspaceId, "selection.history", []);
}

export function select(id: PaneId): void {
  const target = workspaceOfWindow(id);
  const s = getState();
  if (target && target !== s.workspaceId) return cmd.showWorkspace(target, { select: id });
  deselected = false;
  // Somewhere other than what was just opened: the next window opened goes right after its opener again (lib/placement.ts).
  if (!getWorkspaceView<{ ids: string[] } | null>(s.workspaceId, "openers.run", null)?.ids.includes(id)) setWorkspaceView(s.workspaceId, "openers.run", null);
  setWorkspaceView(s.workspaceId, "selection.pane", id);
  setWorkspaceView(s.workspaceId, "selection.history", pushHistory(history(), id));
  const agentId = s.panes.get(id)?.agentId;
  if (agentId) void cmd.call("agent.markSeen", { agentId }).catch(() => {});
}

/** Select nothing, on purpose; focus leaves the window too. */
export function deselect(): void {
  deselected = true;
  (document.activeElement as HTMLElement | null)?.blur();
  setWorkspaceView(getState().workspaceId, "selection.pane", null);
}

/** Select nothing because nothing is there (the last window closed): the board may pick one later. */
export function clear(): void {
  setWorkspaceView(getState().workspaceId, "selection.pane", null);
}

export function isDeselected(): boolean {
  return deselected;
}
