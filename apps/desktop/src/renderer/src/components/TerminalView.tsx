import { memo, useEffect, useLayoutEffect, useRef } from "react";
import type { PaneId } from "@cmd/protocol";
import { terminals } from "../terminals.ts";

// Memoized: the canvas re-renders every window on each camera frame; the content
// only needs to when its own props change.
export const TerminalView = memo(function TerminalView(p: { paneId: PaneId; focused: boolean; onMenu: (paneId: PaneId) => void }) {
  const { paneId, focused } = p;
  const ref = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  // At startup a terminal is attached once its snapshot is written (terminals.hold);
  // the window around it shows right away.
  useLayoutEffect(() => {
    const el = ref.current!;
    let ro: ResizeObserver | null = null;
    let live = true;
    const attach = () => {
      if (!live) return;
      terminals.attach(paneId, el);
      ro = new ResizeObserver(() => terminals.fit(paneId));
      ro.observe(el);
      if (focusedRef.current) terminals.focus(paneId);
    };
    const ready = terminals.whenReady(paneId);
    if (ready) void ready.then(attach);
    else attach();
    return () => {
      live = false;
      ro?.disconnect();
      terminals.detach(paneId, el);
    };
  }, [paneId]);

  useEffect(() => {
    if (focused) terminals.focus(paneId);
  }, [focused, paneId]);

  return (
    <div
      className="term-well"
      ref={ref}
      onContextMenu={(e) => {
        e.preventDefault();
        p.onMenu(paneId);
      }}
    />
  );
});
