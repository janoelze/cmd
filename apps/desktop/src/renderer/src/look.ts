// The window look settings as CSS tokens on :root, so every page and everything
// portalled out of .app (dialogs) gets them: --window-radius (ui.windowRadius),
// --window-outline (ui.windowOutline), --window-edge-mix (ui.windowOutlineContrast),
// --window-elevation (ui.windowShadow), --focus-outline and --focus-glow, and
// data-focus-color (ui.focusColor). styles.css builds windows and sheets from them.

import type { Settings } from "@cmd/protocol";

/** ui.windowShadow as an elevation: each step's shadow is larger and darker (styles.css, .tile-frame). */
const ELEVATION: Record<Settings["ui.windowShadow"], number> = { none: 0, subtle: 0.5, medium: 1, strong: 2, deep: 3.5 };

export function applyLookSettings(s: Settings): void {
  const root = document.documentElement;
  root.style.setProperty("--window-radius", `${s["ui.windowRadius"]}px`);
  root.style.setProperty("--window-outline", `${s["ui.windowOutline"]}px`);
  root.style.setProperty("--window-edge-mix", `${s["ui.windowOutlineContrast"]}%`);
  root.style.setProperty("--window-elevation", String(ELEVATION[s["ui.windowShadow"]] ?? 0.5));
  root.style.setProperty("--focus-outline", `${s["ui.focusOutline"]}px`);
  root.style.setProperty("--focus-glow", `${s["ui.focusGlow"] / 50}`);
  root.dataset.focusColor = s["ui.focusColor"];
}
