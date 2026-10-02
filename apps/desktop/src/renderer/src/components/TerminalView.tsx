import { useEffect, useLayoutEffect, useRef } from "react";
import type { PaneId } from "@cmd/protocol";
import { terminals } from "../terminals.ts";

export function TerminalView(p: { paneId: PaneId; focused: boolean; onMenu: (paneId: PaneId) => void }) {
  const { paneId, focused } = p;
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    terminals.attach(paneId, el);
    const ro = new ResizeObserver(() => terminals.fit(paneId));
    ro.observe(el);
    return () => {
      ro.disconnect();
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
}
