// Lists like the Navigator's and the file browser's sidebar: a Panel with a
// PanelHeader (a name that opens a menu, a summary, actions shown on hover),
// then ListSections of ListRows (a mark that cross-fades from an icon to a
// status light, a title, where it is, a detail line, an end that gives way to
// actions on hover). Chip is the coloured project label rows carry.

import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { ICON, iconNode } from "./icon.tsx";
import { StatusDot, type DotState } from "./status.tsx";

const cls = (...c: (string | false | undefined | null)[]) => c.filter(Boolean).join(" ");

/** A list view's frame. Its header's actions show while the pointer is over it or it has focus. */
export function Panel({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={cls("ui-panel", className)} style={style}>
      {children}
    </div>
  );
}

/** A Panel's scrolling body. */
export function PanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cls("ui-panel-body", className)}>{children}</div>;
}

export function PanelHeader({
  title,
  onTitleClick,
  titleTip,
  children,
  actions,
}: {
  title: ReactNode;
  /** The title becomes a button with a chevron (a menu: scope, folder, filters). */
  onTitleClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  titleTip?: string;
  /** After the title: a summary, a count, a toggle. */
  children?: ReactNode;
  /** Right end, shown on hover. */
  actions?: ReactNode;
}) {
  const label = <span className="ui-panel-title-label">{title}</span>;
  return (
    <div className="ui-panel-head">
      {onTitleClick ? (
        <button type="button" className="ui-panel-title" data-tip={titleTip} onClick={onTitleClick}>
          {label}
          {iconNode("chevron.down", ICON.disclosure)}
        </button>
      ) : (
        <span className="ui-panel-title" data-tip={titleTip}>
          {label}
        </span>
      )}
      {children}
      {actions && <div className="ui-panel-actions">{actions}</div>}
    </div>
  );
}

/** A summary in a PanelHeader: short, dim, or in a tone. */
export function PanelSummary({ children, tone }: { children: ReactNode; tone?: "needs" | "danger" }) {
  return (
    <span className="ui-panel-summary" data-tone={tone}>
      {children}
    </span>
  );
}

/** A section heading with a count; with onToggle it collapses (chevron on hover). */
export function ListHeading({ title, count, open, onToggle, tone }: { title: ReactNode; count?: number; open?: boolean; onToggle?: () => void; tone?: "needs" | "danger" }) {
  const collapsible = onToggle !== undefined;
  return (
    <div
      className={cls("ui-list-heading", collapsible && "collapsible")}
      data-tone={tone}
      onClick={onToggle}
      role={collapsible ? "button" : undefined}
      // Named by the title alone: a count in the name would change under a script looking for it.
      aria-label={collapsible && typeof title === "string" ? title : undefined}
      aria-description={collapsible && count !== undefined ? String(count) : undefined}
      aria-expanded={collapsible ? open : undefined}
    >
      <span className="ui-list-heading-title">{title}</span>
      {count !== undefined && <span className="ui-list-count">{count}</span>}
      {collapsible && <span className={cls("ui-twisty", open && "open")}>{iconNode("chevron.right", ICON.disclosure)}</span>}
    </div>
  );
}

/** A heading and its rows; collapsed, only the heading. */
export function ListSection(p: { title: ReactNode; count?: number; open?: boolean; onToggle?: () => void; tone?: "needs" | "danger"; children: ReactNode }) {
  return (
    <section className="ui-list-section">
      <ListHeading title={p.title} count={p.count} open={p.open} onToggle={p.onToggle} tone={p.tone} />
      {p.open !== false && p.children}
    </section>
  );
}

/** An icon that gives way to a status light when there is one. */
export function ListMark({ icon, light }: { icon: string | ReactNode; light?: DotState }) {
  return (
    <span className={cls("ui-mark", light && "has-light")}>
      <span className="ui-mark-icon">{iconNode(icon, ICON.small)}</span>
      <span className="ui-mark-light">
        <StatusDot state={light ?? "off"} />
      </span>
    </span>
  );
}

export interface ListRowProps {
  icon?: string | ReactNode;
  /** A status light in place of the icon. */
  light?: DotState;
  title: ReactNode;
  /** After the title, dim; gives way first. One-line rows only. */
  place?: ReactNode;
  /** A second line (status, what happened). Makes the row tall. */
  detail?: ReactNode;
  /** The detail in a tone: needs (orange), danger (red). */
  tone?: "needs" | "danger";
  /** Right end: a chip, an age, numbers. */
  end?: ReactNode;
  /** Right end on hover, in place of the chip: actions. */
  hover?: ReactNode;
  selected?: boolean;
  /** The keyboard's row (search results). */
  active?: boolean;
  depth?: number;
  /** Before the mark: a disclosure twisty, or its space. */
  lead?: ReactNode;
  mono?: boolean;
  className?: string;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  onDoubleClick?: (e: MouseEvent<HTMLDivElement>) => void;
  onContextMenu?: (e: MouseEvent<HTMLDivElement>) => void;
  tip?: string;
}

export function ListRow(p: ListRowProps) {
  return (
    <div
      className={cls("ui-list-row", p.detail != null ? "tall" : "short", p.selected && "sel", p.active && "active", p.className)}
      data-tone={p.tone}
      data-tip={p.tip}
      style={p.depth ? ({ "--depth": p.depth } as CSSProperties) : undefined}
      onClick={p.onClick}
      onDoubleClick={p.onDoubleClick}
      onContextMenu={
        p.onContextMenu &&
        ((e) => {
          e.preventDefault();
          p.onContextMenu!(e);
        })
      }
    >
      {p.lead}
      {p.icon !== undefined && <ListMark icon={p.icon} light={p.light} />}
      <div className="ui-list-row-text">
        <div className="ui-list-row-title">
          <span className={cls("ui-list-row-name", p.mono && "mono")}>{p.title}</span>
          {p.detail == null && p.place != null && <span className="ui-list-row-place">{p.place}</span>}
        </div>
        {p.detail != null && <div className="ui-list-row-detail">{p.detail}</div>}
      </div>
      {(p.end || p.hover) && (
        <span className="ui-list-row-end">
          {p.end}
          {p.hover && <span className="ui-list-row-hover" onClick={(e) => e.stopPropagation()}>{p.hover}</span>}
        </span>
      )}
    </div>
  );
}

/** A disclosure twisty for a ListRow's lead. */
export function Twisty({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={cls("ui-twisty", open && "open")}
      aria-label={open ? "Collapse" : "Expand"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {iconNode("chevron.right", ICON.disclosure)}
    </button>
  );
}

/** A label in a colour of its own, from a hue (a project's, see the app's projectHue). */
export function Chip({ hue, children, tip }: { hue: number; children: ReactNode; tip?: string }) {
  return (
    <span className="ui-chip" data-tip={tip} style={{ "--hue": hue } as CSSProperties}>
      {children}
    </span>
  );
}

/** Tabular numbers at a row's end (CPU, memory, durations). */
export function ListValue({ children, strong }: { children: ReactNode; strong?: boolean }) {
  return (
    <span className="ui-list-value" data-strong={strong || undefined}>
      {children}
    </span>
  );
}
