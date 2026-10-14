// The board's title bars' handlers (WindowsView): one set per window that stays the
// same across renders, calling into the latest render's actions through a ref. TileTitle
// is memoised, and a glide re-renders the board every few frames: new closures each
// time would re-render every title (and its Slots) with it.

import { useRef } from "react";
import type { PaneId } from "@cmd/protocol";
import type { TileTitle } from "../TileTitle.tsx";

export interface TitleActions {
  down: (e: React.PointerEvent, id: PaneId) => void;
  double: (id: PaneId) => void;
  menu: (e: React.MouseEvent, id: PaneId) => void;
}

type Handlers = Pick<React.ComponentProps<typeof TileTitle>, "onPointerDown" | "onDoubleClick" | "onContextMenu">;

/** [handlers for a window, the ref to set to this render's actions]. */
export function useTitleHandlers(): [(id: PaneId) => Handlers, React.RefObject<TitleActions | null>] {
  const actions = useRef<TitleActions | null>(null);
  const cache = useRef(new Map<PaneId, Handlers>());
  const handlers = (id: PaneId) => {
    let h = cache.current.get(id);
    if (!h)
      cache.current.set(
        id,
        (h = {
          onPointerDown: (e) => actions.current?.down(e, id),
          onDoubleClick: () => actions.current?.double(id),
          onContextMenu: (e) => actions.current?.menu(e, id),
        }),
      );
    return h;
  };
  return [handlers, actions];
}
