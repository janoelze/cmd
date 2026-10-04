// Sidebar rows: open windows and agents (SessionRow), past sessions from the
// transcript index (HistoryRow), and the section headings that group them.

import { IconButton } from "@cmd/ui";
import type { ReactNode } from "react";
import type { PaneId, SearchHit } from "@cmd/protocol";
import { usePersisted } from "../store.ts";
import { ICON, Symbol } from "./Symbol.tsx";
import { DirtyDot, Mark, Slot } from "./Slot.tsx";
import { Highlighted } from "./Palette.tsx";
import { useFields } from "./TileTitle.tsx";
import { ago, project, projectHue, shortPath, windowIdOf, type SidebarRow } from "../model.ts";
import { RemoteBadge } from "./Remote.tsx";
import { countRender } from "../perf.ts";

/** "2h ago" → "2h": the column is narrow. */
export const shortAgo = (ts: number, now: number) => ago(ts, now).replace(/ ago$/, "");

export function SectionHeading(p: {
  title: string;
  count?: number;
  /** Omitted: not collapsible. */
  open?: boolean;
  onToggle?: () => void;
  tone?: "needs";
}) {
  const collapsible = p.onToggle !== undefined;
  return (
    <div
      className={`sb-heading ${collapsible ? "collapsible" : ""} ${p.tone ? `tone-${p.tone}` : ""}`}
      onClick={p.onToggle}
      role={collapsible ? "button" : undefined}
      aria-expanded={collapsible ? p.open : undefined}
    >
      <span className="sb-heading-title">{p.title}</span>
      {p.count !== undefined && <span className="sb-count">{p.count}</span>}
      {collapsible && (
        <span className={`twisty ${p.open ? "open" : ""}`}>
          <Symbol name="chevron.right" size={ICON.disclosure} />
        </span>
      )}
    </div>
  );
}

export function SessionRow(props: {
  row: SidebarRow;
  depth: number;
  now: number;
  selected: PaneId | null;
  onSelect: (r: SidebarRow) => void;
  onMenu: (r: SidebarRow) => void;
  onClose: (r: SidebarRow) => void;
  shortcutOf: Map<string, number>;
  /** Search results: no children, active row of the keyboard selection. */
  flat?: boolean;
  /** Reserve the disclosure column (some row in the list has children). */
  gutter?: boolean;
  active?: boolean;
}) {
  countRender("SessionRow");
  const { row, depth, now, selected, onSelect } = props;
  const shortcut = props.shortcutOf.get(row.key);
  const [collapsed, setCollapsed] = usePersisted<string[]>("sidebar.collapsed", []);
  const open = !collapsed.includes(row.key);
  const setOpen = (o: boolean) => setCollapsed((c) => (o ? c.filter((k) => k !== row.key) : [...c, row.key].slice(-200)));
  const f = useFields(row, now)!;
  const kids = props.flat ? [] : row.children;
  const doneKids = kids.filter((c) => c.agent && ["done", "exited"].includes(c.agent.state)).length;
  const winId = windowIdOf(row);
  const isSel = !!winId && winId === selected;
  // Agents and terminals that want you get a second line for their status;
  // everything else is one line: name, then where it is.
  const tall = !!f.light;
  const proj = tall && depth === 0 && !row.win ? project(row.agent?.cwd ?? row.pane?.cwd ?? "") : null;

  return (
    <>
      <div
        className={`row ${tall ? "tall" : "short"} ${isSel ? "sel" : ""} ${props.active ? "active" : ""} led-row-${f.light ?? "none"} ${winId ? "" : "virtual"}`}
        style={{ paddingLeft: 14 + depth * 14 }}
        data-key={row.key}
        onClick={() => onSelect(row)}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onMenu(row);
        }}
      >
        {kids.length > 0 ? (
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
          (props.gutter || depth > 0) && <span className="twisty-space" />
        )}
        <Mark light={f.light} icon={f.icon} />
        <div className="row-text">
          <div className="row-title">
            <Slot value={{ text: f.name }} fade />
            <DirtyDot on={!!f.dirty} />
            {!tall && f.place && <span className="row-place">{f.place}</span>}
            {kids.length > 0 && !open && (
              <span className="badge">
                {doneKids}/{kids.length}
              </span>
            )}
          </div>
          {/* Status if there is one ("does this need me?"), else Place ("which one is it?"). */}
          {tall && (
            <div className="row-detail">
              <Slot value={f.status} fallback={f.place ? { text: f.place } : undefined} />
            </div>
          )}
        </div>
        <span className="row-end">
          <RemoteBadge id={winId} compact />
          {proj && proj !== "~" && (
            <span className="chip" style={{ ["--hue" as string]: projectHue(proj) }}>
              {proj}
            </span>
          )}
          <span className="row-hover">
            {shortcut && <span className="row-key">⌘{shortcut}</span>}
            {winId && (
              <IconButton
                className="row-close"
                size="sm"
                icon="xmark"
                iconSize={ICON.disclosure}
                label="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose(row);
                }}
              />
              
            )}
          </span>
        </span>
      </div>
      {open &&
        kids.map((c) => (
          <SessionRow key={c.key} {...props} row={c} depth={depth + 1} active={false} />
        ))}
    </>
  );
}

/** A past session from the transcript index; click switches to it or resumes it. */
export function HistoryRow(p: { hit: SearchHit; now: number; onOpen: (h: SearchHit) => void; active?: boolean; rich?: boolean }) {
  const h = p.hit;
  const where = [h.cwd ? project(h.cwd) : null, h.branch].filter(Boolean).join(" · ");
  let detail: ReactNode = where || h.agent;
  if (p.rich && h.snippet) detail = <Highlighted text={h.snippet} />;
  return (
    <div
      className={`row history ${p.rich ? "tall" : "short"} ${p.active ? "active" : ""}`}
      data-key={`h-${h.agent}-${h.sessionId}`}
      data-tip-side="right"
      data-tip={[h.title, h.cwd ? shortPath(h.cwd) : null, `${h.agent} · ${h.sessionId}`].filter(Boolean).join("\n")}
      onClick={() => p.onOpen(h)}
    >
      <Mark icon="clock.arrow.circlepath" />
      <div className="row-text">
        <div className="row-title">
          <span className="row-name">{h.title || "(untitled session)"}</span>
          {!p.rich && where && <span className="row-place">{where}</span>}
        </div>
        {p.rich && <div className="row-detail">{detail}</div>}
      </div>
      {h.updatedAt && <span className="row-age">{shortAgo(h.updatedAt, p.now)}</span>}
    </div>
  );
}
