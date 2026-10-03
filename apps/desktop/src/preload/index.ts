// Bridges the renderer to the core socket. Reconnects if the core restarts.

import { contextBridge, ipcRenderer } from "electron";
import type { CoreEvent, Method, Params, Result } from "@cmd/protocol";
import { connect, type Connection } from "@cmd/protocol/node";
import type { ContextItem, MenuState } from "../shared/commands.ts";
import type { KeybindingsSnapshot } from "../main/keybindings.ts";

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
    for (;;) {
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
        await new Promise((r) => setTimeout(r, 500));
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
  focusWindow: () => ipcRenderer.send("focus"),
  openPath: (p: string) => ipcRenderer.send("open-path", p),
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
  sfSymbols: (req: { names: string[]; size: number; weight?: string; scale?: number }): Promise<Record<string, { url: string; w: number; h: number } | null>> =>
    ipcRenderer.invoke("sf-symbols", req),
  onKeybindings(fn: (s: KeybindingsSnapshot) => void): () => void {
    const h = (_e: unknown, s: KeybindingsSnapshot) => fn(s);
    ipcRenderer.on("keybindings", h);
    return () => ipcRenderer.off("keybindings", h);
  },
  /** Native sheet; resolves true when confirmed. */
  confirm: (o: { message: string; detail?: string; confirm: string }): Promise<boolean> => ipcRenderer.invoke("confirm", o),
  /** Native context menu; resolves with the chosen item id or null. */
  contextMenu: (items: ContextItem[]): Promise<string | null> => ipcRenderer.invoke("context-menu", items),
};

export type CmdBridge = typeof api;

contextBridge.exposeInMainWorld("cmd", api);
