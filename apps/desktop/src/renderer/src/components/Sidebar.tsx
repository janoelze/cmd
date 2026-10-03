import { useEffect, useRef, useState } from "react";
import type { PaneId } from "@cmd/protocol";
import { bucketOf } from "@cmd/protocol";
import { usePersisted } from "../store.ts";
import { ICON, Symbol } from "./Symbol.tsx";
import { DirtyDot, Mark, Slot } from "./Slot.tsx";
import { useFields } from "./TileTitle.tsx";
import { windowIdOf, flatten, ledOf, project, projectHue, type SidebarRow } from "../model.ts";
import { Tools } from "./Tools.tsx";

export type SidebarTab = "sessions" | "tools";

interface Props {
  tab: SidebarTab;
  onTab: (t: SidebarTab) => void;
  rows: SidebarRow[];
  selected: PaneId | null;
  onSelect: (row: SidebarRow) => void;
  onRowMenu: (row: SidebarRow) => void;
  onNewTerminal: () => void;
  stats: { agents: number; working: number; waiting: number };
  connected: boolean;
  error?: string;
}

export function Sidebar(p: Props) {
  const rows = useFrozenOrder(p.rows);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const needs = rows.filter((r) => r.urgent && bucketOf(r.urgent) === "needs").length;
  // ⌘1–9 follow the visible order of rows that have a terminal.
  const shortcutOf = new Map(
    flatten(rows)
      .filter((r) => r.pane || r.win)
      .slice(0, 9)
      .map((r, i) => [r.key, i + 1]),
  );

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-tabs" role="tablist">
          <button role="tab" className={p.tab === "sessions" ? "on" : ""} onClick={() => p.onTab("sessions")}>
            Sessions
          </button>
          <button role="tab" className={p.tab === "tools" ? "on" : ""} onClick={() => p.onTab("tools")}>
            Tools
          </button>
        </div>

        {p.tab === "sessions" ? (
          <div className="session-list" data-frozen={rows !== p.rows || undefined}>
            {needs > 0 && <div className="list-heading">Needs you · {needs}</div>}
            {rows.map((r, i) => (
              <RowView
                key={r.key}
                row={r}
                depth={0}
                now={now}
                selected={p.selected}
                onSelect={p.onSelect}
                onMenu={p.onRowMenu}
                shortcutOf={shortcutOf}
                divider={needs > 0 && i === needs}
              />
            ))}
            {rows.length === 0 && (
              <div className="empty">
                <p>No sessions yet.</p>
                <button className="btn" onClick={p.onNewTerminal}>
                  New Terminal <kbd>⌘T</kbd>
                </button>
              </div>
            )}
          </div>
        ) : (
          <Tools />
        )}
      </aside>
      {/* In the app's bottom row, beside the main status bar: both share one height. */}
      <footer className="sidebar-status">
        <span className={`led led-${p.connected ? "idle" : "off"}`} />
        {p.connected
          ? `${p.stats.agents} agent${p.stats.agents === 1 ? "" : "s"} · ${p.stats.working} working · ${p.stats.waiting} waiting`
          : p.error
            ? `core error: ${p.error}`
            : "core offline — reconnecting…"}
      </footer>
    </>
  );
}

function RowView(props: {
  row: SidebarRow;
  depth: number;
  now: number;
  selected: PaneId | null;
  onSelect: (r: SidebarRow) => void;
  onMenu: (r: SidebarRow) => void;
  shortcutOf: Map<string, number>;
  divider?: boolean;
}) {
  const { row, depth, now, selected, onSelect } = props;
  const shortcut = props.shortcutOf.get(row.key);
  const [collapsed, setCollapsed] = usePersisted<string[]>("sidebar.collapsed", []);
  const open = !collapsed.includes(row.key);
  const setOpen = (o: boolean) => setCollapsed((c) => (o ? c.filter((k) => k !== row.key) : [...c, row.key].slice(-200)));
  const led = ledOf(row.agent);
  const f = useFields(row, now)!;
  const proj = row.win ? null : project(row.agent?.cwd ?? row.pane?.cwd ?? "");
  const hasKids = row.children.length > 0;
  const doneKids = row.children.filter((c) => c.agent && ["done", "exited"].includes(c.agent.state)).length;
  const winId = windowIdOf(row);
  const isSel = !!winId && winId === selected;

  return (
    <>
      {props.divider && <div className="list-divider" />}
      <div
        className={`row ${isSel ? "sel" : ""} led-row-${led} ${winId ? "" : "virtual"}`}
        style={{ paddingLeft: 10 + depth * 16 }}
        onClick={() => onSelect(row)}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onMenu(row);
        }}
      >
        {hasKids ? (
          <button
            className={`twisty ${open ? "open" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(!open);
            }}
            aria-label={open ? "Collapse" : "Expand"}
          >
            <Symbol name="chevron.right" size={ICON.disclosure} />
          </button>
        ) : (
          <span className="twisty-space" />
        )}
        <Mark light={f.light} icon={f.icon} />
        <div className="row-text">
          <div className="row-title">
            <Slot value={{ text: f.name }} fade />
            <DirtyDot on={!!f.dirty} />
            {hasKids && !open && <span className="badge">{doneKids}/{row.children.length}</span>}
          </div>
          {/* Status if there is one ("does this need me?"), else Place ("which one is it?"). */}
          <div className="row-detail">
            <Slot value={f.status ?? (f.place ? { text: f.place } : undefined)} />
          </div>
        </div>
        {depth === 0 && proj && (
          <span className="chip" style={{ ["--hue" as string]: projectHue(proj) }}>
            {proj}
          </span>
        )}
        {shortcut && <span className="row-key">⌘{shortcut}</span>}
      </div>
      {open &&
        row.children.map((c) => (
          <RowView
            key={c.key}
            row={c}
            depth={depth + 1}
            now={now}
            selected={selected}
            onSelect={onSelect}
            onMenu={props.onMenu}
            shortcutOf={props.shortcutOf}
          />
        ))}
    </>
  );
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
    const el = document.querySelector(".sidebar");
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
