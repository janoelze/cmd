// Icons in the kit: Phosphor (MIT, phosphoricons.com), named by Phosphor's own names
// ("caret-down", "magnifying-glass", "terminal-window"), drawn as glyphs of its fonts
// (fonts/, built by `pnpm symbols`), so they take currentColor and scale like text,
// the same in the app, the phone client and a browser.

import type { ReactElement, ReactNode } from "react";
import { ICONS, type IconName } from "./icons.gen.ts";

export { ICONS, type IconName };

/** Phosphor's weights the kit ships: regular for most things, bold for small glyphs inside controls, fill for a solid mark (a play button, a filled status). */
export type IconWeight = "light" | "regular" | "bold" | "fill";
export interface IconProps {
  name: IconName;
  /** Size in points, as SF Symbols are sized (ICON); drawn at glyphPx. */
  size?: number;
  weight?: IconWeight;
  className?: string;
}
/** A named icon or a custom mark (any element). */
export type IconLike = IconName | ReactElement;

/**
 * Icon sizes (points), macOS conventions for small controls. Change the scale
 * here, not per use.
 */
export const ICON = {
  /** the app window's top bar and footer */
  bar: 14,
  /** window toolbars (browser, files) */
  toolbar: 14,
  /** rows in lists and trees */
  row: 13,
  /** small marks: window-kind icons in sidebar rows and title bars */
  small: 12,
  /** disclosure chevrons */
  disclosure: 8,
  /** inside controls: popup chevrons, steppers, field icons */
  control: 9,
  /** a feature's mark (FeatureList) */
  feature: 22,
  /** the mark of an empty view or a window's state (a blank browser window, no results) */
  empty: 20,
} as const;

/** Whether `name` is a Phosphor icon (names that come from data: a workspace's icon, a widget's manifest). */
export function isIconName(name: unknown): name is IconName {
  return typeof name === "string" && Object.hasOwn(ICONS, name);
}

/** A name from data as an icon, else `fallback`. */
export function iconOr(name: string | null | undefined, fallback: IconName): IconName {
  return isIconName(name) ? name : fallback;
}

/**
 * The glyph's size in pixels for an icon size in points. Phosphor draws its ink in
 * about 80% of the em, where an SF Symbol of a point size fills it, so 1.25× keeps
 * the sizes the kit's scale was made with. From 14px up it snaps to Phosphor's grid
 * (multiples of 8): only there its strokes land on whole device pixels on a 2× screen,
 * so 13 and 14 pt both draw at a crisp 16px rather than a soft 16.25 or 17.5.
 */
export function glyphPx(size: number): number {
  const px = size * 1.25;
  return px >= 14 ? Math.round(px / 8) * 8 : Math.round(px);
}

export function Icon({ name, size = 14, weight = "regular", className }: IconProps) {
  return (
    <span className={className ? `ui-icon ${className}` : "ui-icon"} data-glyph={name} data-weight={weight === "regular" ? undefined : weight} style={{ fontSize: glyphPx(size) }} aria-hidden>
      {String.fromCodePoint(ICONS[name])}
    </span>
  );
}

/** An icon given by name, or a custom mark as is. */
export function iconNode(icon: IconLike | undefined, size: number = ICON.row, weight?: IconWeight): ReactNode {
  return typeof icon === "string" ? <Icon name={icon} size={size} weight={weight} /> : icon;
}
