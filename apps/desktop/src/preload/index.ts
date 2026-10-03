// Bridges the renderer to the core socket. Reconnects if the core restarts.

import { contextBridge, ipcRenderer } from "electron";
import type { CoreEvent, Method, Params, Result } from "@cmd/protocol";
import { connect, type Connection } from "@cmd/protocol/node";
import type { ContextItem, MenuState } from "../shared/commands.ts";
import type { KeybindingsSnapshot } from "../main/keybindings.ts";
import type { Appearance } from "../main/appearance.ts";

type Status = "connecting" | "connected" | "disconnected";

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
        const c = await connect();
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
  bounce: () => ipcRenderer.send("bounce"),
  /** A system notification; a newer one with the same tag replaces it (see main/index.ts). */
  notify: (o: { tag: string; title: string; body: string; sound: string | null; paneId: string | null }) =>
    ipcRenderer.send("notify", o),
  closeNotification: (tag: string) => ipcRenderer.send("notify-close", tag),
  onNotificationClick(fn: (paneId: string) => void): () => void {
    const h = (_e: unknown, paneId: string) => fn(paneId);
    ipcRenderer.on("notification-click", h);
    return () => ipcRenderer.off("notification-click", h);
  },
  /** Native appearance (traffic lights, menus, vibrancy) and window background for the active theme. */
  setAppearance: (a: Appearance) => ipcRenderer.send("appearance", a),
  focusWindow: () => ipcRenderer.send("focus"),
  openPath: (p: string) => ipcRenderer.send("open-path", p),
  /** The Settings window (opens it, or brings it to the front). */
  openSettings: () => ipcRenderer.send("settings-window"),
  openSettingsFile: (p: string) => ipcRenderer.send("open-settings", p),
  openKeybindingsFile: () => ipcRenderer.send("open-keybindings"),
  openDocs: () => ipcRenderer.send("open-docs"),
  closeWindow: () => ipcRenderer.send("close-window"),

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
  /** Native sheet; resolves true when confirmed. */
  confirm: (o: { message: string; detail?: string; confirm: string }): Promise<boolean> => ipcRenderer.invoke("confirm", o),
  /** Native context menu; resolves with the chosen item id or null. */
  contextMenu: (items: ContextItem[]): Promise<string | null> => ipcRenderer.invoke("context-menu", items),
};

export type CmdBridge = typeof api;

contextBridge.exposeInMainWorld("cmd", api);
