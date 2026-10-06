import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchStatus } from "@cmd/protocol";
import { ICON, iconNode } from "@cmd/ui";
import { IndexRing } from "./IndexRing.tsx";

export interface PaletteItem {
  id: string;
  /** "Commands", "Sessions", "Spaces", "Windows", "Widgets"… */
  group: string;
  label: string;
  /** SF Symbol before the label. */
  icon?: string;
  hint?: string;
  /** Second line (search results): agent · folder · when. */
  meta?: string;
  /** Matching passage; \x01…\x02 mark highlighted terms. */
  snippet?: string | null;
  run: () => void;
  /** ⌘↵ (Space picker: open in a new app window). */
  runAlt?: () => void;
}

const PREFIX: Record<string, string> = { ">": "Commands", "@": "Sessions" };
/** `?query` searches agent transcripts (async, in the core). */
const SEARCH_PREFIX = "?";

/** Subsequence match; earlier and tighter matches score higher. */
function score(label: string, q: string): number {
  if (!q) return 1;
  const s = label.toLowerCase();
  const direct = s.indexOf(q);
  if (direct >= 0) return 100 - direct;
  let i = 0;
  let gaps = 0;
  for (const ch of q) {
    const j = s.indexOf(ch, i);
    if (j < 0) return 0;
    gaps += j - i;
    i = j + 1;
  }
  return Math.max(1, 50 - gaps);
}

/** A group's place in `groups`; unknown groups go last. */
const rank = (groups: string[], g: string) => (groups.indexOf(g) + 1 || groups.length + 1);

/** Render \x01…\x02 markers as highlights. */
export function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(\x01[^\x02]*\x02)/);
  return (
    <>
      {parts.map((p, i) => (p.startsWith("\x01") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}
    </>
  );
}

export function Palette({
  items,
  recent = [],
  onRun,
  onClose,
  initialQuery = "",
  search,
  searchStatus,
  dynamic,
  fallback,
  groups,
  placeholder = "Type a command, @session, ?search…",
  footer,
  emptyText,
}: {
  items: PaletteItem[];
  /** Recently run item ids, most recent first; ranked first. */
  recent?: string[];
  onRun?: (id: string) => void;
  onClose: () => void;
  initialQuery?: string;
  /** Transcript search for `?query`. */
  search?: (text: string) => Promise<PaletteItem[]>;
  /** Shown in the footer while searching, e.g. "3,836 sessions indexed". */
  searchStatus?: SearchStatus | null;
  /** Extra items computed from the raw query (e.g. "Open <url>"), listed first. */
  dynamic?: (query: string) => PaletteItem[];
  /** Items computed from the raw query, listed last (e.g. "Make a widget: …"). */
  fallback?: (query: string) => PaletteItem[];
  /**
   * Groups in the order they are listed, whatever the query: matches are
   * ranked within their group, and each group is labelled once (the New… picker).
   */
  groups?: string[];
  placeholder?: string;
  /** Replaces the footer's hints (pickers other than the command palette). */
  footer?: React.ReactNode;
  emptyText?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<PaletteItem[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Prefixes only where they mean something: ? with a search, > and @ with their groups.
  const searching = !!search && query.startsWith(SEARCH_PREFIX);
  const searchText = searching ? query.slice(1).trim() : "";

  useEffect(() => input.current?.focus(), []);

  // Debounced transcript search; stale responses are dropped.
  useEffect(() => {
    if (!searching || !search) return setFound(null);
    if (!searchText) return setFound([]);
    setFound(null);
    let live = true;
    const t = setTimeout(() => {
      void search(searchText).then((r) => live && setFound(r));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [searching, searchText, search]);

  const results = useMemo(() => {
    if (searching) return found ?? [];
    const extra = dynamic?.(query) ?? [];
    const prefixed = PREFIX[query[0] ?? ""];
    const group = prefixed && items.some((it) => it.group === prefixed) ? prefixed : undefined;
    const q = (group ? query.slice(1) : query).trim().toLowerCase();
    const matched = items
      .filter((it) => !group || it.group === group)
      .map((it) => {
        // The second line (a Space's folder) matches too: "src/cmd" finds it.
        const s = score(it.meta ? `${it.label} ${it.meta}` : it.label, q);
        const r = recent.indexOf(it.id);
        // Recent items first when the query is empty; a small boost otherwise.
        return { it, s: s > 0 && r >= 0 ? s + (q ? 10 : 1000) - r : s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => (groups ? rank(groups, a.it.group) - rank(groups, b.it.group) : 0) || b.s - a.s)
      .slice(0, 50)
      .map((x) => x.it);
    return [...extra, ...matched, ...(fallback?.(query) ?? [])];
  }, [items, query, recent, searching, found, dynamic, fallback, groups]);

  useEffect(() => setActive(0), [query]);

  const run = (it: PaletteItem | undefined, alt = false) => {
    if (!it) return;
    onClose();
    onRun?.(it.id);
    (alt && it.runAlt ? it.runAlt : it.run)();
  };

  const empty = searching
    ? searchText
      ? found === null
        ? "Searching…"
        : "No sessions match."
      : 'Search past Claude Code and Codex sessions. "Phrases" and -exclusions work.'
    : (emptyText ?? "Nothing matches. Type ? to search past agent sessions.");

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className={`palette ${searching ? "searching" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="palette-input"
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, results.length - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
            else if (e.key === "Enter") run(results[active], e.metaKey);
          }}
        />
        <ul className="palette-list">
          {results.map((it, i) => (
            <li
              key={it.id}
              className={`${i === active ? "on" : ""} ${it.meta ? "rich" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={(e) => run(it, e.metaKey)}
            >
              {it.meta ? (
                <div className="palette-hit">
                  <div className="palette-hit-top">
                    <span className="palette-label">{it.label}</span>
                    <span className="palette-meta">{it.meta}</span>
                  </div>
                  {it.snippet && (
                    <div className="palette-snippet">
                      <Highlighted text={it.snippet} />
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <span className="palette-group">{!groups || results[i - 1]?.group !== it.group ? it.group : ""}</span>
                  {it.icon && <span className="palette-icon">{iconNode(it.icon, ICON.row)}</span>}
                  <span className="palette-label">{it.label}</span>
                  {it.hint && <kbd>{it.hint}</kbd>}
                </>
              )}
            </li>
          ))}
          {results.length === 0 && <li className="palette-empty">{empty}</li>}
        </ul>
        <footer className="palette-foot">
          {footer ?? (
            <>
              <span>
                <kbd>↑↓</kbd> move
              </span>
              <span>
                <kbd>↵</kbd> {searching ? "open or resume" : "run"}
              </span>
              {searching ? (
                <span className="palette-status">
                  <IndexRing status={searchStatus ?? null} />
                  {searchStatus ? `${searchStatus.sessions.toLocaleString()} session${searchStatus.sessions === 1 ? "" : "s"} indexed` : ""}
                </span>
              ) : (
                <span>
                  <kbd>&gt;</kbd> commands <kbd>@</kbd> sessions <kbd>?</kbd> search
                </span>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
