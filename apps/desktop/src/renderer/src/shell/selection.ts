// The selection follows the board: when the selected window goes away, the next one is selected
// as ui.afterClose says (lib/placement.ts: like tabs, or the one used before it); what is
// selected is what new windows open beside (lib/store.ts) and what the status bar shows the usage of.

import { useEffect, useRef } from "react";
import type { PaneId } from "@cmd/protocol";
import { windowSelected } from "../lib/actions.ts";
import { afterClose, type Openers } from "../lib/placement.ts";
import { clear, history, isDeselected, select } from "../lib/selection.ts";
import { getState, getWorkspaceView, setUsageShown } from "../lib/store.ts";
import type { Board } from "./board/board.ts";

export function useSelectionFollows(board: Board, selected: PaneId | null, connected: boolean): void {
  const orderBefore = useRef<PaneId[]>([]);
  const rectsBefore = useRef(board.canvasRects);
  // Runs once the core's state, including the remembered selection, has arrived.
  useEffect(() => {
    if (!connected) return;
    const { shown, order, mode } = board;
    if (selected && (shown.panes.has(selected) || shown.windows.has(selected))) return;
    if (!selected && isDeselected() && mode === "canvas") return;
    const alive = new Set(order);
    const h = history();
    const closing = (closed: PaneId) => ({
      closed,
      history: h,
      order: orderBefore.current,
      alive,
      opener: getWorkspaceView<Openers>(board.workspaceId, "openers", {})[closed] ?? null,
      rects: mode === "canvas" ? rectsBefore.current : null,
    });
    const next = selected ? afterClose(closing(selected), getState().settings.settings["ui.afterClose"]) : (h.find((id) => alive.has(id)) ?? order[0] ?? null);
    if (next !== selected) {
      if (next) select(next);
      else clear();
    }
  }, [connected, board.shown.panes, board.order.join(), selected, board.mode]); // eslint-disable-line react-hooks/exhaustive-deps
  // This render's order and canvas for the next close (after the effect above, so it still sees them from before the window went).
  useEffect(() => {
    orderBefore.current = board.order;
    rectsBefore.current = board.canvasRects;
  }, [board.order.join(), board.canvasRects]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    windowSelected(selected);
    setUsageShown(selected);
  }, [selected]);
}
