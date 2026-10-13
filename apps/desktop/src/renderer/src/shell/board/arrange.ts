// Moves on the board asked for from outside the app (workspace.arrange, the arrange
// tool, docs/51): the app window showing the workspace makes the move with the board's own
// helpers and answers (workspace.arranged). Another app window, showing another workspace, stays out.

import type { ArrangeOp } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import { moveInOrder } from "../../lib/model.ts";
import { getState, setWorkspaceView } from "../../lib/store.ts";
import { boardOf } from "./board.ts";
import { dock, undock } from "./docks.ts";
import { setDocks, setMode } from "./view.ts";

function arrange(move: ArrangeOp): void {
  const board = boardOf(getState());
  const known = (id: string) => board.allFlat.some((r) => (r.win?.id ?? r.pane?.id) === id) || board.docks.left.id === id || board.docks.right.id === id;
  if ("id" in move && !known(move.id)) throw new Error("that window isn't on this board");
  switch (move.op) {
    case "dock":
      return setDocks((d) => dock(d, move.id, move.side));
    case "board":
      return setDocks((d) => undock(d, move.id));
    case "mode":
      return setMode(move.mode);
    case "place": {
      const order = board.order;
      if (!order.includes(move.id)) throw new Error("that window is in a sidebar: put it on the board first");
      const without = order.filter((x) => x !== move.id);
      const anchor = move.before ?? move.after;
      const at = move.to === "first" ? 0 : move.to === "last" ? without.length : anchor && without.includes(anchor) ? without.indexOf(anchor) + (move.after ? 1 : 0) : -1;
      if (at < 0) throw new Error("place it before or after a window on the board, or first or last");
      return setWorkspaceView(board.workspaceId, "grid.order", moveInOrder(order, move.id, at));
    }
  }
}

cmd.onEvent((e) => {
  if (e.type !== "workspace.arrangeRequest" || e.workspaceId !== getState().workspaceId) return;
  let error: string | undefined;
  try {
    arrange(e.move);
  } catch (err) {
    error = (err as Error).message;
  }
  void cmd.call("workspace.arranged", { reqId: e.reqId, error }).catch(() => {});
});
