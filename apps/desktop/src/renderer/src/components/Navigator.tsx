// The Navigator (docs/21-sidebars.md): what the app's sidebar used to be, now a
// built-in widget, docked left in every Space by default. A search field over
// open windows and the transcript index, then sections (Needs you, Agents,
// Windows, Widgets, Recent past sessions). It reads App's rows and callbacks
// through NavigatorContext, so every Navigator window shows the same.

import { Button, EmptyState, ToolbarSearchField, WindowToolbar } from "@cmd/ui";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PaneId, SearchHit, SearchStatus } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { openSession } from "../actions.ts";
import { usePersisted, useStoreValue, subscribeView } from "../store.ts";
import { terminals } from "../terminals.ts";
import { filterRows, flatten, sectionOf, SECTIONS, type Section, type SidebarRow } from "../model.ts";
import { HistoryRow, SectionHeading, SessionRow } from "./SidebarRows.tsx";
import { IndexRing } from "./IndexRing.tsx";
import { countRender } from "../perf.ts";
import type { WindowViewProps } from "../windows/registry.ts";

/** A request from a command: focus the search field. */
export interface SidebarRequest {
  kind: "search";
  at: number;
}

/** What the Navigator shows and does, from App. */
export interface NavigatorData {
  /** The Space's rows, sidebars left out (they are always in view). */
  rows: SidebarRow[];
  selected: PaneId | null;
  onSelect: (row: SidebarRow) => void;
  onRowMenu: (row: SidebarRow) => void;
  onClose: (row: SidebarRow) => void;
  onNewTerminal: () => void;
  request: SidebarRequest | null;
  search: SearchStatus | null;
}

export const NavigatorContext = createContext<NavigatorData | null>(null);

/** The window view (windows/builtin.tsx). */
export function NavigatorView({ win }: WindowViewProps) {
  const data = useContext(NavigatorContext);
  return data ? <Navigator {...data} key={win.id} /> : null;
}

const TITLES: Record<Section, string> = { needs: "Needs you", agents: "Agents", windows: "Windows", widgets: "Widgets" };

function Navigator(p: NavigatorData) {
  countRender("Navigator");
  const list = useRef<HTMLDivElement>(null);
  const rows = useFrozenOrder(p.rows, list);
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

  return (
    <div className="navigator">
      <WindowToolbar label="Search">
        <ToolbarSearchField ref={input} className="sb-search" value={query} placeholder="Search sessions" onChange={setQuery} onKeyDown={onKeyDown} end={<IndexRing status={p.search} />} />
      </WindowToolbar>

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
            {results.length === 0 && <EmptyState compact>{query.trim().length < 2 ? "Keep typing to search past sessions" : "No matches"}</EmptyState>}
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
              <EmptyState
                compact
                title="Nothing open"
                action={
                  <Button onClick={p.onNewTerminal} data-tip-key="⌘T" data-tip="New Terminal">
                    New Terminal
                  </Button>
                }
              />
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
    </div>
  );
}

/** The newest past sessions that aren't open; refreshed when the index or the open agents change. */
function useRecent(live: string[], status: SearchStatus | null): SearchHit[] {
  const limit = useStoreValue((s) => s.settings.settings["ui.sidebarRecent"]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const liveKey = live.join("\n");
  const indexKey = status ? `${status.sessions}|${status.files}|${status.indexing}` : "";
  const [tick, setTick] = useState(0);
  // A live query over the sessions view: refetch when a session changes (a title, new activity), debounced.
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const off = subscribeView({ view: "sessions", since: Date.now(), limit: 1 }, (_rows, initial) => {
      if (initial) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => setTick((n) => n + 1), 2000);
    });
    return () => (clearTimeout(debounce), off());
  }, []);
  useEffect(() => {
    if (limit <= 0) return setHits([]);
    let stale = false;
    cmd.call("search.recent", { limit, exclude: live }).then(
      (h) => !stale && setHits(h),
      () => !stale && setHits([]), // search off, or an older core
    );
    return () => void (stale = true);
  }, [liveKey, indexKey, limit, tick]);
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
 * Keeps the row order stable while the pointer is over the list, so rows never
 * jump under the cursor. New rows are appended; the order catches up on leave.
 */
function useFrozenOrder(rows: SidebarRow[], list: React.RefObject<HTMLDivElement | null>): SidebarRow[] {
  const hovering = useRef(false);
  const frozen = useRef<string[] | null>(null);
  const [, force] = useState(0);
  const latest = useRef(rows);
  latest.current = rows;

  // Bound once (it re-queried the DOM and re-bound both listeners on every render).
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const enter = () => {
      hovering.current = true;
      frozen.current = latest.current.map((r) => r.key);
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
  }, []);

  if (!hovering.current || !frozen.current) return rows;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const ordered = frozen.current.map((k) => byKey.get(k)).filter((r): r is SidebarRow => !!r);
  const known = new Set(frozen.current);
  return [...ordered, ...rows.filter((r) => !known.has(r.key))];
}
