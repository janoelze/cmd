// The window toolbar: one bar of actions and inputs under a window's title bar,
// the same in a tile and in a sidebar. The title bar says what the window is
// (name, place, status, its menu); the toolbar holds what you do with it, never
// a summary of it. Its items are its own, not the general controls: one height
// (--toolbar-item-h), one icon size (ICON.toolbar), ghost at rest.
//
// It fits any width by giving way in steps, measured whenever it or its items
// change size: labels show while they fit; then icons only; then paths compact
// to their last part; then items with a `priority` move, lowest first, into a
// ⋯ menu built from their props. Fields shrink to their minimum last.
//
// Every button's tooltip is its label and shortcut.

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { ICON, iconNode } from "./icon.tsx";
import { Menu, type MenuItemProps } from "./overlay.tsx";

const cls = (...c: (string | false | undefined | null)[]) => c.filter(Boolean).join(" ");

/** What the ⋯ menu shows for an item that moved there. */
interface OverflowEntry {
  label: string;
  icon?: string | ReactNode;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  run: () => void;
}

const Registry = createContext<Map<string, OverflowEntry> | null>(null);

/** Registers an item's menu entry (kept current every render) under a key on its element. */
function useOverflow(entry: OverflowEntry | null): string {
  const key = useId();
  const reg = useContext(Registry);
  if (reg && entry) reg.set(key, entry);
  useLayoutEffect(() => () => void reg?.delete(key), [reg, key]);
  return key;
}

/** Shared by every item that can move to the ⋯ menu. */
interface ItemProps {
  /** Moves to the ⋯ menu when there is no room, lowest first; without one it stays. */
  priority?: number;
}

const itemAttrs = (key: string, p: ItemProps) => ({
  "data-tb-key": key,
  "data-tb-priority": p.priority,
});

// ── the bar ────────────────────────────────────────────

const fits = (el: HTMLElement) => el.scrollWidth <= el.clientWidth + 0.5;

export function WindowToolbar({
  children,
  label,
  className,
}: {
  children: ReactNode;
  /** Its accessible name ("Browser", "Filter events"). */
  label?: string;
  className?: string;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const registry = useRef(new Map<string, OverflowEntry>()).current;
  const [moved, setMoved] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);

  const fit = useCallback(() => {
    const el = bar.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLElement>("[data-tb-key]")].filter((n) => n.closest(".ui-tb") === el);
    for (const n of items) delete n.dataset.tbMoved;
    el.dataset.step = "labels";
    const out: string[] = [];
    if (!fits(el)) el.dataset.step = "icons";
    if (!fits(el)) el.dataset.step = "compact";
    if (!fits(el)) {
      el.dataset.step = "overflow";
      const movable = items.filter((n) => n.dataset.tbPriority !== undefined).sort((a, b) => Number(a.dataset.tbPriority) - Number(b.dataset.tbPriority));
      for (const n of movable) {
        if (fits(el)) break;
        n.dataset.tbMoved = "";
        out.push(n.dataset.tbKey!);
      }
      if (!out.length) el.dataset.step = "compact";
    }
    setMoved((prev) => (prev.join() === out.join() ? prev : out));
  }, []);

  // After every render (items change), and whenever the bar or an item changes size.
  useLayoutEffect(fit);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fit);
    });
    ro.observe(el);
    return () => (ro.disconnect(), cancelAnimationFrame(raf));
  }, [fit]);

  const entries: MenuItemProps[] = moved.flatMap((k) => {
    const e = registry.get(k);
    return e ? [{ label: e.label, icon: e.icon, shortcut: e.shortcut, checked: e.checked, disabled: e.disabled, onSelect: () => e.run() }] : [];
  });

  return (
    <Registry.Provider value={registry}>
      <div ref={bar} className={cls("ui-tb", className)} role="toolbar" aria-label={label}>
        {children}
        <button
          ref={more}
          type="button"
          className="ui-tb-button ui-tb-more"
          hidden={!moved.some((k) => registry.has(k))}
          aria-label="More"
          data-tip="More"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          {iconNode("ellipsis", ICON.toolbar)}
        </button>
      </div>
      <Menu anchor={more} open={menuOpen && entries.length > 0} onClose={() => setMenuOpen(false)} items={entries} align="end" width={220} label="More" />
    </Registry.Provider>
  );
}

// ── items ──────────────────────────────────────────────

export interface ToolbarButtonProps extends ItemProps {
  icon: string | ReactNode;
  /** The tooltip, the accessible name, its ⋯ menu entry, and its text where `showLabel`. */
  label: string;
  shortcut?: string;
  /** The label beside the icon, while there is room. */
  showLabel?: boolean;
  /** A chevron: it opens a menu. */
  menu?: boolean;
  /** On (a panel shown, a mode active); a toggle. */
  pressed?: boolean;
  disabled?: boolean;
  /** A tone for its icon (a count of failures, a change). */
  tone?: "accent" | "danger" | "needs";
  /** Something after the label: a count. */
  badge?: ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}

export const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(function ToolbarButton(p, ref) {
  const own = useRef<HTMLButtonElement | null>(null);
  const key = useOverflow(
    p.priority === undefined ? null : { label: p.label, icon: p.icon, shortcut: p.shortcut, checked: p.pressed, disabled: p.disabled, run: () => own.current?.click() },
  );
  return (
    <button
      ref={(el) => {
        own.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      type="button"
      className={cls("ui-tb-button", p.className)}
      {...itemAttrs(key, p)}
      data-tone={p.tone}
      data-labelled={p.showLabel || undefined}
      aria-label={p.label}
      aria-pressed={p.pressed}
      aria-haspopup={p.menu || undefined}
      data-tip={p.label}
      data-tip-key={p.shortcut}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      {iconNode(p.icon, ICON.toolbar)}
      {p.showLabel && <span className="ui-tb-label">{p.label}</span>}
      {p.badge != null && <span className="ui-tb-badge">{p.badge}</span>}
      {p.menu && <span className="ui-tb-chevron">{iconNode("chevron.down", ICON.disclosure)}</span>}
    </button>
  );
});

/** Text that is a button: a zoom level that opens its menu, a branch. */
export function ToolbarMenu(p: ItemProps & { children: ReactNode; label: string; icon?: string | ReactNode; disabled?: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; className?: string }) {
  const own = useRef<HTMLButtonElement>(null);
  const key = useOverflow(p.priority === undefined ? null : { label: p.label, icon: p.icon, disabled: p.disabled, run: () => own.current?.click() });
  return (
    <button ref={own} type="button" className={cls("ui-tb-button ui-tb-menu", p.className)} {...itemAttrs(key, p)} aria-haspopup data-tip={p.label} aria-label={p.label} disabled={p.disabled} onClick={p.onClick}>
      {p.icon && iconNode(p.icon, ICON.toolbar)}
      <span className="ui-tb-text">{p.children}</span>
      <span className="ui-tb-chevron">{iconNode("chevron.down", ICON.disclosure)}</span>
    </button>
  );
}

export interface ToolbarFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** An icon inside, at the start (a magnifying glass for a filter). */
  icon?: string;
  /** The narrowest it gets, in px (default 80). */
  minWidth?: number;
  /** As wide as it gets, in px; without one it takes the room left. */
  maxWidth?: number;
  /** After the text, inside: a count ("3 of 12"). */
  end?: ReactNode;
}

/** A text input in the bar: an address, a filter, a page number. It takes the room left, down to its minimum. */
export const ToolbarField = forwardRef<HTMLInputElement, ToolbarFieldProps>(function ToolbarField({ icon, minWidth = 80, maxWidth, end, className, style, ...rest }, ref) {
  return (
    <label className={cls("ui-tb-field", className)} style={{ minWidth, maxWidth, flexGrow: maxWidth ? 0 : 1, flexBasis: maxWidth ?? 0, ...style }}>
      {icon && iconNode(icon, ICON.control + 2)}
      <input ref={ref} spellCheck={false} {...rest} />
      {end != null && <span className="ui-tb-field-end">{end}</span>}
    </label>
  );
});

/** Dim text in the bar ("of 12", a count). With a `priority` it hides when there is no room (no menu entry). */
export function ToolbarText({ children, className, ...p }: ItemProps & { children: ReactNode; className?: string }) {
  const key = useOverflow(null);
  return (
    <span className={cls("ui-tb-text-item", className)} {...itemAttrs(key, p)}>
      {children}
    </span>
  );
}

/** One of a few (view modes, tabs): icons, or short labels. */
export function ToolbarSegmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string; icon?: string; shortcut?: string; badge?: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const pop = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <>
    {/* Compacted: the current choice as a popup. */}
    <button ref={pop} type="button" className="ui-tb-button ui-tb-seg-pop" aria-haspopup aria-expanded={open} aria-label={label} data-tip={label} onClick={() => setOpen((o) => !o)}>
      {current?.icon && iconNode(current.icon, ICON.toolbar)}
      <span className="ui-tb-text">{current?.label}</span>
      <span className="ui-tb-chevron">{iconNode("chevron.down", ICON.disclosure)}</span>
    </button>
    <Menu anchor={pop} open={open} onClose={() => setOpen(false)} label={label} width={180} items={options.map((o) => ({ label: o.label, icon: o.icon, shortcut: o.shortcut, checked: o.value === value, onSelect: () => onChange(o.value) }))} />
    <div className="ui-tb-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          className="ui-tb-button"
          aria-checked={o.value === value}
          aria-label={o.label}
          data-tip={o.icon ? o.label : undefined}
          data-tip-key={o.shortcut}
          data-labelled={!o.icon || undefined}
          onClick={() => onChange(o.value)}
        >
          {o.icon && iconNode(o.icon, ICON.toolbar)}
          {!o.icon && <span className="ui-tb-text">{o.label}</span>}
          {o.badge}
        </button>
      ))}
    </div>
    </>
  );
}

/**
 * A path as segments (a folder's, a URL's), each a button. Compacted, only the
 * last shows, and it opens `onMenu` (the rest as a menu) when given.
 */
export function ToolbarPath({ segments, onSelect, onMenu, tip }: { segments: readonly { key: string; label: string }[]; onSelect: (key: string) => void; onMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void; tip?: string }) {
  return (
    <div className="ui-tb-path" data-tip={tip}>
      {segments.map((s, i) => {
        const last = i === segments.length - 1;
        return (
          <span key={s.key} className="ui-tb-path-seg" data-last={last || undefined}>
            {i > 0 && <span className="ui-tb-path-sep">{iconNode("chevron.right", ICON.disclosure)}</span>}
            <button type="button" className="ui-tb-path-button" onClick={(e) => (last && onMenu ? onMenu(e) : onSelect(s.key))}>
              {s.label}
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** Items that belong together, closer than the bar's gap (Back · Forward · Reload). */
export function ToolbarGroup({ children }: { children: ReactNode }) {
  return (
    <div className="ui-tb-group">
      {children}
    </div>
  );
}

export function ToolbarSpacer() {
  return <span className="ui-tb-spacer" />;
}

export function ToolbarSeparator() {
  return <span className="ui-tb-sep" role="separator" aria-orientation="vertical" />;
}
