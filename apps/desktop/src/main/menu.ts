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
  // The app-name menu (About, Services, Hide…) is a macOS convention; elsewhere
  // Settings and Quit live in File.
  const mac = process.platform === "darwin";
  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: "about" },
      ...i("app.checkUpdates"),
      sep,
      ...i("app.settings"),
      ...i("app.setup"),
      ...i("app.remoteAccess"),
      ...i("app.pairDevice"),
      sep,
      { role: "services" },
      sep,
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      sep,
      { role: "quit" },
    ],
  };
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [appMenu] : []),
    {
      label: "File",
      submenu: [
        ...i("file.new"),
        sep,
        ...i("file.newTerminal"),
        ...i("file.newClaude"),
        ...i("file.newCodex"),
        sep,
        ...i("file.newBrowser"),
        ...i("file.newFiles"),
        ...i("file.newText"),
        sep,
        ...i("file.openSpace"),
        ...i("file.newWindow"),
        sep,
        ...i("file.save"),
        sep,
        ...i("file.close"),
        ...i("file.closeWindow"),
        sep,
        ...i("file.openSettingsFile"),
        ...(mac ? [] : [sep, ...i("app.settings"), ...i("app.setup"), ...i("app.remoteAccess"), ...i("app.pairDevice"), sep, { role: "quit" as const }]),
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
        ...i("edit.find"),
        ...i("edit.findNext"),
        ...i("edit.findPrev"),
        ...i("edit.findReplace"),
        ...i("edit.findSelection"),
        sep,
        ...i("edit.copyLastOutput"),
        ...i("terminal.prevPrompt"),
        ...i("terminal.nextPrompt"),
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
        ...i("view.toggleFocus"),
        ...i("view.canvasFit"),
        ...i("view.canvasZoomWindow"),
        ...i("view.cycleWidth"),
        ...i("view.widen"),
        ...i("view.narrow"),
        ...i("view.toggleEdit"),
        sep,
        ...i("view.sidebar"),
        ...i("view.rightSidebar"),
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
        ...i("session.summarize"),
        ...i("session.reveal"),
      ],
    },
    {
      label: "Space",
      submenu: [
        ...i("space.next"),
        ...i("space.prev"),
        ...i("space.last"),
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => {
          const [main] = i(`space.select${n}` as CommandId);
          return [{ ...main!, visible: false, acceleratorWorksWhenHidden: true }];
        }),
        sep,
        ...i("space.moveWindow"),
        ...i("space.rename"),
        ...i("space.icon"),
        ...i("space.reveal"),
        sep,
        ...i("space.close"),
      ],
    },
    {
      label: "Widgets",
      submenu: [
        ...i("widget.library"),
        ...i("file.newMagic"),
        sep,
        ...i("view.magicChange"),
        ...i("view.magicRefresh"),
        ...i("view.magicStop"),
        sep,
        ...i("widget.remove"),
      ],
    },
    {
      role: "windowMenu",
      submenu: [{ role: "minimize" }, { role: "zoom" }, sep, ...i("window.dockLeft"), ...i("window.dockRight"), ...i("window.undock"), sep, ...i("window.screenshotSize"), sep, ...i("app.taskManager"), ...i("app.restartCore"), ...(mac ? [sep, { role: "front" as const }] : [])],
    },
    { role: "help", submenu: [...i("help.docs"), ...i("help.whatsNew"), ...i("help.feedback"), ...(mac ? [] : [sep, ...i("app.checkUpdates")])] },
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
interface UtilityWindows {
  openSettings: (page?: string) => void;
  openTaskManager: () => void;
  checkForUpdates: () => void;
  /** Settings or the Task Manager. */
  isUtility: (w: BrowserWindow | null) => boolean;
  appWindows: () => BrowserWindow[];
}

/** Utility windows handle closing and text editing themselves; other commands go to an app window. */
const UTILITY_COMMANDS = new Set(["edit.copy", "edit.selectAll"]);

export function commandSender(createWindow: () => BrowserWindow, s: UtilityWindows): Send {
  return (id) => {
    if (id === "app.settings") return s.openSettings();
    if (id === "app.taskManager") return s.openTaskManager();
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
      win = createWindow();
      win.webContents.once("did-finish-load", () => win!.webContents.send("command", id));
      return;
    }
    win.webContents.send("command", id);
  };
}
