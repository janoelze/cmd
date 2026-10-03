// macOS menu bar built from the shared command list. Clicks are forwarded to
// the focused window's renderer, which implements every command.

import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { COMMAND_BY_ID, type CommandId, type Keybindings, type MenuState } from "../shared/commands.ts";

type Send = (id: string) => void;

function item(id: CommandId, send: Send, bindings: Keybindings): MenuItemConstructorOptions[] {
  const c = COMMAND_BY_ID.get(id)!;
  const [first, ...rest] = bindings[id] ?? [];
  const main: MenuItemConstructorOptions = {
    id,
    label: c.label,
    accelerator: first,
    type: c.checkable,
    click: () => send(id),
  };
  // Extra shortcuts are hidden items that still respond to their key.
  const aliases = rest.map(
    (acc): MenuItemConstructorOptions => ({
      label: c.label,
      accelerator: acc,
      visible: false,
      acceleratorWorksWhenHidden: true,
      click: () => send(id),
    }),
  );
  return [main, ...aliases];
}

const sep: MenuItemConstructorOptions = { type: "separator" };

let lastState: MenuState | null = null;

export function buildMenu(send: Send, bindings: Keybindings): void {
  const i = (id: CommandId) => item(id, send, bindings);
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        sep,
        ...i("app.settings"),
        sep,
        { role: "services" },
        sep,
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        sep,
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        ...i("file.newTerminal"),
        ...i("file.newClaude"),
        ...i("file.newCodex"),
        sep,
        ...i("file.newBrowser"),
        ...i("file.newFiles"),
        sep,
        ...i("file.save"),
        sep,
        ...i("file.close"),
        ...i("file.closeWindow"),
        sep,
        ...i("file.openSettingsFile"),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        sep,
        { role: "cut" },
        ...i("edit.copy"),
        { role: "paste" },
        ...i("edit.selectAll"),
        sep,
        ...i("edit.clear"),
      ],
    },
    {
      label: "View",
      submenu: [
        ...i("view.focus"),
        ...i("view.grid"),
        ...i("view.strip"),
        ...i("view.canvas"),
        ...i("view.canvasFit"),
        ...i("view.canvasZoomWindow"),
        ...i("view.cycleWidth"),
        ...i("view.toggleEdit"),
        sep,
        ...i("view.sidebar"),
        sep,
        ...i("view.palette"),
        ...i("view.search"),
        sep,
        ...i("view.zoomIn"),
        ...i("view.zoomOut"),
        ...i("view.zoomReset"),
        sep,
        { role: "togglefullscreen" },
        sep,
        { label: "Developer", submenu: [{ role: "reload" }, { role: "toggleDevTools" }] },
      ],
    },
    {
      label: "Session",
      submenu: [
        ...i("session.next"),
        ...i("session.prev"),
        ...i("session.nextAttention"),
        sep,
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => {
          const [main] = i(`session.select${n}` as CommandId);
          return [{ ...main!, visible: false, acceleratorWorksWhenHidden: true }];
        }),
        ...i("session.copyResume"),
        ...i("session.copyId"),
        ...i("session.reveal"),
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: [...i("help.docs")] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (lastState) applyMenuState(lastState);
}

export function applyMenuState(state: MenuState): void {
  lastState = state;
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
interface SettingsWindow {
  openSettings: () => void;
  isSettings: (w: BrowserWindow | null) => boolean;
  appWindows: () => BrowserWindow[];
}

/** The Settings window handles closing and text editing itself; other commands go to an app window. */
const SETTINGS_COMMANDS = new Set(["edit.copy", "edit.selectAll"]);

export function commandSender(createWindow: () => BrowserWindow, s: SettingsWindow): Send {
  return (id) => {
    if (id === "app.settings") return s.openSettings();
    const focused = BrowserWindow.getFocusedWindow();
    if (s.isSettings(focused)) {
      if (id === "file.close" || id === "file.closeWindow") return focused!.close();
      if (SETTINGS_COMMANDS.has(id)) return focused!.webContents.send("command", id);
    }
    let win = (focused && !s.isSettings(focused) ? focused : null) ?? s.appWindows()[0];
    if (win && s.isSettings(focused)) win.focus();
    if (!win) {
      win = createWindow();
      win.webContents.once("did-finish-load", () => win!.webContents.send("command", id));
      return;
    }
    win.webContents.send("command", id);
  };
}
