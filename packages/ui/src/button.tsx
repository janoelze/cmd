// Buttons: Button (text, with an optional icon), IconButton (an icon alone, for
// toolbars and bars), LinkButton (an inline action in running text) and
// ButtonGroup (buttons joined into one control, or spaced in a row).
//
// Variants: default (a filled control, like the Settings window's), primary
// (the accent: one per view, the thing Enter does), danger (removes or
// destroys), ghost (no fill until hovered: toolbars, bars, quiet actions).
// Sizes follow the control heights (--control-h-sm / -h / -h-lg).

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ICON, iconNode } from "./icon.tsx";
import { Spinner } from "./status.tsx";

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
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, shortcut, size = "md", variant = "ghost", pressed, iconSize, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cls("ui-icon-button", className)}
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
 * Buttons that belong together. "joined" makes them one control with shared
 * edges (Back | Forward, − | +); "spaced" (default) lays them out in a row with
 * the standard gap, for a dialog's or a section's actions.
 */
export function ButtonGroup({
  joined,
  align,
  className,
  children,
  label,
}: {
  joined?: boolean;
  /** Spaced groups: push to the end of the row (dialog footers). */
  align?: "start" | "end" | "between";
  className?: string;
  label?: string;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className={cls(joined ? "ui-button-joined" : "ui-button-row", className)} data-align={align}>
      {children}
    </div>
  );
}
