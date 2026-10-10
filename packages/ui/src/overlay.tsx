// Floating surfaces: Popover (a card anchored to a control), Menu (a list of
// actions in one, like the workspace switcher's), Dialog (a sheet over the window
// with a scrim, and Presence, which mounts one only while it's shown) and toasts (a short message at the bottom that goes away).
// Native menus and confirms (cmd.contextMenu, cmd.confirm) stay native; these
// are for what needs more than text.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ICON, iconNode } from "./icon.tsx";
import { Button, IconButton } from "./button.tsx";
import type { Tone } from "./status.tsx";
import { WindowBar } from "./window.tsx";
import { MOTION, useFlip, usePresence, usePresentValue } from "./motion.ts";

const cls = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

// ── popover ────────────────────────────────────────────

export type Placement = "below" | "above";

/** How a popover lines up with its anchor: their left edges, right edges or centres. */
export type Align = "start" | "center" | "end";

/** Where a popover of this size goes beside its anchor: below unless it only fits above, kept inside the window. */
export function placePopover(anchor: { left: number; top: number; bottom: number; right: number }, size: { width: number; height: number }, view: { width: number; height: number }, prefer: Placement = "below", align: Align = "start", gap = 6) {
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const fitsBelow = below + size.height <= view.height - 8;
  const fitsAbove = above >= 8;
  const side: Placement = prefer === "below" ? (fitsBelow || !fitsAbove ? "below" : "above") : fitsAbove || !fitsBelow ? "above" : "below";
  const top = side === "below" ? below : above;
  const left = align === "start" ? anchor.left : align === "end" ? anchor.right - size.width : Math.round((anchor.left + anchor.right - size.width) / 2);
  return { side, top: Math.max(8, Math.min(top, view.height - size.height - 8)), left: Math.max(8, Math.min(left, view.width - size.width - 8)) };
}

/** Closes on Escape, on a press outside (other than on the anchor), and on blur of the window. */
export type DismissReason = "escape" | "outside" | "blur";

/** What Tab can reach inside `root`, in order (visible, enabled, not inert). */
const TABBABLE = "a[href], button, input, select, textarea, iframe, [contenteditable]:not([contenteditable='false']), [tabindex]";
function tabbables(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !el.closest("[inert]") && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
}

function useDismiss(open: boolean, onClose: (why: DismissReason) => void, refs: RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (refs.some((r) => r.current?.contains(e.target as Node))) return;
      onClose("outside");
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose("escape");
      }
    };
    const blur = () => onClose("blur");
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", blur);
    };
  }, [open, onClose]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * A card beside its anchor (fixed, so a scroller doesn't clip it). Open and
 * close it yourself; it asks to close on Escape and outside presses.
 */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  placement = "below",
  align = "start",
  width,
  maxWidth,
  className,
  role = "dialog",
  label,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: (why: DismissReason) => void;
  children: ReactNode;
  placement?: Placement;
  align?: Align;
  /** A fixed width, or "content": as wide as its widest line, up to maxWidth (and the window). */
  width?: number | "content";
  maxWidth?: number;
  className?: string;
  /** "dialog" with controls in it takes focus on open; with none it is a "group". "menu": the Menu moves focus itself. */
  role?: "dialog" | "menu" | "group";
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  // Closed, it fades out where it is (motion.ts).
  const { present, closing } = usePresence(open);
  useDismiss(open, onClose, [ref, anchor]);
  // A dialog popover takes focus (its first control, once placed and visible) unless its
  // content already did, and gives it back to the anchor when it closes with focus inside.
  // Nothing to focus in it: it is a group, not a dialog.
  const [bare, setBare] = useState(false);
  useEffect(() => {
    if (!open || role !== "dialog") return;
    const frame = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      const first = tabbables(el)[0];
      setBare(!first);
      if (first && !el.contains(document.activeElement)) first.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      const at = document.activeElement;
      if (ref.current?.contains(at) || at === document.body) anchor.current?.focus({ preventScroll: true });
    };
  }, [open, role]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !anchor.current || !el) return;
    const place = () => {
      if (!anchor.current) return;
      // Sized to its content: measured at its natural width each time (its items may have
      // changed), then rounded up to whole pixels so its right edge and what sits against
      // it stay crisp. Layout sizes, not the rect: the pop-in animation scales it.
      if (width === "content") el.style.width = "max-content";
      const cs = getComputedStyle(el);
      const size = { width: parseFloat(cs.width), height: parseFloat(cs.height) };
      if (width === "content") el.style.width = `${Math.ceil(size.width)}px`;
      const p = placePopover(anchor.current.getBoundingClientRect(), size, { width: innerWidth, height: innerHeight }, placement, align);
      setPos({ top: p.top, left: p.left, transformOrigin: p.side === "below" ? "top" : "bottom", ...(width === "content" ? { width: Math.ceil(size.width) } : {}) });
    };
    place();
    // Again when its content changes size: one above its anchor would otherwise come loose when it shrinks.
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, placement, align, anchor, width]);
  if (!present) return null;
  const style: CSSProperties = { ...pos, ...(width !== "content" ? { width } : {}), ...(maxWidth ? { maxWidth: `min(${maxWidth}px, 100vw - 16px)` } : {}) };
  return createPortal(
    <div ref={ref} className={cls("ui-popover", className)} role={role === "dialog" && bare ? "group" : role} aria-label={label} style={style} data-motion="pop" data-closing={closing || undefined} inert={closing || undefined}>
      {children}
    </div>,
    document.body,
  );
}

// ── menu ───────────────────────────────────────────────

/** How a menu item was chosen: with ⌘ held (open in a new window), say. */
export interface MenuChoice {
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface MenuItemProps {
  label: ReactNode;
  /** A second line, dim. */
  detail?: ReactNode;
  icon?: string | ReactNode;
  shortcut?: string;
  /** Before the shortcut, at the row's end: a status dot, say. */
  accessory?: ReactNode;
  /** The current choice: a checkmark, or a tinted row in a `marks="row"` menu. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** For the host's own styling of one item (an attention mark, say). */
  className?: string;
  /** Type-ahead matches this (default: the label, if it is text). */
  text?: string;
  onSelect: (how: MenuChoice) => void;
  /** Right-click on the item: the menu closes first. */
  onContextMenu?: () => void;
}

const TYPEAHEAD_MS = 700;

/**
 * Actions in a popover. It opens on the checked item (else none); arrow keys,
 * Home and End move the highlight (it follows the pointer too), Enter chooses,
 * typing jumps to an item. Choosing closes it; Escape and Tab close it and give
 * the anchor its focus back.
 */
export function Menu({
  anchor,
  open,
  onClose,
  items,
  width = 240,
  maxWidth,
  matchWidth,
  placement,
  align,
  marks = "check",
  inline,
  label,
  className,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  /** null is a separator; a string is a section heading. */
  items: readonly (MenuItemProps | null | string)[];
  /** A fixed width (240 by default), or "content": as wide as its widest item, up to maxWidth. */
  width?: number | "content";
  maxWidth?: number;
  /** As wide as the anchor (a popup button's menu). */
  matchWidth?: boolean;
  placement?: Placement;
  align?: Align;
  /** How the checked item shows: a checkmark column (default), or its row tinted and no column. */
  marks?: "check" | "row";
  /** Each detail beside its label, dim, instead of on a second line: one line per item. */
  inline?: boolean;
  label?: string;
  className?: string;
}) {
  const choosable = items.map((it, i) => (it && typeof it === "object" && !it.disabled ? i : -1)).filter((i) => i >= 0);
  const checked = items.findIndex((it) => !!it && typeof it === "object" && !!it.checked);
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  useEffect(() => {
    if (!open) return;
    setActive(checked);
    requestAnimationFrame(() => list.current?.focus());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (active >= 0) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const dismiss = (refocus: boolean) => {
    onClose();
    if (refocus) anchor.current?.focus();
  };
  const choose = (i: number, how: MenuChoice) => {
    const it = items[i];
    if (!it || typeof it !== "object" || it.disabled) return;
    onClose();
    it.onSelect(how);
  };
  const keys = (e: KeyboardEvent) => {
    const at = choosable.indexOf(active);
    const go = (n: number) => (e.preventDefault(), setActive(choosable[(n + choosable.length) % choosable.length] ?? -1));
    if (e.key === "ArrowDown") go(at < 0 ? 0 : at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (active >= 0) choose(active, e);
    } else if (e.key === "Tab") {
      e.preventDefault();
      dismiss(true);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Type-ahead, like a native menu: what was typed in quick succession.
      const t = typed.current;
      t.text = (e.timeStamp - t.at < TYPEAHEAD_MS ? t.text : "") + e.key.toLowerCase();
      t.at = e.timeStamp;
      const hit = choosable.find((i) => {
        const it = items[i] as MenuItemProps;
        const text = it.text ?? (typeof it.label === "string" ? it.label : "");
        return text.toLowerCase().startsWith(t.text);
      });
      if (hit !== undefined) setActive(hit);
    }
  };
  return (
    <Popover
      anchor={anchor}
      open={open}
      onClose={(why) => dismiss(why === "escape")}
      role="menu"
      label={label}
      width={matchWidth ? anchor.current?.offsetWidth : width}
      maxWidth={maxWidth}
      placement={placement}
      align={align}
      className={cls("ui-menu", className)}
    >
      <div ref={list} tabIndex={-1} className="ui-menu-list" data-marks={marks} data-inline={inline || undefined} onKeyDown={keys}>
        {items.map((it, i) =>
          it === null ? (
            <div key={i} className="ui-menu-sep" role="separator" />
          ) : typeof it === "string" ? (
            <div key={i} className="ui-menu-heading">
              {it}
            </div>
          ) : (
            <div
              key={i}
              data-i={i}
              role={it.checked === undefined ? "menuitem" : "menuitemradio"}
              // Named by the label alone, not its detail (a path) or shortcut.
              aria-label={it.text ?? (typeof it.label === "string" ? it.label : undefined)}
              aria-description={typeof it.detail === "string" ? it.detail : undefined}
              aria-checked={it.checked}
              aria-disabled={it.disabled || undefined}
              className={cls("ui-menu-item", it.className)}
              data-active={i === active || undefined}
              data-danger={it.danger || undefined}
              onPointerMove={() => !it.disabled && setActive(i)}
              onClick={(e) => choose(i, e)}
              onContextMenu={
                it.onContextMenu &&
                ((e) => {
                  e.preventDefault();
                  onClose();
                  it.onContextMenu!();
                })
              }
            >
              {marks === "check" && <span className="ui-menu-check">{it.checked && iconNode("checkmark", ICON.control, "bold")}</span>}
              {it.icon != null && <span className="ui-menu-icon">{iconNode(it.icon, ICON.row)}</span>}
              <span className="ui-menu-text">
                <span className="ui-menu-label">{it.label}</span>
                {it.detail && <span className="ui-menu-detail">{it.detail}</span>}
              </span>
              {it.accessory != null && <span className="ui-menu-accessory">{it.accessory}</span>}
              {it.shortcut && (
                <kbd className="ui-kbd" data-plain>
                  {it.shortcut}
                </kbd>
              )}
            </div>
          ),
        )}
      </div>
    </Popover>
  );
}

// ── dialog ─────────────────────────────────────────────

// Not a native <dialog> with showModal(): its top layer sits above the tooltip
// layer, the toasts and any Popover or Menu opened from inside the dialog (all
// portalled into <body>) and makes them inert. Instead everything else in
// <body> is inert while a dialog is open, and Tab wraps inside it.

/** Overlays that stay live over a dialog: the tooltip layer and the toasts. */
const LIVE = ".tip-layer, .ui-toaster";

/** How many open dialogs hold each element inert: two can be open at once (one opened over the other) and close in any order. */
const holds = new Map<HTMLElement, number>();

/** Makes everything in <body> but `keep` (and the live overlays) inert; returns the undo. */
function inertOthers(keep: Element): () => void {
  const held: HTMLElement[] = [];
  for (const el of document.body.children) {
    // Inert for another reason (a closing overlay): not ours to undo.
    if (el === keep || !(el instanceof HTMLElement) || el.matches(LIVE) || (el.inert && !holds.has(el))) continue;
    holds.set(el, (holds.get(el) ?? 0) + 1);
    el.inert = true;
    held.push(el);
  }
  return () => {
    for (const el of held) {
      const n = (holds.get(el) ?? 1) - 1;
      if (n > 0) holds.set(el, n);
      else (holds.delete(el), (el.inert = false));
    }
  };
}

/** Open dialogs, the topmost last: keys that reach no element (focus on <body>) are its. */
const dialogs: RefObject<HTMLElement | null>[] = [];

/** Tab and Shift-Tab past the ends of `root` wrap around to its other end. */
function wrapTab(e: Pick<KeyboardEvent, "key" | "defaultPrevented" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "preventDefault">, root: HTMLElement | null) {
  if (e.key !== "Tab" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !root) return;
  const at = document.activeElement;
  // In a popover opened from the dialog (portalled outside it): its own business.
  if (at && at !== document.body && !root.contains(at)) return;
  const all = tabbables(root);
  const first = all[0];
  const last = all[all.length - 1];
  const wrap = (el: HTMLElement | undefined) => (e.preventDefault(), (el ?? root).focus());
  if (!first) wrap(root);
  else if (e.shiftKey && (at === first || at === root || at === document.body)) wrap(last);
  else if (!e.shiftKey && (at === last || at === document.body)) wrap(first);
}

/**
 * A sheet over the window with a scrim: a title, content, and actions at the
 * bottom right (the primary last). Escape and a click on the scrim close it,
 * unless it is busy. Modal: focus moves into it, Tab stays in it, the page
 * behind is inert, and focus goes back when it closes.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
  width = 440,
  dismissable = true,
  position = "top",
  label,
  className,
  padded = true,
  scrim = true,
  divided,
  aside,
  height,
  toolbar,
  window: win,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  /** The footer's start, across from the actions: a status line, a checkbox, PageDots. */
  aside?: ReactNode;
  width?: number;
  /** Fixed, for steps that shouldn't make the sheet jump; else it fits the content. */
  height?: number;
  /** A row under the title that stays while the body scrolls: a search field (the Widget Library's). */
  toolbar?: ReactNode;
  /** False while something runs that shouldn't be abandoned. */
  dismissable?: boolean;
  /** Top (like the palette, near where you were looking) or centred. */
  position?: "top" | "center";
  label?: string;
  className?: string;
  /** False: the content goes edge to edge (a search field and a list, like the palette). */
  padded?: boolean;
  /** False: no dimming behind it (a quick picker); outside clicks still close it. */
  scrim?: boolean;
  /** Lines under the title and above the actions, like the palette's: for content that scrolls between them. */
  divided?: boolean;
  /** Dressed as one of the app's windows: a title bar with its icon and name (and a title, larger, under it if given). `close: false` leaves out its close button; `status` sits at its right. */
  window?: { icon?: string | ReactNode; name: string; close?: boolean; /** Dim, at the bar's right: how long something has left. */ status?: ReactNode };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const escape = useRef<(() => void) | null>(null);
  escape.current = dismissable ? onClose : null;
  // Closed, the sheet and its scrim fade out (motion.ts).
  const { present, closing } = usePresence(open);
  // Where focus was as it opened, read while rendering: content with autoFocus (the
  // Widget Library's search field) takes focus as it mounts, before any effect here runs.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) opener.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;
  useEffect(() => {
    if (!open) return;
    const before = opener.current;
    const el = ref.current;
    // Modal: the page behind can't be focused, clicked or read (a terminal can't be typed into).
    const release = scrimRef.current ? inertOthers(scrimRef.current) : () => {};
    // Unless its content already took focus (its own effects run first): its first field or
    // button that isn't ghost (and can take focus: not disabled), else the sheet itself.
    if (el && !el.contains(document.activeElement)) {
      const all = tabbables(el);
      const first = all.find((c) => c.hasAttribute("autofocus")) ?? all.find((c) => c.matches("input, textarea, select, button:not([data-variant='ghost'])"));
      (first ?? el).focus();
    }
    // Focus dropped to <body> (the focused button got disabled, say): Escape and Tab still work.
    dialogs.push(ref);
    const stray = (e: globalThis.KeyboardEvent) => {
      if (dialogs[dialogs.length - 1] !== ref || (document.activeElement && document.activeElement !== document.body)) return;
      if (e.key === "Escape" && escape.current) (e.preventDefault(), escape.current());
      else wrapTab(e, ref.current);
    };
    window.addEventListener("keydown", stray);
    return () => {
      window.removeEventListener("keydown", stray);
      dialogs.splice(dialogs.indexOf(ref), 1);
      release();
      before?.focus?.();
    };
  }, [open]);
  if (!present) return null;
  return createPortal(
    <div
      ref={scrimRef}
      className="ui-scrim"
      data-motion={scrim ? "fade" : undefined}
      data-closing={closing || undefined}
      inert={closing || undefined}
      data-position={position}
      data-clear={scrim ? undefined : true}
      onPointerDown={(e) => e.target === e.currentTarget && dismissable && onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape" && dismissable) {
          e.stopPropagation();
          onClose();
        } else wrapTab(e, ref.current);
      }}
    >
      <div ref={ref} className={cls("ui-dialog", className)} data-motion="pop" data-closing={closing || undefined} data-divided={divided || undefined} data-window={win ? true : undefined} role="dialog" aria-modal aria-label={label ?? (typeof title === "string" ? title : win?.name)} tabIndex={-1} style={{ width, height }}>
        {win && (
          <WindowBar icon={win.icon} name={win.name}>
            {win.status != null && <span className="ui-window-bar-meta">{win.status}</span>}
            {dismissable && win.close !== false && <IconButton icon="xmark" size="sm" label="Close" onClick={onClose} />}
          </WindowBar>
        )}
        {title && (
          <div className="ui-dialog-head">
            <div className="ui-dialog-title">{title}</div>
            {dismissable && !win && <IconButton icon="xmark" size="sm" label="Close" onClick={onClose} />}
          </div>
        )}
        {toolbar && <div className="ui-dialog-bar">{toolbar}</div>}
        <div className="ui-dialog-body" data-padded={padded || undefined}>
          {children}
        </div>
        {(actions || aside) && (
          <div className="ui-dialog-foot">
            {aside && <div className="ui-dialog-aside">{aside}</div>}
            {actions}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * A sheet that's shown while `when` is set: renders `children(value, open)` while
 * it's set and through its exit after, then nothing, so a closed sheet runs no
 * hooks (no fetching, no subscriptions). The sheet passes `open` to its Dialog
 * (or `!open` as a Palette's `closing`), which fades it out.
 */
export function Presence<T>({ when, children }: { when: T | null | undefined | false; children: (value: T, open: boolean) => ReactNode }) {
  const shown = usePresentValue(when, when != null && when !== false);
  if (shown.value == null || shown.value === false) return null;
  return <>{children(shown.value, !shown.closing)}</>;
}

/** Ask before something that can't be undone. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirm = "OK",
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  confirm?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      width={360}
      position="center"
      actions={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} autoFocus onClick={onConfirm}>
            {confirm}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

// ── toasts ─────────────────────────────────────────────

export interface ToastOptions {
  tone?: Tone;
  /** An action button ("Undo"). */
  action?: { label: string; run: () => void };
  /** ms; 0 keeps it until dismissed. Default 4000. */
  duration?: number;
  icon?: string | ReactNode;
}
interface ToastEntry extends ToastOptions {
  id: number;
  message: ReactNode;
  /** Fading out, then gone. */
  leaving?: boolean;
}

let toasts: ToastEntry[] = [];
let nextId = 1;
const toastListeners = new Set<() => void>();
const emit = () => toastListeners.forEach((fn) => fn());


export function dismissToast(id: number): void {
  if (!toasts.some((t) => t.id === id && !t.leaving)) return;
  toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, MOTION.exit.ms);
}

/** Show a short message at the bottom of the window; returns its id. Needs a <Toaster/> mounted. */
export function toast(message: ReactNode, opts: ToastOptions = {}): number {
  const id = nextId++;
  // At most four: the oldest beyond that leaves.
  for (const t of toasts.filter((t) => !t.leaving).slice(0, -3)) dismissToast(t.id);
  toasts = [...toasts, { id, message, ...opts }];
  emit();
  const ms = opts.duration ?? 4000;
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}

export function Toaster() {
  const list = useSyncExternalStore(
    (fn) => (toastListeners.add(fn), () => toastListeners.delete(fn)),
    () => toasts,
  );
  // The others glide up or down as one comes or goes.
  const ref = useRef<HTMLDivElement>(null);
  useFlip(ref, { selector: ".ui-toast", enter: false });
  return createPortal(
    <div className="ui-toaster" aria-live="polite" ref={ref}>
      {list.map((t) => (
        <Toast key={t.id} flipKey={String(t.id)} leaving={t.leaving} tone={t.tone} icon={t.icon} action={t.action && { label: t.action.label, run: () => (dismissToast(t.id), t.action!.run()) }} onDismiss={() => dismissToast(t.id)}>
          {t.message}
        </Toast>
      ))}
    </div>,
    document.body,
  );
}

/** One toast, as Toaster shows it (also usable in place: a view's own transient note). */
export function Toast({
  tone = "neutral",
  icon,
  children,
  action,
  onDismiss,
  className,
  flipKey,
  leaving,
}: {
  tone?: Tone;
  icon?: string | ReactNode;
  children: ReactNode;
  action?: { label: string; run: () => void };
  onDismiss?: () => void;
  /** Placing it yourself (in place, not in the Toaster). */
  className?: string;
  flipKey?: string;
  leaving?: boolean;
}) {
  return (
    <div className={cls("ui-toast", className)} data-key={flipKey} data-motion="rise" data-closing={leaving || undefined} data-tone={tone} role={tone === "danger" ? "alert" : "status"}>
      {icon != null && <span className="ui-toast-icon">{iconNode(icon, ICON.row)}</span>}
      <span className="ui-toast-text">{children}</span>
      {action && (
        <Button size="sm" variant="ghost" onClick={action.run}>
          {action.label}
        </Button>
      )}
      {onDismiss && <IconButton icon="xmark" size="sm" label="Dismiss" onClick={onDismiss} />}
    </div>
  );
}
