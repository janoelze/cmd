// The active theme's native side, sent by the renderer (themes/registry.ts):
// macOS appearance (traffic lights, menus, vibrancy, prefers-color-scheme) and
// the window background, and the theme whose Dock icon to show. Saved, so the next launch starts in the same look
// before the renderer has loaded.

import { nativeTheme } from "electron";
import fs from "node:fs";
import path from "node:path";
import { cmdHome } from "@cmd/protocol/node";

export interface Appearance {
  /** "system" for the Auto setting. */
  source: "system" | "dark" | "light";
  background: string;
  /** The theme whose Dock icon to show (dock-icon.ts); null: the app's own. */
  dockIcon?: string | null;
}

const file = () => path.join(cmdHome(), "appearance.json");
let saved: Appearance | null = null;

export function savedAppearance(): Appearance {
  if (saved) return saved;
  try {
    saved = JSON.parse(fs.readFileSync(file(), "utf8")) as Appearance;
  } catch {
    saved = { source: "dark", background: "#1e1e1e" };
  }
  return saved;
}

export function setAppearance(a: Appearance): void {
  nativeTheme.themeSource = a.source;
  const prev = savedAppearance();
  if (prev.source === a.source && prev.background === a.background && prev.dockIcon === a.dockIcon) return;
  saved = a;
  try {
    fs.writeFileSync(file(), JSON.stringify(a));
  } catch {}
}
