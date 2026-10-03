// The sidebar: a search field over open windows and the transcript index, then
// sections (Needs you, Agents, Windows, Recent past sessions), a footer
// that only speaks when there is news, and a draggable right edge.

import { useEffect, useMemo, useRef, useState } from "react";
import type { PaneId, SearchHit, SearchStatus } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { openSession } from "../actions.ts";
import { usePersisted } from "../store.ts";
import { terminals } from "../terminals.ts";
import { filterRows, flatten, sectionOf, SECTIONS, type Section, type SidebarRow } from "../model.ts";
import { ICON, Symbol } from "./Symbol.tsx";
import { HistoryRow, SectionHeading, SessionRow } from "./SidebarRows.tsx";

export const SIDEBAR_WIDTH = { default: 280, min: 200, max: 480 } as const;

/** A request from a command: focus the search field. */
export interface SidebarRequest {
  kind: "search";
  at: number;
}

interface Props {
  /** The Space switcher, centered at the bottom. */
  spaceBar: React.ReactNode;
  rows: SidebarRow[];
  selected: PaneId | null;
  onSelect: (row: SidebarRow) => void;
  onRowMenu: (row: SidebarRow) => void;
  onClose: (row: SidebarRow) => void;
  onNew: () => void;
  onNewTerminal: () => void;
  onWidth: (px: number | null) => void;
  request: SidebarRequest | null;
  stats: { agents: number; working: number; waiting: number };
  search: SearchStatus | null;
  connected: boolean;
  error?: string;
}

const TITLES: Record<Section, string> = { needs: "Needs you", agents: "Agents", windows: "Windows" };

export function Sidebar(p: Props) {
  const rows = useFrozenOrder(p.rows);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  // Open/closed per section.
  const [openSections, setOpenSections] = usePersisted<Record<string, boolean>>("sidebar.sections", {});
  const isOpen = (id: string) => openSections[id] ?? true;
  const toggle = (id: string) => setOpenSections((o) => ({ ...o, [id]: !(o[id] ?? true) }));

  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const searching = query.trim().length > 0;

  // ⇧⌘F reaches a sidebar that may have just opened.
  useEffect(() => {
    if (!p.request || Date.now() - p.request.at > 1000) return;
    input.current?.focus();
    input.current?.select();
  }, [p.request]);

  const groups = useMemo(() => SECTIONS.map((id) => ({ id, rows: rows.filter((r) => sectionOf(r) === id) })), [rows]);
  // ⌘1–9 follow the visible order of rows that have a window.
  const shortcutOf = useMemo(
    () =>
      new Map(
        flatten(groups.flatMap((g) => g.rows))
          .filter((r) => r.pane || r.win)
          .slice(0, 9)
          .map((r, i) => [r.key, i + 1]),
      ),
    [groups],
  );

  const live = useMemo(
    () =>
      flatten(p.rows)
        .flatMap((r) => (r.pane && r.agent ? [r.agent.native.claudeSessionId, r.agent.native.codexThreadId] : []))
        .filter((x): x is string => !!x),
    [p.rows],
  );
  const recent = useRecent(live, p.search);
  const matches = useMemo(() => (searching ? filterRows(p.rows, query, now) : []), [searching, p.rows, query, now]);
  const hits = useHistorySearch(query);

  // Keyboard selection over the search results: open rows, then history.
  const results: ({ type: "row"; row: SidebarRow } | { type: "hit"; hit: SearchHit })[] = [
    ...matches.map((row) => ({ type: "row" as const, row })),
    ...hits.map((hit) => ({ type: "hit" as const, hit })),
  ];
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query]);
  const activeKey = (() => {
    const r = results[Math.min(active, results.length - 1)];
    return r ? (r.type === "row" ? r.row.key : `h-${r.hit.agent}-${r.hit.sessionId}`) : null;
  })();
  useEffect(() => {
    if (activeKey) list.current?.querySelector(`[data-key="${CSS.escape(activeKey)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  const leaveSearch = () => {
    setQuery("");
    input.current?.blur();
    if (p.selected) terminals.focus(p.selected);
  };
  const pick = (r: (typeof results)[number] | undefined) => {
    if (!r) return;
    leaveSearch();
    if (r.type === "row") p.onSelect(r.row);
    else void openSession(r.hit);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = results.length;
      if (n) setActive((i) => (Math.min(i, n - 1) + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(results[Math.min(active, results.length - 1)]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else leaveSearch();
    }
  };

  const rowProps = { now, selected: p.selected, onSelect: p.onSelect, onMenu: p.onRowMenu, onClose: p.onClose, shortcutOf };
  const footer = footerOf(p);

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-titlebar">
          <button className="icon-btn" onClick={p.onNew} title="New…" aria-label="New">
            <Symbol name="plus" size={ICON.bar} />
          </button>
        </div>
        <div className="sb-search">
          <Symbol name="magnifyingglass" size={ICON.small} className="sb-search-icon" />
          <input
            ref={input}
            value={query}
            placeholder="Search sessions"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {query && (
            <button className="sb-search-clear" aria-label="Clear" onClick={() => (setQuery(""), input.current?.focus())}>
              <Symbol name="xmark.circle.fill" size={ICON.small} />
            </button>
          )}
        </div>

        <div className="sidebar-scroll" ref={list} data-frozen={rows !== p.rows || undefined}>
          {searching ? (
            <>
              {matches.length > 0 && (
                <section className="sb-section">
                  <SectionHeading title="Open" count={matches.length} />
                  {matches.map((r, i) => (
                    <SessionRow key={r.key} row={r} depth={0} flat active={active === i} {...rowProps} />
                  ))}
                </section>
              )}
              {hits.length > 0 && (
                <section className="sb-section">
                  <SectionHeading title="History" count={hits.length} />
                  {hits.map((h, i) => (
                    <HistoryRow key={`${h.agent}-${h.sessionId}`} hit={h} now={now} rich active={active === matches.length + i} onOpen={(x) => pick({ type: "hit", hit: x })} />
                  ))}
                </section>
              )}
              {results.length === 0 && <div className="sb-none">{query.trim().length < 2 ? "Keep typing to search past sessions" : "No matches"}</div>}
            </>
          ) : (
            <>
              {groups.map(
                (g) =>
                  g.rows.length > 0 && (
                    <section key={g.id} className={`sb-section sb-${g.id}`}>
                      <SectionHeading
                        title={TITLES[g.id]}
                        count={g.rows.length}
                        tone={g.id === "needs" ? "needs" : undefined}
                        // Needs you can't be hidden.
                        open={g.id === "needs" ? undefined : isOpen(g.id)}
                        onToggle={g.id === "needs" ? undefined : () => toggle(g.id)}
                      />
                      {(g.id === "needs" || isOpen(g.id)) &&
                        g.rows.map((r) => <SessionRow key={r.key} row={r} depth={0} gutter={g.rows.some((x) => x.children.length > 0)} {...rowProps} />)}
                    </section>
                  ),
              )}
              {rows.length === 0 && (
                <div className="empty">
                  <p>Nothing open.</p>
                  <button className="btn" onClick={p.onNewTerminal}>
                    New Terminal <kbd>⌘T</kbd>
                  </button>
                </div>
              )}
              {recent.length > 0 && (
                <section className="sb-section sb-recent">
                  <SectionHeading title="Recent" open={isOpen("recent")} onToggle={() => toggle("recent")} />
                  {isOpen("recent") && recent.map((h) => <HistoryRow key={`${h.agent}-${h.sessionId}`} hit={h} now={now} onOpen={(x) => void openSession(x)} />)}
                </section>
              )}
            </>
          )}
        </div>
        <div className="sb-spaces">{p.spaceBar}</div>
        <ResizeHandle onWidth={p.onWidth} />
      </aside>
      {/* In the app's bottom row, beside the main status bar: both share one height. */}
      <footer className="sidebar-status">
        <span className={`led led-${footer.led}`} />
        <span className="sidebar-status-text">{footer.text}</span>
      </footer>
    </>
  );
}

function footerOf(p: Props): { text: string; led: "idle" | "off" | "working" } {
  if (!p.connected) return { text: p.error ? `core error: ${p.error}` : "core offline — reconnecting…", led: "off" };
  const s = p.search;
  if (s?.indexing && s.total) return { text: `Indexing ${s.done.toLocaleString()} / ${s.total.toLocaleString()}…`, led: "working" };
  const { agents, working, waiting } = p.stats;
  if (agents) {
    const parts = [`${agents} agent${agents === 1 ? "" : "s"}`, working ? `${working} working` : null, waiting ? `${waiting} waiting` : null];
    return { text: parts.filter(Boolean).join(" · "), led: working ? "working" : "idle" };
  }
  if (s?.sessions) return { text: `${s.sessions.toLocaleString()} past session${s.sessions === 1 ? "" : "s"} indexed`, led: "idle" };
  return { text: "", led: "idle" };
}

/** The newest past sessions that aren't open; refreshed when the index or the open agents change. */
function useRecent(live: string[], status: SearchStatus | null): SearchHit[] {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const liveKey = live.join("\n");
  const indexKey = status ? `${status.sessions}|${status.files}|${status.indexing}` : "";
  useEffect(() => {
    let stale = false;
    cmd.call("search.recent", { limit: 5, exclude: live }).then(
      (h) => !stale && setHits(h),
      () => !stale && setHits([]), // search off, or an older core
    );
    return () => void (stale = true);
  }, [liveKey, indexKey]);
  return hits;
}

/** Transcript search for the sidebar field, debounced; from two characters on. */
function useHistorySearch(query: string): SearchHit[] {
  const [hits, setHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return setHits([]);
    let stale = false;
    const t = setTimeout(() => {
      cmd.call("search.query", { text: q, limit: 20 }).then(
        (h) => !stale && setHits(h),
        () => {},
      );
    }, 150);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query]);
  return hits;
}

/**
 * The right edge: drag to resize, double-click for the default width. While
 * dragging only the CSS variable changes; the width is stored on release.
 */
function ResizeHandle({ onWidth }: { onWidth: (px: number | null) => void }) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const app = handle.closest<HTMLElement>(".app");
    if (!app) return;
    handle.setPointerCapture(e.pointerId);
    app.classList.add("sidebar-resizing");
    let width: number | null = null;
    const move = (ev: PointerEvent) => {
      const max = Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, window.innerWidth - 320));
      width = Math.round(Math.max(SIDEBAR_WIDTH.min, Math.min(max, ev.clientX)));
      app.style.setProperty("--sidebar-w", `${width}px`);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      app.classList.remove("sidebar-resizing");
      if (width !== null) onWidth(width);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  return <div className="sidebar-resize" onPointerDown={onPointerDown} onDoubleClick={() => onWidth(null)} title="Drag to resize · double-click to reset" />;
}

/**
 * Keeps the row order stable while the pointer is over the list, so rows never
 * jump under the cursor. New rows are appended; the order catches up on leave.
 */
function useFrozenOrder(rows: SidebarRow[]): SidebarRow[] {
  const hovering = useRef(false);
  const frozen = useRef<string[] | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    const el = document.querySelector(".sidebar-scroll");
    if (!el) return;
    const enter = () => {
      hovering.current = true;
      frozen.current = rows.map((r) => r.key);
    };
    const leave = () => {
      hovering.current = false;
      frozen.current = null;
      force((n) => n + 1);
    };
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
    return () => {
      el.removeEventListener("mouseenter", enter);
      el.removeEventListener("mouseleave", leave);
    };
  });

  if (!hovering.current || !frozen.current) return rows;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const ordered = frozen.current.map((k) => byKey.get(k)).filter((r): r is SidebarRow => !!r);
  const known = new Set(frozen.current);
  return [...ordered, ...rows.filter((r) => !known.has(r.key))];
}
