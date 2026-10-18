// Buttons: Button (text, with an optional icon), IconButton (an icon alone, for
// toolbars and bars), LinkButton (an inline action in running text),
// ButtonGroup (buttons joined into one control, or spaced in a row) and
// JumpButton (back to the latest, floating over a scroller).
//
// Variants: default (a filled control, like the Settings window's), primary
// (the accent: one per view, the thing Enter does), danger (removes or
// destroys), ghost (no fill until hovered: toolbars, bars, quiet actions).
// Sizes follow the control heights (--control-h-sm / -h / -h-lg).

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ICON, iconNode } from "./icon.tsx";
import { Spinner } from "./status.tsx";
import { usePresence } from "./motion.ts";

export type ButtonVariant = "default" | "primary" | "danger" | "ghost";
export type Size = "sm" | "md" | "lg";

type Native = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type">;

export interface ButtonProps extends Native {
  variant?: ButtonVariant;
  size?: Size;
  /** An SF Symbol name or a node, before the label. */
  icon?: string | ReactNode;
  /** After the label (a chevron for a button that opens a menu). */
  trailing?: string | ReactNode;
  /** Shows a spinner in place of the icon and disables the button. */
  busy?: boolean;
  /** Shown as pressed (a toggle that is on). */
  pressed?: boolean;
  type?: "button" | "submit";
}

const cls = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", icon, trailing, busy, pressed, type = "button", className, disabled, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cls("ui-button", className)}
      data-variant={variant}
      data-size={size}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      {...rest}
    >
      {busy ? <Spinner size={size === "lg" ? 14 : 12} /> : iconNode(icon, size === "sm" ? ICON.small : ICON.row)}
      {children != null && <span className="ui-button-label">{children}</span>}
      {iconNode(trailing, ICON.control, "semibold")}
    </button>
  );
});

export interface IconButtonProps extends Native {
  /** An SF Symbol name or a node. */
  icon: string | ReactNode;
  /** Required: the tooltip and the accessible name. */
  label: string;
  /** Its shortcut, shown in the tooltip. */
  shortcut?: string;
  size?: Size;
  /** Ghost (default) for bars and toolbars; default for a filled square beside other controls. */
  variant?: "ghost" | "default";
  /** On (a panel that is shown, a mode that is active). */
  pressed?: boolean;
  iconSize?: number;
  /** Its icon in a tone: accent (something is on, a device is connected), needs (it needs a look). */
  tone?: "accent" | "needs";
  /** The icon pulses: something waits for an answer. */
  pulse?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, shortcut, size = "md", variant = "ghost", pressed, iconSize, tone, pulse, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cls("ui-icon-button", className)}
      data-tone={tone}
      data-pulse={pulse || undefined}
      data-variant={variant}
      data-size={size}
      aria-label={label}
      aria-pressed={pressed}
      data-tip={label}
      data-tip-key={shortcut}
      {...rest}
    >
      {iconNode(icon, iconSize ?? (size === "sm" ? ICON.small : ICON.toolbar))}
    </button>
  );
});

/** An action inside running text or a dim note: accent text, no box. */
export const LinkButton = forwardRef<HTMLButtonElement, Native & { tone?: "accent" | "dim" | "danger" }>(function LinkButton(
  { tone = "accent", className, ...rest },
  ref,
) {
  return <button ref={ref} type="button" className={cls("ui-link", className)} data-tone={tone} {...rest} />;
});

/**
 * A small rounded button for a snippet a click puts somewhere: a variable under the field
 * it goes into ({{branch}} under a command). `mono` for code; the tooltip says what it is.
 */
export const Pill = forwardRef<HTMLButtonElement, Native & { mono?: boolean }>(function Pill({ mono, className, ...rest }, ref) {
  return <button ref={ref} type="button" className={cls("ui-pill", className)} data-mono={mono || undefined} {...rest} />;
});

/** Pills in a row that wraps. */
export function PillRow({ children }: { children: ReactNode }) {
  return <div className="ui-pill-row">{children}</div>;
}

/**
 * Buttons that belong together. "joined" makes them one control with shared
 * edges (Back | Forward, − | +); "spaced" (default) lays them out in a row with
 * the standard gap, for a dialog's or a section's actions. "fill" shares the
 * row's width between them (a popover's actions, edge to edge).
 */
export function ButtonGroup({
  joined,
  align,
  fill,
  className,
  children,
  label,
}: {
  joined?: boolean;
  /** Spaced groups: push to the end of the row (dialog footers). */
  align?: "start" | "end" | "between";
  /** Spaced groups: the buttons share the row's width equally. */
  fill?: boolean;
  className?: string;
  label?: string;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className={cls(joined ? "ui-button-joined" : "ui-button-row", className)} data-align={align} data-fill={fill || undefined}>
      {children}
    </div>
  );
}

/**
 * Back to the latest: a round button floating over a scroller's end corner while the
 * view is away from its end (a terminal scrolled up, a log). `unread` adds a dot:
 * something new arrived meanwhile. It pops in and out with `open` (usePresence), so
 * keep it mounted; place it with `className` (absolute, in the scroller's frame).
 */
export function JumpButton({
  open,
  unread,
  label = "Jump to Latest",
  icon = "arrow.down",
  onClick,
  className,
}: {
  open: boolean;
  unread?: boolean;
  label?: string;
  icon?: string;
  onClick: () => void;
  className?: string;
}) {
  const { present, closing } = usePresence(open);
  if (!present) return null;
  return (
    <button
      type="button"
      className={cls("ui-jump", className)}
      aria-label={unread ? `${label}, new output` : label}
      data-tip={label}
      data-motion="pop"
      data-closing={closing || undefined}
      inert={closing}
      onClick={onClick}
    >
      {iconNode(icon, ICON.toolbar)}
      {unread && <span className="ui-jump-dot" />}
    </button>
  );
}
