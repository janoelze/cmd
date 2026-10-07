import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { Toast, type FindResults } from "@cmd/ui";
import type { PaneId, Progress } from "@cmd/protocol";
import { useStoreValue } from "../store.ts";
import { terminals } from "../terminals.ts";
import { useFind } from "../find.tsx";
import { cmd } from "../bridge.ts";
import { countRender } from "../perf.ts";

// Memoized: the canvas re-renders every window on each camera frame; the content
// only needs to when its own props change.
export const TerminalView = memo(function TerminalView(p: { paneId: PaneId; focused: boolean; onMenu: (paneId: PaneId) => void }) {
  countRender("TerminalView");
  const { paneId, focused } = p;
  const ref = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const progress = useStoreValue((s) => s.panes.get(paneId)?.progress ?? null);
  const sizedBy = useStoreValue((s) => s.panes.get(paneId)?.sizedBy ?? null);
  const cols = useStoreValue((s) => s.panes.get(paneId)?.cols ?? 0);
  const rows = useStoreValue((s) => s.panes.get(paneId)?.rows ?? 0);

  // At startup a terminal is attached once its snapshot is written (terminals.hold);
  // the window around it shows right away.
  useLayoutEffect(() => {
    const el = ref.current!;
    let ro: ResizeObserver | null = null;
    let live = true;
    const attach = () => {
      if (!live) return;
      terminals.attach(paneId, el);
      ro = new ResizeObserver(() => terminals.resized(paneId));
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

  // A phone sizes this terminal while it shows it (docs/13); typing here or Take Back ends that.
  useEffect(() => terminals.setOverride(paneId, sizedBy ? { cols, rows } : null), [paneId, sizedBy, cols, rows]);

  // Find in the scrollback; the bar floats over the terminal, which has no toolbar.
  const report = useRef<(r: FindResults | null) => void>(() => {});
  const find = useFind(
    {
      find: (q, o, step, r) => ((report.current = r), terminals.find(paneId, q, step < 0 ? -1 : 1, { ...o, incremental: step === 0 })),
      clear: () => terminals.endFind(paneId),
      selection: () => terminals.selectionText(paneId),
    },
    { floating: true, onClose: () => terminals.focus(paneId) },
  );
  useEffect(() => terminals.onFind(paneId, { request: find.request, results: (r) => report.current(r) }), [paneId, find.request]);

  return (
    <div className="term-wrap">
      <div
        className="term-well"
        ref={ref}
        onContextMenu={(e) => {
          e.preventDefault();
          p.onMenu(paneId);
        }}
      />
      {progress && <ProgressBar p={progress} />}
      {sizedBy && (
        <Toast className="term-sized" icon="iphone" action={{ label: "Take Back", run: () => void cmd.call("pane.reclaim", { paneId }).then(() => terminals.focus(paneId)) }}>
          Sized for {sizedBy} · {cols}×{rows}
        </Toast>
      )}
      {find.bar && (
        // Clicks on its buttons leave the focus in the field.
        <div className="find-bar" onMouseDown={(e) => !(e.target instanceof HTMLInputElement) && e.preventDefault()}>
          {find.bar}
        </div>
      )}
    </div>
  );
});

/** What the program reports with OSC 9;4, along the terminal's top edge. */
function ProgressBar({ p }: { p: Progress }) {
  return (
    <div className={`term-progress ${p.state}`} role="progressbar" aria-valuenow={p.state === "indeterminate" ? undefined : p.value}>
      <div style={p.state === "indeterminate" ? undefined : { width: `${p.value}%` }} />
    </div>
  );
}

