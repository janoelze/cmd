// Floating surfaces: Popover (a card anchored to a control), Menu (a list of
// actions in one, like the Space switcher's), Dialog (a sheet over the window
// with a scrim) and toasts (a short message at the bottom that goes away).
// Native menus and confirms (cmd.contextMenu, cmd.confirm) stay native; these
// are for what needs more than text.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ICON, iconNode } from "./icon.tsx";
import { Button, IconButton } from "./button.tsx";
import type { Tone } from "./status.tsx";

const cls = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

// ── popover ────────────────────────────────────────────

export type Placement = "below" | "above";

/** Where a popover of this size goes beside its anchor: below unless it only fits above, kept inside the window. */
export function placePopover(anchor: { left: number; top: number; bottom: number; right: number }, size: { width: number; height: number }, view: { width: number; height: number }, prefer: Placement = "below", align: "start" | "end" = "start", gap = 6) {
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const fitsBelow = below + size.height <= view.height - 8;
  const fitsAbove = above >= 8;
  const side: Placement = prefer === "below" ? (fitsBelow || !fitsAbove ? "below" : "above") : fitsAbove || !fitsBelow ? "above" : "below";
  const top = side === "below" ? below : above;
  const left = align === "start" ? anchor.left : anchor.right - size.width;
  return { side, top: Math.max(8, Math.min(top, view.height - size.height - 8)), left: Math.max(8, Math.min(left, view.width - size.width - 8)) };
}

/** Closes on Escape, on a press outside (other than on the anchor), and on blur of the window. */
function useDismiss(open: boolean, onClose: () => void, refs: RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (refs.some((r) => r.current?.contains(e.target as Node))) return;
      onClose();
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
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
  className,
  role = "dialog",
  label,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  placement?: Placement;
  align?: "start" | "end";
  width?: number;
  className?: string;
  role?: "dialog" | "menu";
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  useDismiss(open, onClose, [ref, anchor]);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !ref.current) return;
    const p = placePopover(anchor.current.getBoundingClientRect(), ref.current.getBoundingClientRect(), { width: innerWidth, height: innerHeight }, placement, align);
    setPos({ top: p.top, left: p.left, transformOrigin: p.side === "below" ? "top" : "bottom" });
  }, [open, placement, align, anchor]);
  if (!open) return null;
  return createPortal(
    <div ref={ref} className={cls("ui-popover", className)} role={role} aria-label={label} style={{ ...pos, width }}>
      {children}
    </div>,
    document.body,
  );
}

// ── menu ───────────────────────────────────────────────

export interface MenuItemProps {
  label: ReactNode;
  /** A second line, dim. */
  detail?: ReactNode;
  icon?: string | ReactNode;
  shortcut?: string;
  /** A checkmark (the current choice). */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * Actions in a popover. Arrow keys move the highlight (it follows the pointer
 * too), Enter chooses, typing jumps to an item. Choosing closes it.
 */
export function Menu({
  anchor,
  open,
  onClose,
  items,
  width = 240,
  placement,
  align,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  /** null is a separator; a string is a section heading. */
  items: readonly (MenuItemProps | null | string)[];
  width?: number;
  placement?: Placement;
  align?: "start" | "end";
}) {
  const choosable = items.map((it, i) => (it && typeof it === "object" && !it.disabled ? i : -1)).filter((i) => i >= 0);
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      setActive(-1);
      requestAnimationFrame(() => list.current?.focus());
    }
  }, [open]);
  const choose = (i: number) => {
    const it = items[i];
    if (!it || typeof it !== "object" || it.disabled) return;
    onClose();
    it.onSelect();
  };
  const keys = (e: KeyboardEvent) => {
    const at = choosable.indexOf(active);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive(choosable[at < 0 ? (d > 0 ? 0 : choosable.length - 1) : (at + d + choosable.length) % choosable.length] ?? -1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (active >= 0) choose(active);
    } else if (e.key.length === 1) {
      const k = e.key.toLowerCase();
      const hit = choosable.find((i) => {
        const it = items[i] as MenuItemProps;
        return typeof it.label === "string" && it.label.toLowerCase().startsWith(k);
      });
      if (hit !== undefined) setActive(hit);
    }
  };
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} role="menu" width={width} placement={placement} align={align} className="ui-menu">
      <div ref={list} tabIndex={-1} className="ui-menu-list" onKeyDown={keys}>
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
              role={it.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={it.checked}
              aria-disabled={it.disabled || undefined}
              className="ui-menu-item"
              data-active={i === active || undefined}
              data-danger={it.danger || undefined}
              onPointerMove={() => !it.disabled && setActive(i)}
              onPointerLeave={() => setActive(-1)}
              onClick={() => choose(i)}
            >
              <span className="ui-menu-check">{it.checked && iconNode("checkmark", ICON.control, "bold")}</span>
              {it.icon != null && <span className="ui-menu-icon">{iconNode(it.icon, ICON.row)}</span>}
              <span className="ui-menu-text">
                <span className="ui-menu-label">{it.label}</span>
                {it.detail && <span className="ui-menu-detail">{it.detail}</span>}
              </span>
              {it.shortcut && <kbd className="ui-kbd" data-plain>{it.shortcut}</kbd>}
            </div>
          ),
        )}
      </div>
    </Popover>
  );
}

// ── dialog ─────────────────────────────────────────────

/**
 * A sheet over the window with a scrim: a title, content, and actions at the
 * bottom right (the primary last). Escape and a click on the scrim close it,
 * unless it is busy. Focus moves into it and back when it closes.
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
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  width?: number;
  /** False while something runs that shouldn't be abandoned. */
  dismissable?: boolean;
  /** Top (like the palette, near where you were looking) or centred. */
  position?: "top" | "center";
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("[autofocus], input, textarea, select, button:not([data-variant='ghost'])");
    (first ?? el)?.focus();
    return () => before?.focus?.();
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div
      className="ui-scrim"
      data-position={position}
      onPointerDown={(e) => e.target === e.currentTarget && dismissable && onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape" && dismissable) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div ref={ref} className="ui-dialog" role="dialog" aria-modal aria-label={label ?? (typeof title === "string" ? title : undefined)} tabIndex={-1} style={{ width }}>
        {title && (
          <div className="ui-dialog-head">
            <div className="ui-dialog-title">{title}</div>
            {dismissable && <IconButton icon="xmark" size="sm" label="Close" onClick={onClose} />}
          </div>
        )}
        <div className="ui-dialog-body">{children}</div>
        {actions && <div className="ui-dialog-foot">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
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
}

let toasts: ToastEntry[] = [];
let nextId = 1;
const toastListeners = new Set<() => void>();
const emit = () => toastListeners.forEach((fn) => fn());

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Show a short message at the bottom of the window; returns its id. Needs a <Toaster/> mounted. */
export function toast(message: ReactNode, opts: ToastOptions = {}): number {
  const id = nextId++;
  toasts = [...toasts.slice(-3), { id, message, ...opts }];
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
  return createPortal(
    <div className="ui-toaster" aria-live="polite">
      {list.map((t) => (
        <Toast key={t.id} tone={t.tone} icon={t.icon} action={t.action && { label: t.action.label, run: () => (dismissToast(t.id), t.action!.run()) }} onDismiss={() => dismissToast(t.id)}>
          {t.message}
        </Toast>
      ))}
    </div>,
    document.body,
  );
}

/** One toast, as Toaster shows it (also usable in place: a view's own transient note). */
export function Toast({ tone = "neutral", icon, children, action, onDismiss }: { tone?: Tone; icon?: string | ReactNode; children: ReactNode; action?: { label: string; run: () => void }; onDismiss?: () => void }) {
  return (
    <div className="ui-toast" data-tone={tone} role={tone === "danger" ? "alert" : "status"}>
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
