import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Toast, ToolbarButton, ToolbarGroup, ToolbarSearchField, WindowToolbar } from "@cmd/ui";
import type { PaneId, Progress } from "@cmd/protocol";
import { useStoreValue } from "../store.ts";
import { terminals, type FindResults } from "../terminals.ts";
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
  const [finding, setFinding] = useState(false);
  const progress = useStoreValue((s) => s.panes.get(paneId)?.progress ?? null);
  const sizedBy = useStoreValue((s) => s.panes.get(paneId)?.sizedBy ?? null);
  const cols = useStoreValue((s) => s.panes.get(paneId)?.cols ?? 0);
  const rows = useStoreValue((s) => s.panes.get(paneId)?.rows ?? 0);
  const findRef = useRef<FindHandle | null>(null);

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

  useEffect(
    () =>
      terminals.onFind(paneId, {
        request: (r) => {
          if (r === "open" || !findRef.current) {
            setFinding(true);
            findRef.current?.focus(terminals.selectionText(paneId));
          } else findRef.current.step(r === "next" ? 1 : -1);
        },
        results: (r) => findRef.current?.results(r),
      }),
    [paneId],
  );

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
      {finding && (
        <FindBar
          paneId={paneId}
          handle={findRef}
          onClose={() => {
            setFinding(false);
            terminals.endFind(paneId);
            terminals.focus(paneId);
          }}
        />
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

interface FindHandle {
  focus: (seed: string) => void;
  step: (dir: 1 | -1) => void;
  results: (r: FindResults) => void;
}

/** Find in the terminal's scrollback: ↩ next, ⇧↩ previous, ⎋ closes. */
function FindBar(p: { paneId: PaneId; handle: React.RefObject<FindHandle | null>; onClose: () => void }) {
  const { paneId } = p;
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(() => terminals.selectionText(paneId));
  const [caseSensitive, setCase] = useState(false);
  const [regex, setRegex] = useState(false);
  const [res, setRes] = useState<FindResults | null>(null);
  const opts = { caseSensitive, regex };
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const queryRef = useRef(query);
  queryRef.current = query;

  const step = (dir: 1 | -1) => terminals.find(paneId, queryRef.current, dir, optsRef.current);
  p.handle.current = {
    focus: (seed) => {
      if (seed) setQuery(seed);
      input.current?.focus();
      input.current?.select();
    },
    step,
    results: setRes,
  };

  // Typing searches as you go, from where the last match was.
  useEffect(() => {
    terminals.find(paneId, query, 1, { caseSensitive, regex, incremental: true });
  }, [paneId, query, caseSensitive, regex]);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    return () => void (p.handle.current = null);
  }, []);

  const count = !query ? "" : res && res.count > 0 ? (res.index >= 0 ? `${res.index + 1} of ${res.count}` : `${res.count}+`) : "No matches";

  return (
    <div className="find-bar" onMouseDown={(e) => !(e.target instanceof HTMLInputElement) && e.preventDefault()}>
      <WindowToolbar label="Find" floating>
        <ToolbarSearchField
          ref={input}
          value={query}
          placeholder="Find"
          minWidth={150}
          maxWidth={220}
          count={count}
          onChange={setQuery}
          onKeyDown={(e) => {
            if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
            else if (e.key === "Escape") p.onClose();
            else return;
            e.preventDefault();
          }}
        />
        <ToolbarButton icon={<span className="find-glyph">Aa</span>} label="Match Case" pressed={caseSensitive} onClick={() => setCase(!caseSensitive)} />
        <ToolbarButton icon={<span className="find-glyph">.*</span>} label="Regular Expression" pressed={regex} onClick={() => setRegex(!regex)} />
        <ToolbarGroup>
          <ToolbarButton icon="chevron.up" label="Previous" shortcut="⇧↩" onClick={() => step(-1)} />
          <ToolbarButton icon="chevron.down" label="Next" shortcut="↩" onClick={() => step(1)} />
        </ToolbarGroup>
        <ToolbarButton icon="xmark" label="Close" shortcut="⎋" onClick={p.onClose} />
      </WindowToolbar>
    </div>
  );
}
