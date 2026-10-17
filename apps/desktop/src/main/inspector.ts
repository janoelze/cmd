// Browser windows' inspectors (docs/59): Chromium's DevTools front end, the one inside Electron,
// runs in a <webview> (an Inspector window, or beside the page in its browser window) and talks
// CDP over a WebSocket that this file relays to the page's webContents.debugger. A <webview> can't
// host DevTools itself (setDevToolsWebContents never connects one), and a native view would sit
// over the board. The renderer reports which guest shows each browser window's page (a new one
// when the webview is re-attached: docking, a workspace move); an inspector's address stays the
// same for its window, so reloading it reconnects to whichever guest shows the page then.
// Inspect Element (a page's right-click menu, main/page-menu.ts) opens the inspector if need be
// and reveals the node under the pointer, as DevTools' own picker does (Overlay.inspectNodeRequested).

import { BrowserWindow, ipcMain, session, webContents, type WebContents } from "electron";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { logger } from "@cmd/protocol/node";
import { BROWSER_PARTITION } from "./web-policy.ts";

const log = logger("inspector");

/** A browser window (by its cmd window id): the guest showing its page, its inspector's token, the inspector connected. */
interface Page {
  guest: number | null;
  token: string;
  socket: WebSocket | null;
  /** The inspector has the page's document (it asked for it): a node can be revealed. */
  ready: boolean;
  /** Inspect Element's point, until the inspector is ready to reveal it. */
  reveal: { x: number; y: number } | null;
}

const pages = new Map<string, Page>();
let server: Promise<WebSocketServer> | null = null;

const pageOf = (windowId: string): Page => {
  let p = pages.get(windowId);
  if (!p) pages.set(windowId, (p = { guest: null, token: randomBytes(16).toString("hex"), socket: null, ready: false, reveal: null }));
  return p;
};

/** Loopback only, and only DevTools' own pages may connect; the token in the path picks the page. */
function listen(): Promise<WebSocketServer> {
  server ??= new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 256 * 1024 * 1024, verifyClient: ({ origin }: { origin: string }) => origin === "devtools://devtools" });
    wss.once("listening", () => resolve(wss));
    wss.once("error", (err) => ((server = null), reject(err)));
    wss.on("connection", (sock, req) => connect(sock, req.url ?? ""));
  });
  return server;
}

function connect(sock: WebSocket, path: string): void {
  const page = [...pages.values()].find((p) => `/${p.token}` === path);
  const guest = page?.guest != null ? webContents.fromId(page.guest) : undefined;
  if (!page || !guest || guest.isDestroyed()) return void sock.close(4404, "no page");
  // One inspector per page: a newer one (a reload) takes over.
  const before = page.socket;
  page.socket = sock;
  page.ready = false;
  before?.close(1000, "replaced");
  const dbg = guest.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach("1.3");
  } catch (err) {
    log.warn(`couldn't attach to the page: ${(err as Error).message}`);
    return void sock.close(4409, "busy");
  }
  const send = (m: unknown) => sock.readyState === sock.OPEN && sock.send(JSON.stringify(m));
  const event = (_e: unknown, method: string, params: unknown, sessionId?: string) => send(sessionId ? { method, params, sessionId } : { method, params });
  const detached = () => sock.close(1000, "detached");
  dbg.on("message", event);
  dbg.on("detach", detached);
  sock.on("message", async (data) => {
    let m: { id?: number; method?: string; params?: object; sessionId?: string };
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof m.id !== "number" || typeof m.method !== "string") return;
    const s = m.sessionId ? { sessionId: m.sessionId } : {};
    try {
      send({ id: m.id, result: await dbg.sendCommand(m.method, m.params ?? {}, m.sessionId), ...s });
      if (m.method === "DOM.getDocument" && !m.sessionId && page.socket === sock) {
        page.ready = true;
        void revealPending(page);
      }
    } catch (err) {
      send({ id: m.id, error: { code: -32000, message: (err as Error).message }, ...s });
    }
  });
  sock.on("close", () => {
    dbg.off("message", event);
    dbg.off("detach", detached);
    if (page.socket !== sock) return; // replaced: the newer one keeps the attachment
    page.socket = null;
    page.ready = false;
    if (!guest.isDestroyed() && dbg.isAttached()) dbg.detach();
  });
}

/** Inspect Element's node: the inspector reveals it in Elements, as when its picker chose it. */
async function revealPending(page: Page): Promise<void> {
  const at = page.reveal;
  const guest = page.guest != null ? webContents.fromId(page.guest) : undefined;
  if (!at || !page.ready || !page.socket || !guest || guest.isDestroyed()) return;
  page.reveal = null;
  try {
    const { backendNodeId } = await guest.debugger.sendCommand("DOM.getNodeForLocation", { x: Math.round(at.x), y: Math.round(at.y) });
    page.socket?.send(JSON.stringify({ method: "Overlay.inspectNodeRequested", params: { backendNodeId } }));
  } catch (err) {
    log.debug(`nothing to reveal at ${at.x},${at.y}: ${(err as Error).message}`);
  }
}

/**
 * Inspect Element at a point of a page (in its CSS pixels): its app window opens or shows the
 * page's inspector (inspect-element), which reveals the node once it has the page's document.
 */
export function inspectElement(guest: WebContents, x: number, y: number): void {
  const entry = [...pages].find(([, p]) => p.guest === guest.id);
  if (!entry || !guest.hostWebContents) return;
  const [windowId, page] = entry;
  page.reveal = { x, y };
  guest.hostWebContents.send("inspect-element", windowId);
  void revealPending(page);
}

/** Whether a guest shows a browser window's page (not the YouTube widget's player, also a webview of the browser session). */
export const isBrowserPage = (guest: WebContents): boolean => [...pages.values()].some((p) => p.guest === guest.id);

/** A guest that shows a browser window's page: a webview of this app window, in the browser session. */
function isPageGuest(id: number, host: WebContents): boolean {
  const wc = webContents.fromId(id);
  return !!wc && wc.getType() === "webview" && wc.hostWebContents === host && wc.session === session.fromPartition(BROWSER_PARTITION);
}

export function handleInspectors(appWindows: () => BrowserWindow[]): void {
  /** A browser window's page moved to another guest: its inspector, wherever it is, reconnects. */
  const retarget = (windowId: string) => {
    for (const w of appWindows()) if (!w.isDestroyed() && w.webContents.session === session.defaultSession) w.webContents.send("inspector-target", windowId);
  };

  ipcMain.on("inspector-guest", (e, windowId: unknown, guestId: unknown) => {
    if (typeof windowId !== "string" || (guestId !== null && typeof guestId !== "number")) return;
    if (guestId !== null && !isPageGuest(guestId, e.sender)) return;
    const page = pageOf(windowId);
    if (page.guest === guestId) return;
    page.guest = guestId;
    page.socket?.close(1000, "moved");
    if (guestId !== null) {
      webContents.fromId(guestId)?.once("destroyed", () => {
        if (page.guest !== guestId) return;
        page.guest = null;
        page.socket?.close(1000, "gone");
      });
      retarget(windowId);
    }
  });

  ipcMain.handle("inspector-url", async (_e, windowId: unknown) => {
    if (typeof windowId !== "string") throw new Error("no such window");
    const { port } = (await listen()).address() as AddressInfo;
    return `devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:${port}/${pageOf(windowId).token}`;
  });
}
