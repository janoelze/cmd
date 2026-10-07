// Windows: the shell an app's windows are drawn in (cmd's tiles and sidebars),
// and that Dialog's window sheets share. Window is the outlined box, WindowBody
// clips the content, WindowFrame draws the outline, the ring and the shadow over
// it, WindowBar is the title bar and WindowBarMenu a menu at its right end.
// The parts take any element props, so the app keeps its own handlers (drag,
// selection, context menus) and class names on them. Their look comes from the
// --window-* tokens (tokens.css), which an app maps to its settings.

import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { ICON, iconNode } from "./icon.tsx";

const cls = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

type DivProps = HTMLAttributes<HTMLDivElement>;

/**
 * The window's box: its outline and corners. Selected or needing attention, its outline is a ring (the highlight, or the attention colour).
 * `label` (its title) names it, so a script or VoiceOver finds "the zsh window"; the selected one is aria-current.
 */
export const Window = forwardRef<HTMLDivElement, DivProps & { selected?: boolean; attention?: boolean; label?: string }>(function Window({ selected, attention, label, className, ...rest }, ref) {
  return (
    <div
      ref={ref}
      className={cls("ui-window", className)}
      role={label ? "group" : undefined}
      aria-label={label}
      aria-current={selected || undefined}
      data-selected={selected || undefined}
      data-attention={attention || undefined}
      {...rest}
    />
  );
});

/** Clips the content to the window's inner corners; put the bar and the content in it. */
export function WindowBody({ className, ...rest }: DivProps) {
  return <div className={cls("ui-window-body", className)} {...rest} />;
}

/** Over the outline: draws it, the ring and the shadow, so the content never moves when the ring changes. */
export function WindowFrame({ className, ...rest }: DivProps) {
  return <div className={cls("ui-window-frame", className)} {...rest} />;
}

/** The title bar. Children are the app's: an icon, the name, info; or `icon` and `name` for a plain one. */
export const WindowBar = forwardRef<HTMLDivElement, DivProps & { icon?: string | ReactNode; name?: ReactNode }>(function WindowBar({ icon, name, className, children, ...rest }, ref) {
  return (
    <div ref={ref} className={cls("ui-window-bar", className)} {...rest}>
      {icon && <span className="ui-window-bar-icon">{iconNode(icon, ICON.small)}</span>}
      {name != null && <span className="ui-window-bar-name">{name}</span>}
      {children}
    </div>
  );
});

/** A menu at the bar's right end: its label and a chevron (a widget's scope and options). */
export function WindowBarMenu({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={cls("ui-window-bar-menu", className)} {...rest}>
      {children}
      {iconNode("chevron.down", ICON.disclosure)}
    </button>
  );
}
