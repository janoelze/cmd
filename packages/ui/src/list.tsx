// Lists: List of ListSections and ListGroups of ListRows, built from slots (an icon
// that cross-fades to a status light, the content: a title, where it is, a detail
// line, an end that gives way to actions on hover), one set for every window; and
// the Panel frame of the file browser's sidebar (a PanelHeader: a name that opens
// a menu, a summary, actions shown on hover). Chip is the coloured project label.

import { useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { timing, useFlip, useReveal } from "./motion.ts";
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

/**
 * Rows to act on or pick from: ListSections (a heading and its rows) and ListGroups
 * (rows without one) of ListRows, in a View without `inset`; the rows' text sits on the
 * window's inset and their highlights reach out of it. One list for every window: sections
 * stand apart by --section-gap after one that shows its rows, collapsed ones stack.
 * `nav`: the pages beside a page (Settings' sidebar), highlights on the inset like the
 * field above them.
 *
 * It moves as one: rows and sections that a render moved glide there (rows keyed by
 * flipKey, sections by their title), new ones fade in, removed ones fade out where they
 * were, and a section's rows fold and unfold on the glide. Views need nothing for it.
 */
export function List({ nav, children }: { nav?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Rows and sections; a row's icon and text move with it.
  useFlip(ref, { selector: "[data-key]", leave: true });
  return (
    <div ref={ref} className="ui-list" data-nav={nav || undefined}>
      {children}
    </div>
  );
}

/**
 * A heading and its rows; collapsed (open false), only the heading. Opening and closing
 * it unfolds and folds its rows on the glide. Its identity in its List's moves is
 * `flipKey`, else its title. Other attributes (role, aria-label) go on the section.
 */
export function ListSection({ title, count, open, onToggle, tone, flipKey, className, children, ...rest }: { title: ReactNode; count?: number; open?: boolean; onToggle?: () => void; tone?: "needs" | "danger"; flipKey?: string; className?: string; children?: ReactNode } & Omit<HTMLAttributes<HTMLElement>, "title" | "children">) {
  const shown = open !== false;
  // Its rows stay while they fold, until the fold has played.
  const [present, setPresent] = useState(shown);
  if (shown && !present) setPresent(true);
  const rows = useRef<HTMLDivElement>(null);
  /** Rows were on screen at the last toggle (else they unfold from nothing). */
  const had = useRef(present);
  const first = useRef(true);
  useLayoutEffect(() => {
    const el = rows.current;
    const fresh = !had.current;
    had.current = true;
    if (first.current) return void (first.current = false);
    if (!el) return;
    // From where the fold is now, whichever way it was going: toggling halfway turns it back.
    const cs = getComputedStyle(el);
    const from = fresh ? { height: "0px", paddingBottom: "0px", opacity: "0" } : { height: cs.height, paddingBottom: cs.paddingBottom, opacity: cs.opacity };
    for (const a of el.getAnimations()) if (a.id === "fold") a.cancel();
    // Its own size, unfolded (the padding is the gap after it).
    const to = shown ? { height: `${el.getBoundingClientRect().height}px`, paddingBottom: getComputedStyle(el).paddingBottom, opacity: "1" } : { height: "0px", paddingBottom: "0px", opacity: "0" };
    el.style.overflow = "hidden";
    const fold = el.animate([from, to], timing("glide", { id: "fold", fill: "forwards" }));
    fold.finished.then(
      () => {
        // Folded, it stays folded until its rows go (cancelling would show them for a frame).
        if (!shown) return void ((had.current = false), setPresent(false));
        fold.cancel();
        el.style.overflow = "";
      },
      () => {},
    );
  }, [shown]);
  return (
    <section className={cls("ui-list-section", className)} data-key={flipKey ?? (typeof title === "string" ? `section:${title}` : undefined)} {...rest}>
      <ListHeading title={title} count={count} open={open} onToggle={onToggle} tone={tone} />
      {present && (
        <div ref={rows} className="ui-list-rows" data-closing={!shown || undefined}>
          {children}
        </div>
      )}
    </section>
  );
}

/** Rows without a heading (a list's main action, above its sections). */
export function ListGroup({ children }: { children: ReactNode }) {
  return <div className="ui-list-rows">{children}</div>;
}

/** An icon that gives way to a status light when there is one; `tone` colours the icon (needs: orange; dim: a past session's). A row's (ListRowIcon) or a table cell's. */
export function Mark({ icon, light, tone }: { icon: string | ReactNode; light?: DotState; tone?: DotState | "dim" }) {
  return (
    <span className={cls("ui-mark", light && "has-light")} data-tone={tone}>
      <span className="ui-mark-icon">{iconNode(icon, ICON.small)}</span>
      <span className="ui-mark-light">
        <StatusDot state={light ?? "off"} />
      </span>
    </span>
  );
}

export interface ListRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "onClick" | "onDoubleClick" | "onContextMenu"> {
  selected?: boolean;
  /** The keyboard's row (search results). */
  active?: boolean;
  /** Faded: not among what a search found (Settings' pages while searching). */
  dim?: boolean;
  /** Indent, for a row under another (subagents). */
  depth?: number;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  onDoubleClick?: (e: MouseEvent<HTMLDivElement>) => void;
  onContextMenu?: (e: MouseEvent<HTMLDivElement>) => void;
  tip?: string;
  /** Its identity across renders, for a list that moves its rows (useFlip). */
  flipKey?: string;
  /** Scrolled into view (nearest edge) when it becomes true, once per change (useReveal). */
  reveal?: boolean;
  /** The row's parts, in order: Twisty or TwistySpace, ListRowIcon, ListRowContent, ListRowEnd, ListRowActions. */
  children: ReactNode;
}

/** A row. Its height follows its content: one line, or two when ListRowContent has a detail. */
export function ListRow({ selected, active, dim, depth, className, onClick, onDoubleClick, onContextMenu, tip, flipKey, reveal, style, children, ...rest }: ListRowProps) {
  const ref = useReveal<HTMLDivElement>(reveal);
  return (
    <div
      ref={ref}
      className={cls("ui-list-row", selected && "sel", active && "active", className)}
      data-key={flipKey}
      data-dim={dim || undefined}
      data-tip={tip}
      style={depth ? ({ ...style, "--depth": depth } as CSSProperties) : style}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={
        onContextMenu &&
        ((e) => {
          e.preventDefault();
          onContextMenu(e);
        })
      }
      {...rest}
    >
      {children}
    </div>
  );
}

/** A row's icon (Mark): it gives way to a status light; `tone` colours it. */
export function ListRowIcon(p: { icon: string | ReactNode; light?: DotState; tone?: DotState | "dim" }) {
  return <Mark {...p} />;
}

/** A row's text: the title, `place` after it (dim, gives way first; one-line rows), or a `detail` line under it (makes the row two lines; `tone` colours it). */
export function ListRowContent({ title, place, detail, tone, mono }: { title: ReactNode; place?: ReactNode; detail?: ReactNode; tone?: "needs" | "danger"; mono?: boolean }) {
  return (
    <div className="ui-list-row-content" data-tone={tone}>
      <div className="ui-list-row-title">
        <span className={cls("ui-list-row-name", mono && "mono")}>{title}</span>
        {detail == null && place != null && <span className="ui-list-row-place">{place}</span>}
      </div>
      {detail != null && <div className="ui-list-row-detail">{detail}</div>}
    </div>
  );
}

/** The row's right end: a chip, an age, values (ListValue). A chip gives way to ListRowActions on hover. */
export function ListRowEnd({ children }: { children: ReactNode }) {
  return <span className="ui-list-row-end">{children}</span>;
}

/** Actions shown while the pointer is over the row (close, run); clicks stay theirs. */
export function ListRowActions({ children }: { children: ReactNode }) {
  return (
    <span className="ui-list-row-actions" onClick={(e) => e.stopPropagation()}>
      {children}
    </span>
  );
}

/** A disclosure's space at a ListRow's start, where a row has none but its siblings do. */
export function TwistySpace() {
  return <span className="ui-twisty-space" />;
}

/** A disclosure twisty at a ListRow's start. */
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
export function Chip({ hue, children, tip }: { /** Without one, the neutral tint (the CSS default). */ hue?: number; children: ReactNode; tip?: string }) {
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
