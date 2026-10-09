// Draft (docs/40-window-design.md): laying out a window's content. Spacing
// belongs to these and nothing else: Stack, Inline and Tiles space their
// children, View pads a window's body, and kit components have no outer
// margins. Gaps and paddings take only the names of the --space-* scale.
//
// View is a window's content frame: toolbar, body, footer, and the state that
// replaces the body (loading, empty, no results, error). Split puts a sidebar or
// an inspector beside it; Panes and Pane are a dashboard's sections. The body is
// a size container, so these adapt to the window, not to the screen.

import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { ICON, iconNode } from "./icon.tsx";
import { Spinner, type Tone } from "./status.tsx";

const cls = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/** The spacing scale (tokens.css --space-*). */
export type Space = "none" | "2xs" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";
const sp = (s: Space | undefined) => (s === undefined ? undefined : s === "none" ? "0" : `var(--space-${s})`);

type Align = "start" | "center" | "end" | "stretch" | "baseline";

/** Children in a column, `gap` apart. */
export function Stack({ gap = "md", pad, align, grow, children }: { gap?: Space; pad?: Space; align?: Align; grow?: boolean; children: ReactNode }) {
  return (
    <div className="ui-stack" data-align={align} data-grow={grow || undefined} style={{ gap: sp(gap), padding: sp(pad) }}>
      {children}
    </div>
  );
}

/** Children in a row, `gap` apart; `justify="between"` puts the first and last at the ends. */
export function Inline({ gap = "sm", align = "center", justify, wrap, grow, children }: { gap?: Space; align?: Align; justify?: "start" | "between" | "end"; wrap?: boolean; grow?: boolean; children: ReactNode }) {
  return (
    <div className="ui-inline" data-align={align} data-justify={justify} data-wrap={wrap || undefined} data-grow={grow || undefined} style={{ gap: sp(gap) }}>
      {children}
    </div>
  );
}

/** Equal tiles, as many to a row as fit at `min` wide. */
export function Tiles({ min = 160, gap = "md", children }: { min?: 96 | 120 | 160 | 200 | 240 | 320; gap?: Space; children: ReactNode }) {
  return (
    <div className="ui-tiles" style={{ gap: sp(gap), "--tile-min": `${min}px` } as CSSProperties}>
      {children}
    </div>
  );
}

/** Hidden when the window is narrower than `below` (narrow: 360px, regular: 600px). */
export function Hide({ below, children }: { below: "narrow" | "regular"; children: ReactNode }) {
  return (
    <div className="ui-hide" data-below={below}>
      {children}
    </div>
  );
}

/** What a view shows instead of its content. */
export type ViewStateSpec =
  | { kind: "loading"; title?: ReactNode }
  | { kind: "empty"; icon?: string; title: ReactNode; text?: ReactNode; action?: ReactNode }
  | { kind: "noResults"; title?: ReactNode; text?: ReactNode; action?: ReactNode }
  | { kind: "error"; title: ReactNode; text?: ReactNode; action?: ReactNode };

/** Loading, empty (nothing yet), no results (after a filter), error (what went wrong, and a way on). Fills the body. */
export function ViewState({ state }: { state: ViewStateSpec }) {
  if (state.kind === "loading")
    return (
      <div className="ui-viewstate" role="status">
        <Spinner size={16} label="Loading" />
        {state.title && <div className="ui-viewstate-text">{state.title}</div>}
      </div>
    );
  const icon = state.kind === "empty" ? state.icon : state.kind === "noResults" ? "magnifyingglass" : "exclamationmark.triangle";
  const title = state.kind === "noResults" ? (state.title ?? "No Results") : state.title;
  return (
    <div className="ui-viewstate" data-kind={state.kind} role={state.kind === "error" ? "alert" : undefined}>
      {icon && <span className="ui-viewstate-icon">{iconNode(icon, ICON.empty, "light")}</span>}
      <div className="ui-viewstate-title">{title}</div>
      {state.text && <div className="ui-viewstate-text">{state.text}</div>}
      {state.action && <div className="ui-viewstate-action">{state.action}</div>}
    </div>
  );
}

/**
 * A window's content: the toolbar (a WindowToolbar), the body, a footer bar.
 * `inset` pads the body by the window inset; leave it off for content that runs
 * edge to edge (a table, an image, a list with its own row insets). `state`
 * replaces the body.
 */
export function View({ toolbar, footer, state, inset, scroll = true, children }: { toolbar?: ReactNode; footer?: ReactNode; state?: ViewStateSpec | null; inset?: boolean; scroll?: boolean; children?: ReactNode }) {
  return (
    <div className="ui-view">
      {toolbar}
      <div className="ui-view-body" data-inset={(inset && !state) || undefined} data-scroll={scroll || undefined}>
        {state ? <ViewState state={state} /> : children}
      </div>
      {footer && <div className="ui-view-footer">{footer}</div>}
    </div>
  );
}

/** One line of a footer or status: dim, small, items spaced; `end` sits at the right. */
export function StatusLine({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="ui-status-line">
      <span className="ui-status-line-main">{children}</span>
      {end && <span className="ui-status-line-end">{end}</span>}
    </div>
  );
}

/**
 * A sidebar (side "start") or an inspector (side "end") beside the main content,
 * resizable between `min` and `max`. Hidden when the window is too narrow for both.
 */
export function Split({ side = "start", pane, open = true, width = { min: 160, ideal: 220, max: 360 }, children }: { side?: "start" | "end"; pane: ReactNode; open?: boolean; width?: { min: number; ideal: number; max: number }; children: ReactNode }) {
  const [w, setW] = useState(width.ideal);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, w };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const dx = (e.clientX - drag.current.x) * (side === "start" ? 1 : -1);
    setW(Math.min(width.max, Math.max(width.min, drag.current.w + dx)));
  };
  return (
    <div className="ui-split" data-side={side} data-open={open || undefined} style={{ "--split-w": `${w}px` } as CSSProperties}>
      {open && (
        <aside className="ui-split-pane">
          {pane}
          <div className="ui-split-handle" onPointerDown={down} onPointerMove={move} onPointerUp={() => (drag.current = null)} onDoubleClick={() => setW(width.ideal)} />
        </aside>
      )}
      <div className="ui-split-main">{children}</div>
    </div>
  );
}

/** A dashboard's sections: one column, side by side once the window is wide. */
export function Panes({ children }: { children: ReactNode }) {
  return <div className="ui-panes">{children}</div>;
}

/** One section: a title line (the name; `aside` at the right: a count, a link), then its content. `wide` spans every column. */
export function Pane({ title, aside, wide, children }: { title?: ReactNode; aside?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <section className="ui-pane" data-wide={wide || undefined}>
      {(title || aside) && (
        <header className="ui-pane-head">
          {title && <h3 className="ui-pane-title">{title}</h3>}
          {aside && <span className="ui-pane-aside">{aside}</span>}
        </header>
      )}
      {children}
    </section>
  );
}

/** A metric: its label, the value in mono with a dim unit, a change, and something under it (a sparkline). */
export function Stat({ label, value, unit, delta, deltaTone, children }: { label: ReactNode; value: ReactNode; unit?: ReactNode; delta?: ReactNode; deltaTone?: Tone; children?: ReactNode }) {
  return (
    <div className="ui-stat">
      <div className="ui-stat-label">{label}</div>
      <div className="ui-stat-value">
        {value}
        {unit && <span className="ui-stat-unit">{unit}</span>}
        {delta && (
          <span className="ui-stat-delta" data-tone={deltaTone}>
            {delta}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/** A reading column: prose at a comfortable width, centred in the window, with room above and below. */
export function Measure({ children }: { children: ReactNode }) {
  return <div className="ui-measure">{children}</div>;
}

/** Media on a dark stage, scaled to fit and centred; `caption` under it. */
export function MediaStage({ src, alt, caption }: { src: string; alt: string; caption?: ReactNode }) {
  return (
    <figure className="ui-media">
      <img className="ui-media-img" src={src} alt={alt} draggable={false} />
      {caption && <figcaption className="ui-media-caption">{caption}</figcaption>}
    </figure>
  );
}

/** A row of thumbnails along a window's edge; the selected one ringed. Scrolls sideways. */
export function Filmstrip({ items, selected, onSelect }: { items: readonly { key: string; src: string; label: string }[]; selected?: string; onSelect?: (key: string) => void }) {
  return (
    <div className="ui-filmstrip" role="listbox" aria-orientation="horizontal">
      {items.map((it) => (
        <button key={it.key} type="button" role="option" aria-selected={it.key === selected} className="ui-filmstrip-item" data-tip={it.label} onClick={() => onSelect?.(it.key)}>
          <img src={it.src} alt={it.label} draggable={false} />
        </button>
      ))}
    </div>
  );
}

/** Text in one of the kit's roles: `dim` for secondary, `mono` for values and IDs, `strong` for a name; `truncate` cuts one line with an ellipsis. */
export function Text({ tone, size, mono, strong, truncate, children }: { tone?: "dim" | Tone; size?: "xs" | "sm" | "md" | "base" | "lg" | "xl"; mono?: boolean; strong?: boolean; truncate?: boolean; children: ReactNode }) {
  return (
    <span className="ui-text" data-tone={tone} data-size={size} data-mono={mono || undefined} data-strong={strong || undefined} data-truncate={truncate || undefined}>
      {children}
    </span>
  );
}
