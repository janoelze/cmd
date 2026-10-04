// Bridges the renderer to the core socket. Reconnects if the core restarts.

import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { CoreEvent, Method, Params, Result } from "@cmd/protocol";
import { connect, type Connection } from "@cmd/protocol/node";
import type { ContextItem, MenuState } from "../shared/commands.ts";
import type { KeybindingsSnapshot } from "../main/keybindings.ts";
import type { Appearance } from "../main/appearance.ts";
import type { UpdateStatus } from "../main/updater.ts";
import type { CrashStatus } from "../main/crash.ts";
import type { FeedbackRequest, FeedbackStatus } from "../main/feedback.ts";
import type { AppProcess } from "../main/metrics.ts";

export interface AppInfo {
  version: string;
  /** pnpm dev or a pnpm dist build: own core and state, no self-update. */
  dev: boolean;
  electron: string;
  chrome: string;
  /** Source hash of the core this app ships (compare with core.info's build). */
  build: string;
  home: string;
  /** Where the logs and crash reports are (release and development builds each have their own). */
  logs: string;
  coreLog: string;
  updateLog: string;
  updates: UpdateStatus;
  crashes: CrashStatus;
}

type Status = "connecting" | "connected" | "disconnected";

/** Main decides which core this app uses (development builds run their own). */
const socketPath: string = ipcRenderer.sendSync("core-socket");
let conn: Connection | null = null;
let ready: Promise<Connection>;
const eventListeners = new Set<(e: CoreEvent) => void>();
const statusListeners = new Set<(s: Status) => void>();

function setStatus(s: Status): void {
  for (const fn of statusListeners) fn(s);
}

function open(): Promise<Connection> {
  setStatus("connecting");
  ready = (async () => {
    // The window opens while the core starts (main/index.ts), so the first
    // attempts fail; retry quickly at first, then back off to 500 ms.
    for (let attempt = 0; ; attempt++) {
      try {
        const c = await connect(socketPath);
        conn = c;
        c.client.onEvent((e) => {
          for (const fn of eventListeners) fn(e);
        });
        c.closed.then(() => {
          conn = null;
          setStatus("disconnected");
          setTimeout(open, 500);
        });
        setStatus("connected");
        return c;
      } catch {
        await new Promise((r) => setTimeout(r, Math.min(500, 20 * 1.15 ** attempt)));
      }
    }
  })();
  return ready;
}
open();

const api = {
  async call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    const c = conn ?? (await ready);
    return c.client.call(method, params);
  },
  onEvent(fn: (e: CoreEvent) => void): () => void {
    eventListeners.add(fn);
    return () => eventListeners.delete(fn);
  },
  /** Fires immediately with "connected" if already connected. */
  onStatus(fn: (s: Status) => void): () => void {
    statusListeners.add(fn);
    if (conn) fn("connected");
    return () => statusListeners.delete(fn);
  },
  setBadge: (count: number) => ipcRenderer.send("badge", count),
  /** The Dock icon's progress bar: 0–1, >1 indeterminate, <0 none. */
  setProgress: (value: number) => ipcRenderer.send("progress", value),
  bounce: () => ipcRenderer.send("bounce"),
  /** A macOS system sound by name (SYSTEM_SOUNDS), e.g. a widget's cmd.sound(). */
  playSound: (name: string) => ipcRenderer.send("play-sound", name),
  /** A system notification; a newer one with the same tag replaces it (see main/index.ts). */
  notify: (o: { tag: string; title: string; body: string; sound: string | null; paneId: string | null }) =>
    ipcRenderer.send("notify", o),
  closeNotification: (tag: string) => ipcRenderer.send("notify-close", tag),
  onNotificationClick(fn: (paneId: string) => void): () => void {
    const h = (_e: unknown, paneId: string) => fn(paneId);
    ipcRenderer.on("notification-click", h);
    return () => ipcRenderer.off("notification-click", h);
  },
  /** Native appearance (traffic lights, menus, vibrancy), window background and Dock icon for the active theme. */
  setAppearance: (a: Appearance) => ipcRenderer.send("appearance", a),
  focusWindow: () => ipcRenderer.send("focus"),
  openPath: (p: string) => ipcRenderer.send("open-path", p),
  /** The Settings window (opens it, or brings it to the front), optionally at a page (e.g. "remote"). */
  openSettings: (page?: string) => ipcRenderer.send("settings-window", page),
  /** Settings window: main asks to show a page. */
  onSettingsPage(fn: (page: string) => void): () => void {
    const h = (_e: unknown, page: string) => fn(page);
    ipcRenderer.on("settings-page", h);
    return () => ipcRenderer.off("settings-page", h);
  },
  checkForUpdates: () => ipcRenderer.send("check-updates"),
  /** Task Manager: Electron's processes (CPU% since the previous call), and showing a terminal in its Space's window. */
  appMetrics: (): Promise<AppProcess[]> => ipcRenderer.invoke("app-metrics"),
  openTaskManager: () => ipcRenderer.send("task-manager"),
  showPane: (spaceId: string, paneId: string) => ipcRenderer.send("show-pane", spaceId, paneId),
  /** Restart into a downloaded update. */
  installUpdate: () => ipcRenderer.send("install-update"),
  /** Settings → About. */
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app-info"),
  restartCore: (): Promise<void> => ipcRenderer.invoke("restart-core"),
  revealPath: (p: string) => ipcRenderer.send("reveal-path", p),
  /** Move a file or folder to the Trash (Finder's Put Back works). */
  trashPath: (p: string): Promise<void> => ipcRenderer.invoke("trash-path", p),
  /** An uncaught error in this page (renderer/src/errors.ts). */
  reportError: (r: { kind: string; message: string; stack: string | null }) => ipcRenderer.send("renderer-error", r),
  openSettingsFile: (p: string) => ipcRenderer.send("open-settings", p),
  openKeybindingsFile: () => ipcRenderer.send("open-keybindings"),
  openDocs: () => ipcRenderer.send("open-docs"),
  /** Help → Send Feedback… (components/Feedback.tsx). */
  feedbackStatus: (): Promise<FeedbackStatus> => ipcRenderer.invoke("feedback-status"),
  sendFeedback: (r: FeedbackRequest): Promise<void> => ipcRenderer.invoke("send-feedback", r),
  closeWindow: () => ipcRenderer.send("close-window"),
  /** Copy / Select All natively in the focused frame, or in a browser window's page by its WebContents id (main/index.ts). */
  editNative: (op: "copy" | "selectAll", guestId?: number) => ipcRenderer.send("edit-native", op, guestId),

  /** Menu bar / Dock menu commands, by command id. */
  onCommand(fn: (id: string) => void): () => void {
    const h = (_e: unknown, id: string) => fn(id);
    ipcRenderer.on("command", h);
    return () => ipcRenderer.off("command", h);
  },
  setMenuState: (s: MenuState) => ipcRenderer.send("menu-state", s),
  /** Links from browser windows that want a new window. */
  onOpenUrl(fn: (url: string) => void): () => void {
    const h = (_e: unknown, url: string) => fn(url);
    ipcRenderer.on("open-url", h);
    return () => ipcRenderer.off("open-url", h);
  },
  keybindings: (): Promise<KeybindingsSnapshot> => ipcRenderer.invoke("keybindings"),
  /** Bind shortcuts to a command in keybindings.json; null restores its defaults. */
  setKeybinding: (id: string, keys: string[] | null): Promise<void> => ipcRenderer.invoke("set-keybinding", id, keys),
  /** keybindings.json back to its template: every default shortcut. */
  resetKeybindings: (): Promise<void> => ipcRenderer.invoke("reset-keybindings"),
  /** Menu shortcuts off while the Settings window records one. */
  recordShortcut: (on: boolean) => ipcRenderer.send("record-shortcut", on),
  /** SF Symbols rendered at an exact point size and pixel density; null for unknown names. */
  sfSymbols: (req: { names: string[]; size: number; weight?: string; scale?: number }): Promise<Record<string, { url: string; w: number; h: number; contain?: boolean } | null>> =>
    ipcRenderer.invoke("sf-symbols", req),
  onKeybindings(fn: (s: KeybindingsSnapshot) => void): () => void {
    const h = (_e: unknown, s: KeybindingsSnapshot) => fn(s);
    ipcRenderer.on("keybindings", h);
    return () => ipcRenderer.off("keybindings", h);
  },
  /**
   * Show a Space (docs/11-spaces.md). Main decides where: the app window that
   * already shows it, else this one (newWindow: a new one). select: a window to
   * select there.
   */
  showSpace: (spaceId: string, o: { select?: string; newWindow?: boolean } = {}) => ipcRenderer.send("space-show", spaceId, o),
  /** This window's Space was closed or forgotten: switch it to Home, or close it if Home is shown elsewhere. */
  spaceLost: () => ipcRenderer.send("space-lost"),
  /** Main tells this window which Space to show. */
  onShowSpace(fn: (o: { spaceId: string; select?: string }) => void): () => void {
    const h = (_e: unknown, o: { spaceId: string; select?: string }) => fn(o);
    ipcRenderer.on("space-show", h);
    return () => ipcRenderer.off("space-show", h);
  },
  /** Native folder picker; null when cancelled. */
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke("choose-folder"),
  /** Native save panel (untitled text windows), starting at `defaultPath`; null when cancelled. */
  chooseSavePath: (defaultPath: string): Promise<string | null> => ipcRenderer.invoke("choose-save-path", defaultPath),
  /** Native sheet; resolves true when confirmed. */
  confirm: (o: { message: string; detail?: string; confirm: string }): Promise<boolean> => ipcRenderer.invoke("confirm", o),
  /** The URL of a Magic widget frame whose CSP allows media from these origins (cmd-widget://, main process). */
  widgetFrame: (media: string[]): Promise<string> => ipcRenderer.invoke("widget-frame", media),
  /** Put text on the clipboard, also while the app isn't focused (navigator.clipboard needs focus): OSC 52 from a background terminal. */
  writeClipboard: (text: string) => ipcRenderer.send("clipboard-write", text),
  /** The path of a file dropped from Finder ("" for one that isn't on disk). */
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
  /** Native context menu; resolves with the chosen item id or null. */
  contextMenu: (items: ContextItem[]): Promise<string | null> => ipcRenderer.invoke("context-menu", items),
};

export type CmdBridge = typeof api;

contextBridge.exposeInMainWorld("cmd", api);
