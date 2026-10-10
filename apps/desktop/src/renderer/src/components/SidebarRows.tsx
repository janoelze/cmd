// Sidebar rows: open windows and agents (SessionRow), past sessions from the
// transcript index (HistoryRow), and the section headings that group them.

import { Chip, Highlight, IconButton, ListHeading, ListRow, Text, Twisty, TwistySpace } from "@cmd/ui";
import type { ReactNode } from "react";
import type { PaneId, SearchHit } from "@cmd/protocol";
import { usePersisted, useStoreValue } from "../store.ts";
import { ICON } from "./Symbol.tsx";
import { DirtyDot, Slot } from "./Slot.tsx";
import { useFields } from "./TileTitle.tsx";
import { ago, labelOf, project, shortPath, whereOf, windowIdOf, type SidebarRow } from "../model.ts";
import { RemoteBadge } from "./Remote.tsx";
import { countRender } from "../perf.ts";

/** "2h ago" → "2h": the column is narrow. */
export const shortAgo = (ts: number, now: number) => ago(ts, now).replace(/ ago$/, "");

/** A Navigator section: a tree named by its title, so a script finds `tree "Windows"` and its rows. */
export function SidebarSection({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <section className={`ui-list-section sb-section${className ? ` ${className}` : ""}`} role="tree" aria-label={title}>
      {children}
    </section>
  );
}

/** The Navigator's section headings: the kit's ListHeading. */
export function SectionHeading(p: {
  title: string;
  count?: number;
  /** Omitted: not collapsible. */
  open?: boolean;
  onToggle?: () => void;
  tone?: "needs";
}) {
  return <ListHeading {...p} />;
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
  const tall = !!(f.light || f.tone);
  const workspaceId = row.agent?.workspaceId ?? row.pane?.workspaceId;
  const workspace = useStoreValue((s) => (workspaceId ? s.workspaces.get(workspaceId) : undefined));
  const item = row.agent ?? row.pane;
  const where = tall && depth === 0 && !row.win && item ? whereOf(item.git, item.cwd, workspace) : null;

  return (
    <>
      <ListRow
        flipKey={row.key}
        depth={depth}
        selected={isSel}
        active={props.active}
        // A tree item named like its window's tile (labelOf), with its status as the description.
        role="treeitem"
        aria-label={labelOf(row)}
        aria-description={f.status?.text}
        aria-level={depth + 1}
        aria-selected={isSel}
        aria-expanded={kids.length > 0 ? open : undefined}
        onClick={() => onSelect(row)}
        onContextMenu={() => props.onMenu(row)}
        lead={kids.length > 0 ? <Twisty open={open} onToggle={() => setOpen(!open)} /> : (props.gutter || depth > 0) && <TwistySpace />}
        icon={f.icon}
        light={f.light}
        markTone={f.tone}
        title={
          <>
            <Slot value={{ text: f.name }} fade />
            <DirtyDot on={!!f.dirty} />
          </>
        }
        place={f.place}
        // Status if there is one ("does this need me?"), else Place ("which one is it?").
        detail={tall ? <Slot value={f.status} fallback={f.place ? { text: f.place } : undefined} /> : undefined}
        tone={(f.light ?? f.tone) === "needs" ? "needs" : undefined}
        end={
          <>
            {kids.length > 0 && !open && (
              <Text size="2xs" tone="dim">
                {doneKids}/{kids.length}
              </Text>
            )}
            <RemoteBadge id={winId} compact />
            {where && (
              <Chip hue={where.hue} tip={where.tip}>
                {where.text}
              </Chip>
            )}
          </>
        }
        hover={
          <>
            {shortcut && (
              <Text size="2xs" tone="dim">
                ⌘{shortcut}
              </Text>
            )}
            {winId && (
              <IconButton
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
          </>
        }
      />
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
  if (p.rich && h.snippet) detail = <Highlight text={h.snippet} />;
  return (
    <ListRow
      className="history"
      flipKey={`h-${h.agent}-${h.sessionId}`}
      active={p.active}
      role="treeitem"
      aria-label={h.title || "(untitled session)"}
      aria-description={where || h.agent}
      aria-level={1}
      aria-selected={false}
      data-tip-side="right"
      tip={[h.title, h.cwd ? shortPath(h.cwd) : null, `${h.agent} · ${h.sessionId}`].filter(Boolean).join("\n")}
      onClick={() => p.onOpen(h)}
      icon="clock.arrow.circlepath"
      markTone="dim"
      title={h.title || "(untitled session)"}
      place={!p.rich && where ? where : undefined}
      detail={p.rich ? detail : undefined}
      end={
        h.updatedAt && (
          <Text size="xs" tone="dim">
            {shortAgo(h.updatedAt, p.now)}
          </Text>
        )
      }
    />
  );
}
