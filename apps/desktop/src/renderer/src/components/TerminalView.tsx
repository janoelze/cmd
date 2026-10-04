import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PaneId } from "@cmd/protocol";
import { terminals, type FindResults } from "../terminals.ts";

// Memoized: the canvas re-renders every window on each camera frame; the content
// only needs to when its own props change.
export const TerminalView = memo(function TerminalView(p: { paneId: PaneId; focused: boolean; onMenu: (paneId: PaneId) => void }) {
  const { paneId, focused } = p;
  const ref = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const [finding, setFinding] = useState(false);
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
    <div className="find-bar" onMouseDown={(e) => e.target !== input.current && e.preventDefault()}>
      <input
        ref={input}
        value={query}
        placeholder="Find"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
          else if (e.key === "Escape") p.onClose();
          else return;
          e.preventDefault();
        }}
      />
      <span className="find-count">{count}</span>
      <button className={caseSensitive ? "on" : ""} title="Match Case" onClick={() => setCase(!caseSensitive)}>
        Aa
      </button>
      <button className={regex ? "on" : ""} title="Regular Expression" onClick={() => setRegex(!regex)}>
        .*
      </button>
      <button title="Previous (⇧↩)" onClick={() => step(-1)}>
        ↑
      </button>
      <button title="Next (↩)" onClick={() => step(1)}>
        ↓
      </button>
      <button title="Close (⎋)" onClick={p.onClose}>
        ✕
      </button>
    </div>
  );
}
