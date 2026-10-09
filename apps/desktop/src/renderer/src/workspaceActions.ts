// Running Workspace Actions (docs/39) from anywhere in the app: the widget, the
// palette's Actions group and Run Last Action Again all go through runAction, so
// each runs in the same terminal the same way and the last one is remembered.

import type { ActionsList, SpaceId, WorkspaceAction } from "@cmd/protocol";
import { cmd } from "./bridge.ts";
import { addWidget, selectPane } from "./actions.ts";
import { getState } from "./store.ts";
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

/** Show this Space's Workspace Actions widget, putting one on the workspace if there is none. */
export async function showActions(): Promise<void> {
  const st = getState();
  const w = [...st.windows.values()].find((x) => x.kind === "actions" && x.spaceId === st.spaceId);
  if (w) selectPane(w.id);
  else await addWidget("type:actions");
}

/** The current Space's actions, for the palette (read when it opens). */
export function listActions(spaceId: SpaceId): Promise<ActionsList | null> {
  const root = spaceRoot(spaceId);
  return root ? cmd.call("actions.list", { path: root }).catch(() => null) : Promise.resolve(null);
}
