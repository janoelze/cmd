// Arranging a workspace's windows from outside the app (the arrange tool, docs/54): the layout is the
// app's (keys in the workspace's view only the renderer understands), so the core asks the app
// window showing the workspace to make a move (workspace.arrangeRequest) and waits for its answer
// (workspace.arranged).

import type { WindowId, WorkspaceId } from "./model.ts";

export type ArrangeOp =
  /** Into the left or right sidebar (the one there goes back to the board). */
  | { op: "dock"; id: WindowId; side: "left" | "right" }
  /** Out of a sidebar, back onto the board. */
  | { op: "board"; id: WindowId }
  /** Somewhere in the board's order (grid and strip): before or after another window, first or last. */
  | { op: "place"; id: WindowId; before?: WindowId; after?: WindowId; to?: "first" | "last" }
  /** The board's view: grid, strip, canvas, or focus (the selected window alone). */
  | { op: "mode"; mode: "grid" | "strip" | "canvas" | "focus" };

/** To the app windows: make this move and answer with workspace.arranged. Part of CoreEvent (rpc.ts). */
export type ArrangeEvent = { type: "workspace.arrangeRequest"; reqId: string; workspaceId: WorkspaceId; move: ArrangeOp };

/** Arranging's RPC methods, part of `Methods` (rpc.ts). */
export interface ArrangeMethods {
  /** Make a move on a workspace's board: the app window showing it does, or this fails saying none does. */
  "workspace.arrange": { params: { workspaceId: WorkspaceId; move: ArrangeOp }; result: null };
  /** The app's answer to a workspace.arrangeRequest. */
  "workspace.arranged": { params: { reqId: string; error?: string }; result: null };
}
