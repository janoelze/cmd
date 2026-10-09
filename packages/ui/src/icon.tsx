// Icons in the kit. Components name icons by SF Symbol name ("chevron.down",
// "magnifyingglass") and draw them through the host's renderer: the app passes
// its native SF Symbol component (<UIProvider icon={Symbol}>); without one (the
// gallery in a browser) they are Lucide outlines (lucide.ts), tinted with
// currentColor through a mask like the native ones.

import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import { lucideSymbol } from "./lucide.ts";

export type IconWeight = "ultralight" | "thin" | "light" | "regular" | "medium" | "semibold" | "bold";
export interface IconProps {
  name: string;
  /** Point size, like a font size. */
  size?: number;
  weight?: IconWeight;
  className?: string;
}

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

function LucideIcon({ name, size = 14, weight = "medium", className = "" }: IconProps) {
  const img = lucideSymbol(name, size, weight);
  const side = Math.ceil(size / 2) * 2;
  return (
    <span
      className={`sf ${className}`}
      aria-hidden
      style={{
        width: side,
        height: side,
        ...(img ? { WebkitMaskImage: `url("${img.url}")`, maskImage: `url("${img.url}")`, WebkitMaskSize: "contain", maskSize: "contain" } : { opacity: 0 }),
      }}
    />
  );
}

interface UIConfig {
  icon: ComponentType<IconProps>;
}
const Config = createContext<UIConfig>({ icon: LucideIcon });

/** What the kit draws with: the host's icon renderer. */
export function UIProvider({ icon, children }: { icon?: ComponentType<IconProps>; children: ReactNode }) {
  return <Config.Provider value={{ icon: icon ?? LucideIcon }}>{children}</Config.Provider>;
}

export function Icon(p: IconProps) {
  const R = useContext(Config).icon;
  return <R {...p} />;
}

/** An icon given by name, or any node as is (a custom mark). */
export function iconNode(icon: string | ReactNode | undefined, size: number = ICON.row, weight?: IconWeight): ReactNode {
  return typeof icon === "string" ? <Icon name={icon} size={size} weight={weight} /> : icon;
}
