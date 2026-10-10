// Laying out a window's content (docs/40-window-design.md, the window-design skill). Spacing
// belongs to these and nothing else: Stack, Inline and Tiles space their
// children, View pads a window's body, and kit components have no outer
// margins. Gaps and paddings take only the names of the --space-* scale.
//
// View is a window's content frame: toolbar, body, footer, and the state that
// replaces the body (loading, empty, no results, error). Split puts a sidebar or
// an inspector beside it; Panes and Pane are a dashboard's sections. The body is
// a size container, so these adapt to the window, not to the screen.

import type * as React from "react";
import { forwardRef, useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type PointerEvent, type ReactNode, type Ref, type UIEvent } from "react";
import { ICON, iconNode } from "./icon.tsx";
import { Spinner, type Tone } from "./status.tsx";
import type { SpaceName, TextSize } from "./tokens.gen.ts";

const cls = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/** The spacing scale (--space-*, tokens/space.tokens.json), or none. */
export type Space = "none" | SpaceName;
const sp = (s: Space | undefined) => (s === undefined ? undefined : s === "none" ? "0" : `var(--space-${s})`);

type Align = "start" | "center" | "end" | "stretch" | "baseline";

/** Children in a column, `gap` apart. */
export function Stack({ gap = "md", pad, align, grow, children }: { gap?: Space; pad?: Space; align?: Align; grow?: boolean; children: ReactNode }) {
  return (
    <div className="ui-stack" data-align={align} data-grow={grow || undefined} data-pad={pad && pad !== "none" ? pad : undefined} style={{ gap: sp(gap), padding: sp(pad) }}>
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

/**
 * Hidden when the window is narrower than `below`, or from `above` on (narrow: 360px,
 * regular: 600px): what gives way as a window narrows, or what stands in for it (a
 * table picker in the toolbar once a Split's sidebar is gone). Works in a toolbar too.
 */
export function Hide({ below, above, children }: { below?: "narrow" | "regular"; above?: "narrow" | "regular"; children: ReactNode }) {
  return (
    <div className="ui-hide" data-below={below} data-above={above}>
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

/** A path or URL in a sentence may break after its slashes, so balanced wrapping splits it there rather than mid-name. */
const breakable = (t: ReactNode): ReactNode => (typeof t === "string" ? t.replace(/([/\\])(?=\S)/g, "$1\u200b") : t);

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
  const title = state.kind === "noResults" ? (state.title ?? "No results") : state.title;
  return (
    <div className="ui-viewstate" data-kind={state.kind} role={state.kind === "error" ? "alert" : undefined}>
      {icon && <span className="ui-viewstate-icon">{iconNode(icon, ICON.empty, "light")}</span>}
      <div className="ui-viewstate-title">{title}</div>
      {state.text && <div className="ui-viewstate-text">{breakable(state.text)}</div>}
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
export function View({ toolbar, footer, state, inset, scroll = true, focusable, bodyRef, onScroll, children }: { toolbar?: ReactNode; footer?: ReactNode; state?: ViewStateSpec | null; inset?: boolean; scroll?: boolean; /** The body takes keyboard focus (arrow keys and Page Down scroll it). */ focusable?: boolean; bodyRef?: Ref<HTMLDivElement>; onScroll?: (e: UIEvent<HTMLDivElement>) => void; children?: ReactNode }) {
  return (
    <div className="ui-view">
      {toolbar}
      <div ref={bodyRef} className="ui-view-body" tabIndex={focusable ? 0 : undefined} data-inset={(inset && !state) || undefined} data-scroll={scroll || undefined} onScroll={onScroll}>
        {state ? <ViewState state={state} /> : children}
      </div>
      {footer && <div className="ui-view-footer">{footer}</div>}
    </div>
  );
}

/**
 * The band under the traffic lights in a window of its own (Settings), in place of a
 * toolbar: the window drags by it. With a title, the page's, large, lined up with the
 * `Page` under it, and `line` once that page scrolls; without one, a sidebar's top.
 */
export function TitleBand({ title, line }: { title?: ReactNode; line?: boolean }) {
  return (
    <header className="ui-title-band" data-line={line || undefined}>
      {title != null && <h1 className="ui-page">{title}</h1>}
    </header>
  );
}

/** A page of settings rows (FormSection) in a padded View: as wide as they read well (--page-w), centred past it. */
export function Page({ children }: { children: ReactNode }) {
  return <div className="ui-page">{children}</div>;
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
 * resizable between `min` and `max`. Hidden below the regular size (600px); offer what
 * it held another way there (`<Hide above="regular">` in the toolbar).
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

/**
 * A value to read across the room in a ring that shows how much is left (a timer):
 * the ring fills the view as large as it fits, the value large and thin inside it,
 * a quiet caption under it ("ends 14:32"). `progress` is how much of the ring is
 * drawn (1: full). With `onEdit` the value is a button that asks to edit it; with
 * `edit` it is a field (Enter commits, Escape cancels, so does leaving it).
 */
export function Dial({ progress, tone, value, caption, label, onEdit, edit }: {
  progress: number;
  /** The ring and value: accent (running), needs (done), dim (paused or idle). */
  tone?: "accent" | "needs" | "dim";
  value: string;
  caption?: ReactNode;
  /** The value's steady name ("Time"); the value is its description. */
  label: string;
  onEdit?: () => void;
  edit?: { text: string; onChange: (t: string) => void; onCommit: () => void; onCancel: () => void };
}) {
  const f = Math.max(0, Math.min(1, progress));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (edit) input.current?.select();
  }, [!!edit]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ui-dial" data-tone={tone}>
      <div className="ui-dial-face">
        <svg className="ui-dial-ring" viewBox="0 0 100 100" aria-hidden>
          <circle className="ui-dial-track" cx="50" cy="50" r="47" />
          {f > 0 && <circle className="ui-dial-fill" cx="50" cy="50" r="47" pathLength={100} strokeDasharray={`${f * 100} 100`} transform="rotate(-90 50 50)" />}
        </svg>
        <div className="ui-dial-center">
          {edit ? (
            <input
              ref={input}
              className="ui-dial-value"
              data-editing
              value={edit.text}
              aria-label={label}
              onChange={(e) => edit.onChange(e.target.value)}
              onBlur={edit.onCommit}
              onKeyDown={(e) => {
                if (e.key === "Enter") edit.onCommit();
                if (e.key === "Escape") edit.onCancel();
              }}
            />
          ) : (
            <button type="button" className="ui-dial-value" aria-label={label} aria-description={value} data-tip={onEdit ? `Set ${label}` : undefined} disabled={!onEdit} onClick={onEdit}>
              {value}
            </button>
          )}
          {caption && <div className="ui-dial-caption">{caption}</div>}
        </div>
      </div>
    </div>
  );
}

/** Media that fills the view on the scrim (black in most themes): a video player, a visualizer. Its one child (a webview, an iframe, a canvas) fills it. */
export function Stage({ children }: { children: ReactNode }) {
  return <div className="ui-stage">{children}</div>;
}

/**
 * Where a web page shows (the Browser): the page (a webview) fills it, on white,
 * fading in once the caller marks it painted (`data-painted`) instead of flashing.
 * With `device` the caller places the page at a device's size; it sits lifted, its
 * `caption` above. `cover` shows a state over the page (it didn't load), which stays
 * mounted underneath. Other props (a ref, onMouseDown) go to the stage.
 */
export const WebStage = forwardRef<HTMLDivElement, Omit<HTMLAttributes<HTMLDivElement>, "children"> & { device?: boolean; caption?: ReactNode; cover?: ViewStateSpec | null; children: ReactNode }>(function WebStage({ device, caption, cover, children, className, ...rest }, ref) {
  return (
    <div ref={ref} className={className ? `ui-webstage ${className}` : "ui-webstage"} data-device={device || undefined} {...rest}>
      {children}
      {cover && (
        <div className="ui-webstage-cover">
          <ViewState state={cover} />
        </div>
      )}
      {caption && <div className="ui-webstage-caption">{caption}</div>}
    </div>
  );
});

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
export function Text({ tone, size, mono, strong, truncate, select, children }: { tone?: "dim" | Tone; size?: TextSize; mono?: boolean; strong?: boolean; truncate?: boolean; /** A value to read and copy (a path, a hash): selectable, a long one breaks anywhere. */ select?: boolean; children: ReactNode }) {
  return (
    <span className="ui-text" data-tone={tone} data-size={size} data-mono={mono || undefined} data-strong={strong || undefined} data-truncate={truncate || undefined} data-select={select || undefined}>
      {children}
    </span>
  );
}

/**
 * Rows to act on or pick from (ListSection, ListRow, ListGroup). Plain: rows run edge to
 * edge in a View without an inset, their content at the window's inset, as in a sidebar.
 * Grouped: each section's rows in a box, in a View with `inset`, as in System Settings;
 * for lists of things to run or change rather than records.
 */
export function List({ variant = "plain", children }: { variant?: "plain" | "grouped"; children: ReactNode }) {
  return (
    <div className="ui-list" data-variant={variant}>
      {children}
    </div>
  );
}

/** Rows in a box without a heading (a grouped List's main action). */
export function ListGroup({ children }: { children: ReactNode }) {
  return <div className="ui-list-rows">{children}</div>;
}

/**
 * A document to read: rendered Markdown or HTML (headings, lists, code, tables,
 * quotes) in a reading column, set in the person's text font (the font.text
 * setting, --font-text) and code font. Children, or innerHTML through its ref.
 */
export const Document = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function Document({ className, ...rest }, ref) {
  return <article ref={ref} className={className ? `ui-doc ${className}` : "ui-doc"} {...rest} />;
});

/**
 * A picture you pan and zoom: scrolls when what it holds is larger, centred when it's
 * smaller; `pannable` shows the grab cursor, `panning` the grabbing one; `loading`
 * covers it with a spinner. The view does the zooming (its ref is the scroller).
 */
export const Viewport = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { pannable?: boolean; panning?: boolean; loading?: boolean }>(function Viewport({ pannable, panning, loading, children, ...rest }, ref) {
  return (
    <div ref={ref} className="ui-viewport" tabIndex={-1} data-pan={pannable || undefined} data-panning={panning || undefined} {...rest}>
      <div className="ui-viewport-stage">{children}</div>
      {loading && (
        <div className="ui-viewport-cover">
          <Spinner />
        </div>
      )}
    </div>
  );
});

/** An image in a Viewport: a checkerboard behind its transparent parts, its pixels drawn as squares when `crisp` (zoomed far in). */
export const Picture = forwardRef<HTMLImageElement, React.ImgHTMLAttributes<HTMLImageElement> & { crisp?: boolean }>(function Picture({ crisp, ...rest }, ref) {
  return <img ref={ref} className="ui-picture" data-crisp={crisp || undefined} {...rest} />;
});
