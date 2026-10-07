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
// Items marked `secondary` are faded until their window is hovered, selected or
// focused (or the toolbar itself, outside a window): still there, quieter.
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

/** Shared by every item that can move to the ⋯ menu or be secondary. */
interface ItemProps {
  /** Moves to the ⋯ menu when there is no room, lowest first; without one it stays. */
  priority?: number;
  /** Faded until the window is hovered, selected or focused. */
  secondary?: boolean;
}

const itemAttrs = (key: string, p: ItemProps) => ({
  "data-tb-key": key,
  "data-tb-priority": p.priority,
  "data-secondary": p.secondary || undefined,
});

// ── the bar ────────────────────────────────────────────

const fits = (el: HTMLElement) => el.scrollWidth <= el.clientWidth + 0.5;

export function WindowToolbar({
  children,
  label,
  className,
  floating,
}: {
  children: ReactNode;
  /** Its accessible name ("Browser", "Filter events"). */
  label?: string;
  className?: string;
  /** Over the content (a terminal's find bar): as wide as its items, rounded, with a shadow. */
  floating?: boolean;
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
      <div ref={bar} className={cls("ui-tb", className)} role="toolbar" aria-label={label} data-floating={floating || undefined}>
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
  /** Without one, it's a text button: the label always shows. */
  icon?: string | ReactNode;
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
  /** A tooltip other than the label (more detail: a branch's upstream and changes). */
  tip?: string;
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
      data-tip={p.tip ?? p.label}
      data-tip-key={p.shortcut}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      {p.icon !== undefined && iconNode(p.icon, ICON.toolbar)}
      {p.icon === undefined ? <span className="ui-tb-text">{p.label}</span> : p.showLabel && <span className="ui-tb-label">{p.label}</span>}
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
  /** After the text, inside: a count ("3 of 12"), a clear button. */
  end?: ReactNode;
  /** The text's alignment (a page number centres). */
  align?: "start" | "center";
}

/** A text input in the bar (a page number, a name). It takes the room left, down to its minimum. */
export const ToolbarField = forwardRef<HTMLInputElement, ToolbarFieldProps>(function ToolbarField({ icon, minWidth = 80, maxWidth, end, align, className, style, ...rest }, ref) {
  return (
    <label className={cls("ui-tb-field", className)} data-align={align} style={{ minWidth, maxWidth, flexGrow: maxWidth ? 0 : 1, flexBasis: maxWidth ?? 0, ...style }}>
      {icon && iconNode(icon, ICON.control + 2)}
      {/* Inside a <label> with no text, the placeholder would not name it: say it. */}
      <input ref={ref} spellCheck={false} aria-label={rest.placeholder} {...rest} />
      {end != null && <span className="ui-tb-field-end">{end}</span>}
    </label>
  );
});

/** A filter or find field: a magnifying glass, a count, a clear button; Escape clears it (then `onEscape`). */
export const ToolbarSearchField = forwardRef<
  HTMLInputElement,
  Omit<ToolbarFieldProps, "icon" | "value" | "onChange"> & { value: string; onChange: (v: string) => void; count?: ReactNode; onEscape?: () => void }
>(function ToolbarSearchField({ value, onChange, count, onEscape, onKeyDown, end, className, ...rest }, ref) {
  return (
    <ToolbarField
      ref={ref}
      icon="magnifyingglass"
      className={cls("ui-tb-search", className)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || e.key !== "Escape") return;
        if (value) onChange("");
        else onEscape?.();
      }}
      end={
        <>
          {count != null && value && <span className="ui-tb-field-count">{count}</span>}
          {end}
          {value && (
            <button type="button" className="ui-tb-field-clear" aria-label="Clear" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => onChange("")}>
              {iconNode("xmark.circle.fill", ICON.control + 2)}
            </button>
          )}
        </>
      }
      {...rest}
    />
  );
});

/**
 * An address as browsers show one: at rest, without the protocol, "www.", the
 * query and a trailing slash, centred and quieter; focused, the whole address,
 * selected, to edit. Enter submits it (`onSubmit`), Escape puts it back.
 */
export const ToolbarAddressField = forwardRef<
  HTMLInputElement,
  Omit<ToolbarFieldProps, "value" | "onChange" | "onSubmit"> & { value: string; onSubmit: (text: string) => void; onEscape?: () => void; display?: (url: string) => string }
>(function ToolbarAddressField({ value, onSubmit, onEscape, display = displayAddress, onFocus, onBlur, onKeyDown, className, ...rest }, ref) {
  const own = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  return (
    <ToolbarField
      ref={(el) => {
        own.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      className={cls("ui-tb-address", className)}
      data-editing={editing || undefined}
      value={editing ? draft : display(value)}
      title={editing ? undefined : value || undefined}
      onFocus={(e) => {
        setDraft(value);
        // After React puts the whole address in.
        const el = e.currentTarget;
        requestAnimationFrame(() => el.select());
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setDraft(null);
        onBlur?.(e);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === "Enter" && draft !== null) {
          onSubmit(draft.trim());
          own.current?.blur();
        } else if (e.key === "Escape") {
          setDraft(value);
          own.current?.blur();
          onEscape?.();
        }
      }}
      {...rest}
    />
  );
});

/** How an address shows at rest: host and path, no protocol, "www.", query, fragment or trailing slash. */
export function displayAddress(url: string): string {
  if (!url) return "";
  if (url.startsWith("file://")) return decodeURI(url.slice(7));
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return url;
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return decodeURI(u.host.replace(/^www\./, "") + path);
  } catch {
    return url;
  }
}

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
export function ToolbarGroup({ children, secondary }: { children: ReactNode; secondary?: boolean }) {
  return (
    <div className="ui-tb-group" data-secondary={secondary || undefined}>
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
