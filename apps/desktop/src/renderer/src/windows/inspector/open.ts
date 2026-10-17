// Opening, moving and closing a browser window's inspector (docs/59): in a window of its own,
// placed right after the page on the board, or inside the browser window (its state's
// `inspector: "inside"`). One per page; the place last chosen is the workspace's default
// (Show Inspector, ⌥⌘I: commands.ts).

import type { AppWindow, WindowId } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import { select } from "../../lib/selection.ts";
import { getState, getWorkspaceView, setWorkspaceView } from "../../lib/store.ts";
import { boardOf } from "../../shell/board/board.ts";

export type InspectorPlace = "window" | "inside";

const WHERE = "inspector.where";

/** A page's Inspector window, if it has one. */
export const inspectorOf = (pageId: WindowId): AppWindow | undefined =>
  [...getState().windows.values()].find((w) => w.kind === "inspector" && w.state.for === pageId);

/** Where a browser window's inspector is, if open. */
export const inspectorPlace = (page: AppWindow): InspectorPlace | null =>
  page.state.inspector === "inside" ? "inside" : inspectorOf(page.id) ? "window" : null;

/** A browser window that shows a page (a blank one has nothing to inspect). */
export const hasPage = (w: AppWindow | undefined): boolean =>
  w?.kind === "browser" && typeof w.state.url === "string" && w.state.url !== "about:blank";

const update = (page: AppWindow, inspector: "inside" | null) => cmd.call("window.update", { id: page.id, state: { inspector } });

export async function openInspector(page: AppWindow, where: InspectorPlace): Promise<void> {
  setWorkspaceView(page.workspaceId, WHERE, where);
  const own = inspectorOf(page.id);
  if (where === "inside") {
    if (own) await cmd.call("window.close", { id: own.id });
    if (page.state.inspector !== "inside") await update(page, "inside");
    return select(page.id);
  }
  if (page.state.inspector === "inside") await update(page, null);
  if (own) return select(own.id);
  const w = await cmd.call("window.open", { kind: "inspector", input: { for: page.id }, workspaceId: page.workspaceId });
  // Right after its page: the board is wider than the screen, so the page keeps its size.
  const board = boardOf(getState());
  if (board.workspaceId === page.workspaceId && board.order.includes(page.id)) {
    const order = board.order.filter((id) => id !== w.id);
    order.splice(order.indexOf(page.id) + 1, 0, w.id);
    setWorkspaceView(page.workspaceId, "grid.order", order);
  }
  select(w.id);
}

export async function closeInspector(page: AppWindow): Promise<void> {
  const own = inspectorOf(page.id);
  if (own) await cmd.call("window.close", { id: own.id });
  if (page.state.inspector === "inside") await update(page, null);
}

/** Open it where it was last opened in this workspace (a new window at first). */
export const openInspectorAgain = (page: AppWindow) => openInspector(page, getWorkspaceView<InspectorPlace>(page.workspaceId, WHERE, "window"));
