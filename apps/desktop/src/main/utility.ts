// Utility windows: one native Settings window (⌘,), like a macOS app's: a sidebar
// of categories, drawn like the main window's; in dev builds, the Workbench. Each
// has its own page and bundle (renderer/<page>.html).

import path from "node:path";
import { app, autoUpdater, BrowserWindow } from "electron";
import { SETTINGS_TITLEBAR_HEIGHT, trafficLights } from "../shared/chrome.ts";
import { savedAppearance, themeQuery } from "./appearance.ts";

const here = import.meta.dirname; // apps/desktop/out/main

export type UtilityPage = "settings" | "workbench";
let quitting = false;
app.on("before-quit", () => (quitting = true));
// An update restart closes every window before before-quit.
autoUpdater.on("before-quit-for-update", () => (quitting = true));
const utility = new Map<UtilityPage, BrowserWindow>();
export const utilityWindow = (page: UtilityPage) => utility.get(page);
export const isSettings = (w: BrowserWindow | null | undefined) => !!w && w === utility.get("settings");
/** Settings or the Workbench: not an app window. */
export const isUtility = (w: BrowserWindow | null | undefined) => !!w && [...utility.values()].includes(w);

/** at: a page inside the window to show (Settings: "remote", "remote/pair"). */
export function openUtility(page: UtilityPage, o: { title: string; width: number; height: number; minWidth: number; minHeight: number }, at?: string): BrowserWindow {
  const open = utility.get(page);
  if (open && !open.isDestroyed()) {
    open.show();
    open.focus();
    if (at) open.webContents.send("settings-page", at);
    return open;
  }
  const win = new BrowserWindow({
    ...o,
    show: false,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: trafficLights(SETTINGS_TITLEBAR_HEIGHT) } : {}),
    backgroundColor: savedAppearance().background,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(here, "../preload/index.cjs"),
      sandbox: false,
      contextIsolation: true,
      // Stories of the browser and YouTube windows show real pages.
      webviewTag: page === "workbench",
    },
  });
  utility.set(page, win);
  win.on("closed", () => utility.get(page) === win && utility.delete(page));
  // Settings stays loaded once opened: closing hides it, so ⌘, again shows it at once (a new one takes ~150 ms to paint).
  if (page === "settings")
    win.on("close", (e) => {
      if (quitting) return;
      e.preventDefault();
      win.hide();
    });
  // `pnpm workbench --headless`: an agent drives it without taking over the screen (no window, no Dock icon: whenReady).
  win.once("ready-to-show", () => (page !== "workbench" || !process.env.CMD_WORKBENCH_HIDDEN) && win.show());
  const search = `?${new URLSearchParams({ ...(at ? { [page === "workbench" ? "story" : "page"]: at } : {}), ...themeQuery() })}`;
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}.html${search}`);
  else win.loadFile(path.join(here, `../renderer/${page}.html`), { search });
  return win;
}
