import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SearchStatus } from "@cmd/protocol";
import { Highlight, ICON, iconNode } from "@cmd/ui";
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
/** A group's name over search results, where it differs (the open sessions and windows). */
const HEADING: Record<string, string> = { Sessions: "Open" };
/** `?query` searches agent transcripts (async, in the core). */
export const SEARCH_PREFIX = "?";

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

export function Palette({
  items,
  recent = [],
  onRun,
  onClose,
  initialQuery = "",
  search,
  searchGroups = [],
  searchStatus,
  dynamic,
  fallback,
  groups,
  placeholder = "Type a command, @session, ?search…",
  footer,
  emptyText,
  label,
}: {
  items: PaletteItem[];
  /** Recently run item ids, most recent first; ranked first. */
  recent?: string[];
  onRun?: (id: string) => void;
  onClose: () => void;
  initialQuery?: string;
  /** The search for `?query`: it may `show` what it has so far, as each source answers, before it resolves. */
  search?: (text: string, show: (items: PaletteItem[]) => void) => Promise<PaletteItem[] | void>;
  /** Groups of `items` that `?query` matches too, listed before what `search` finds (open windows). */
  searchGroups?: string[];
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
  /** Its accessible name ("Command Palette"); the placeholder if not given. */
  label?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<PaletteItem[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // Prefixes only where they mean something: ? with a search, > and @ with their groups.
  const searching = !!search && query.startsWith(SEARCH_PREFIX);
  const searchText = searching ? query.slice(1).trim() : "";

  useEffect(() => input.current?.focus(), []);

  // Debounced transcript search; stale responses are dropped. The last results stay
  // until the next ones arrive, so the list doesn't collapse with every key.
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!searching || !search) return (setFound(null), setPending(false));
    if (!searchText) return (setFound([]), setPending(false));
    setPending(true);
    let live = true;
    const t = setTimeout(() => {
      const show = (r: PaletteItem[]) => live && setFound(r);
      void search(searchText, show).then(
        (r) => live && (r && setFound(r), setPending(false)),
        () => live && setPending(false),
      );
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [searching, searchText, search]);

  const results = useMemo(() => {
    if (searching) {
      const q = searchText.toLowerCase();
      const here = q
        ? items
            .filter((it) => searchGroups.includes(it.group))
            .map((it) => ({ it, s: score(it.meta ? `${it.label} ${it.meta}` : it.label, q) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s)
            .slice(0, 8)
            .map((x) => x.it)
        : [];
      return [...here, ...(found ?? [])];
    }
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
  }, [items, query, recent, searching, searchText, searchGroups, found, dynamic, fallback, groups]);

  // The highlighted row: the first for a new query; once moved, the same item while results arrive above it.
  const moved = useRef<string | null>(null);
  const pick = (i: number) => (setActive(i), (moved.current = results[i]?.id ?? null));
  useEffect(() => ((moved.current = null), setActive(0)), [query]);
  useEffect(() => {
    if (!moved.current) return;
    const i = results.findIndex((it) => it.id === moved.current);
    if (i >= 0) setActive(i);
  }, [results]);
  // Keep the active row in view as ↑↓ move past the list's edge (not on hover: the list would move under the mouse).
  const byKey = useRef(false);
  useEffect(() => {
    if (byKey.current) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
    byKey.current = false;
  }, [active]);

  const run = (it: PaletteItem | undefined, alt = false) => {
    if (!it) return;
    onClose();
    onRun?.(it.id);
    (alt && it.runAlt ? it.runAlt : it.run)();
  };

  const empty = searching
    ? searchText
      ? found === null || pending
        ? "Searching…"
        : "Nothing matches."
      : 'Search open windows and past Claude Code and Codex sessions. "Phrases" and -exclusions work.'
    : (emptyText ?? "Nothing matches. Type ? to search past agent sessions.");

  // A combobox over a listbox: scripts and VoiceOver find `option "New Terminal"`, and the highlighted one is selected.
  const id = useId();
  const optionId = (i: number) => `${id}-${i}`;
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className={`palette ${searching ? "searching" : ""}`} role="dialog" aria-label={label ?? placeholder} onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="palette-input"
          role="combobox"
          aria-expanded
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={results[active] ? optionId(active) : undefined}
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") (e.preventDefault(), (byKey.current = true), pick(Math.min(active + 1, results.length - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), (byKey.current = true), pick(Math.max(active - 1, 0)));
            else if (e.key === "Enter") run(results[active], e.metaKey);
          }}
        />
        <ul ref={list} className="palette-list" id={`${id}-list`} role="listbox" aria-label={label ?? placeholder}>
          {results.map((it, i) => (
            <Fragment key={it.id}>
            {/* Search mixes kinds: each kind under its name. */}
            {searching && results[i - 1]?.group !== it.group && (
              <li className="palette-heading" role="presentation">
                {HEADING[it.group] ?? it.group}
              </li>
            )}
            <li
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              aria-label={it.label}
              aria-description={it.meta ?? it.group}
              className={`${i === active ? "on" : ""} ${it.meta ? "rich" : ""}`}
              onMouseEnter={() => ((byKey.current = false), pick(i))}
              onClick={(e) => run(it, e.metaKey)}
            >
              {it.meta ? (
                <>
                {it.icon && <span className="palette-icon">{iconNode(it.icon, ICON.row)}</span>}
                <div className="palette-hit">
                  <div className="palette-hit-top">
                    <span className="palette-label">{it.label}</span>
                    <span className="palette-meta">{it.meta}</span>
                  </div>
                  {it.snippet && (
                    <div className="palette-snippet">
                      <Highlight text={it.snippet} />
                    </div>
                  )}
                </div>
                </>
              ) : (
                <>
                  <span className="palette-group">{!groups || results[i - 1]?.group !== it.group ? it.group : ""}</span>
                  {it.icon && <span className="palette-icon">{iconNode(it.icon, ICON.row)}</span>}
                  <span className="palette-label">{it.label}</span>
                  {it.hint && <kbd>{it.hint}</kbd>}
                </>
              )}
            </li>
            </Fragment>
          ))}
          {results.length === 0 && (
            <li className="palette-empty" role="presentation">
              {empty}
            </li>
          )}
        </ul>
        <footer className="palette-foot">
          {footer ?? (
            <>
              <span>
                <kbd>↑↓</kbd> move
              </span>
              <span>
                <kbd>↵</kbd> {searching ? "open" : "run"}
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
