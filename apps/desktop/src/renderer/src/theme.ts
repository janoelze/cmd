// The app's theme from settings: applyThemeSettings picks the theme from the
// theme.* settings (Auto follows the system), applies it (@cmd/ui/themes) and
// tells the main process (native appearance, window background, Dock icon). Both the app
// and the Settings window call it.

import type { Settings } from "@cmd/protocol";
import { applyTheme, resolveTheme } from "@cmd/ui/themes";
import type { Theme } from "@cmd/ui/themes/types";
import { cmd } from "./bridge.ts";

let lastSettings: Pick<Settings, "theme.appearance" | "theme.dark" | "theme.light" | "theme.dockIcon"> | undefined;
const systemDark = matchMedia("(prefers-color-scheme: dark)");

/** A theme that wins over the settings' (the Workbench's theme picker), or null to follow them again. */
let pinned: Theme | null = null;
export function pinTheme(t: Theme | null): void {
  pinned = t;
  if (t) {
    applyTheme(t);
    cmd.setAppearance({ source: t.appearance, background: t.colors.bg, dockIcon: null });
  } else sync();
}

/** Apply the theme the settings choose; call on every settings snapshot. */
export function applyThemeSettings(s: Settings): void {
  lastSettings = { "theme.appearance": s["theme.appearance"], "theme.dark": s["theme.dark"], "theme.light": s["theme.light"], "theme.dockIcon": s["theme.dockIcon"] };
  sync();
}

function sync(): void {
  if (!lastSettings || pinned) return;
  const appearance = lastSettings["theme.appearance"] === "auto" ? (systemDark.matches ? "dark" : "light") : lastSettings["theme.appearance"];
  const t = resolveTheme(appearance, lastSettings["theme.dark"], lastSettings["theme.light"]);
  applyTheme(t);
  // Auto lets macOS decide, so prefers-color-scheme (above) tracks the system.
  const source = lastSettings["theme.appearance"] === "auto" ? "system" : t.appearance;
  cmd.setAppearance({ source, background: t.colors.bg, dockIcon: lastSettings["theme.dockIcon"] ? t.id : null });
}

// Auto: the system switched between light and dark.
systemDark.addEventListener("change", sync);
