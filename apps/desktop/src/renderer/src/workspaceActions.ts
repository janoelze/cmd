// Running Workspace Actions (docs/39) from anywhere in the app: the widget, the
// palette's Actions group and Run Last Action Again all go through runAction, so
// each runs in the same terminal the same way and the last one is remembered.

import type { ActionsList, AppWindow, GitPlace, SpaceId, WindowId, WorkspaceAction } from "@cmd/protocol";
import { cmd } from "./bridge.ts";
import { addWidget, selectPane } from "./actions.ts";
import { getSpaceView, getState } from "./store.ts";
import { goTo } from "./widgets.ts";

/** The last action run, for Run Last Action Again; never a risky one (that asks each time). */
let last: { root: string; action: WorkspaceAction; spaceId: SpaceId } | null = null;

/**
 * Run an action: a recipe that needs arguments is typed into a new terminal in
 * its folder for the person to finish; anything else runs in its terminal
 * (the core picks or makes it), which is then shown.
 */
export async function runAction(root: string, a: WorkspaceAction, spaceId: SpaceId, o: { restart?: boolean; fresh?: boolean } = {}): Promise<void> {
  if (a.args) {
    const t = await cmd.call("window.open", { kind: "terminal", input: { cwd: a.cwd }, spaceId });
    goTo(t.id, spaceId);
    await cmd.call("pane.write", { paneId: t.id, data: a.command + " " });
    return;
  }
  const r = await cmd.call("actions.run", { root, actionId: a.id, spaceId, restart: o.restart, fresh: o.fresh });
  if (!a.risky) last = { root, action: a, spaceId };
  goTo(r.paneId, spaceId);
}

/** Run Last Action Again: a server still running is restarted. */
export async function rerunLastAction(): Promise<boolean> {
  if (!last) return false;
  await runAction(last.root, last.action, last.spaceId, { restart: true });
  return true;
}

/** The Space's folder, for its actions; null for Home (the home folder isn't a project). */
export function spaceRoot(spaceId: SpaceId): string | null {
  const sp = getState().spaces.get(spaceId);
  return sp && !sp.home ? sp.root : null;
}

/** Where a terminal's work is: its agent's checkout (agents move into worktrees), else the terminal's own. */
function placeOfPane(id: string): GitPlace | null {
  const st = getState();
  const pane = st.panes.get(id);
  if (!pane) return null;
  const agent = pane.agentId ? st.agents.get(pane.agentId) : undefined;
  return agent?.git ?? pane.git ?? null;
}

/**
 * The checkout of the terminal or agent selected last in a Space, when it is
 * one of the Space's repository's (a worktree another agent works in): parallel
 * agents each in their own checkout, and the actions follow the one you look at.
 */
export function followedRoot(spaceId: SpaceId): string | null {
  const sp = getState().spaces.get(spaceId);
  if (!sp?.git) return null;
  for (const id of getSpaceView<string[]>(spaceId, "selection.history", [])) {
    const place = placeOfPane(id);
    if (place) return place.project === sp.git.project ? place.top : null;
  }
  return null;
}

/** The folder an actions widget is about: the one picked in its menu, else the followed checkout, else its Space's root. */
export function actionsRootOf(win: Pick<AppWindow, "state" | "spaceId">): string | null {
  if (typeof win.state.path === "string") return win.state.path;
  return (win.state.follow !== false ? followedRoot(win.spaceId) : null) ?? getState().spaces.get(win.spaceId)?.root ?? null;
}

/** Each widget's last list, for its title bar menu (the worktrees to switch to). */
export const lastLists = new Map<WindowId, ActionsList>();

/** Show this Space's Workspace Actions widget, putting one on the workspace if there is none. */
export async function showActions(): Promise<void> {
  const st = getState();
  const w = [...st.windows.values()].find((x) => x.kind === "actions" && x.spaceId === st.spaceId);
  if (w) selectPane(w.id);
  else await addWidget("type:actions");
}

/** The current Space's actions, for the palette (read when it opens). */
export function listActions(spaceId: SpaceId): Promise<ActionsList | null> {
  const root = followedRoot(spaceId) ?? spaceRoot(spaceId);
  return root ? cmd.call("actions.list", { path: root }).catch(() => null) : Promise.resolve(null);
}
