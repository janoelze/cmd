// macOS menu bar built from the shared command list (menu-template.ts). Clicks are forwarded
// to the focused window's renderer, which implements every command.

import { app, BrowserWindow, Menu } from "electron";
import type { Keybindings, MenuState } from "../shared/commands.ts";
import { menuTemplate } from "./menu-template.ts";

type Send = (id: string) => void;

let lastState: MenuState | null = null;
let built: { send: Send; bindings: Keybindings; openRecent: (path: string) => void; lists: string } | null = null;

export function buildMenu(send: Send, bindings: Keybindings, openRecent: (path: string) => void): void {
  const lists = lastState?.lists;
  built = { send, bindings, openRecent, lists: JSON.stringify(lists ?? null) };
  const template = menuTemplate(send, bindings, { mac: process.platform === "darwin", appName: app.name, lists, openRecent });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (lastState) applyMenuState(lastState);
}

export function applyMenuState(state: MenuState): void {
  lastState = state;
  // Labels can't change on a built menu: new workspace lists rebuild it (rare: a workspace opened, closed or renamed).
  if (built && state.lists && JSON.stringify(state.lists) !== built.lists) return buildMenu(built.send, built.bindings, built.openRecent);
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  for (const [id, v] of Object.entries(state.checked)) {
    const mi = menu.getMenuItemById(id);
    if (mi) mi.checked = !!v;
  }
  for (const [id, v] of Object.entries(state.enabled)) {
    const mi = menu.getMenuItemById(id);
    if (mi) mi.enabled = !!v;
  }
}

/** Sends a command to the focused window, creating one if needed. */
interface UtilityWindows {
  openSettings: (page?: string) => void;
  checkForUpdates: () => void;
  /** Settings (or the Workbench). */
  isUtility: (w: BrowserWindow | null) => boolean;
  appWindows: () => BrowserWindow[];
}

/** Utility windows handle closing and text editing themselves; other commands go to an app window. */
const UTILITY_COMMANDS = new Set(["edit.copy", "edit.selectAll"]);

/** createWindow: null when no app window may open (the Workbench): the command is dropped. */
export function commandSender(createWindow: () => BrowserWindow | null, s: UtilityWindows): Send {
  return (id) => {
    if (id === "app.settings") return s.openSettings();
    if (id === "app.remoteAccess") return s.openSettings("remote");
    if (id === "app.pairDevice") return s.openSettings("remote/pair");
    if (id === "app.checkUpdates") return s.checkForUpdates();
    const focused = BrowserWindow.getFocusedWindow();
    if (s.isUtility(focused)) {
      if (id === "file.close" || id === "file.closeWindow") return focused!.close();
      if (UTILITY_COMMANDS.has(id)) return focused!.webContents.send("command", id);
    }
    let win = (focused && !s.isUtility(focused) ? focused : null) ?? s.appWindows()[0];
    if (win && s.isUtility(focused)) win.focus();
    if (!win) {
      win = createWindow() ?? undefined;
      if (!win) return;
      win.webContents.once("did-finish-load", () => win!.webContents.send("command", id));
      return;
    }
    win.webContents.send("command", id);
  };
}
