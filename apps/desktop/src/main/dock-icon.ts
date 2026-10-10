// The Dock icon in the active theme's colours (theme.dockIcon). `pnpm icons`
// renders one per built-in theme with Icon Composer's ictool, glass and rim
// included (build/themes, Resources/dock-icons when packaged); this sets it while
// the app runs. Finder, Launchpad and a closed app keep the bundle icon. Themes
// without a render (user themes) and the Tinted and Clear icon styles of macOS 26
// keep it too: the system draws those live, and a snapshot would stand out.

import { app, systemPreferences } from "electron";
import fs from "node:fs";
import path from "node:path";
import { logger } from "@cmd/protocol/node";

const log = logger("dock-icon");

let dir = "";
/** The theme the renderer asked for; null: the bundle icon. */
let wanted: string | null = null;
/** What the Dock shows. */
let shown: string | null = null;
let started = false;

/**
 * Starts setting the Dock icon, with `initial` (the saved theme) until the
 * renderer says otherwise. Setting one takes ~80 ms on the main thread, so call
 * this once the first window is under way.
 */
export function startDockIcon(iconDir: string, initial: string | null): void {
  dir = iconDir;
  started = true;
  wanted ??= initial;
  apply();
  // The icon style is a system setting with no change event; look again when the user is back.
  app.on("did-become-active", apply);
}

export function setDockIcon(themeId: string | null): void {
  wanted = themeId;
  if (started) apply();
}

function apply(): void {
  if (!app.dock) return;
  const style = systemPreferences.getUserDefault("AppleIconAppearanceTheme", "string"); // e.g. RegularDark, TintedAutomatic, ClearLight; unset is Regular
  const id = wanted && (!style || style.startsWith("Regular")) && fs.existsSync(file(wanted)) ? wanted : null;
  if (id === shown) return;
  // Electron can't unset a Dock icon, so going back means showing the bundle icon's own render.
  log.info(`dock icon: ${id ?? "default"}${style ? ` (icon style ${style})` : ""}`);
  try {
    app.dock.setIcon(file(id ?? "default"));
  } catch (err) {
    // The bundle's files can go while it runs (a rebuilt or moved app); the Dock keeps what it shows.
    log.warn("dock icon not set", err);
    return;
  }
  shown = id;
}

const file = (name: string) => path.join(dir, `${name}.png`);
