// A browser window's page's right-click menu (Electron shows none of its own): back, forward
// and reload, a link's and a selection's items, and Inspect Element (docs/59, main/inspector.ts).
// A page that draws its own menu (preventDefault on contextmenu) never gets here.

import { BrowserWindow, clipboard, ipcMain, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from "electron";
import { inspectElement } from "./inspector.ts";

/**
 * Where the person last right-clicked in each page, in its CSS pixels (preload/guest.ts).
 * ContextMenuParams' x and y aren't reliably that: for a <webview>, Chromium sometimes gives
 * them in the app window's coordinates (on a busy machine, most of the time), and Inspect
 * Element then revealed whatever was there instead, usually <body>.
 */
const points = new WeakMap<WebContents, { x: number; y: number }>();

export function trackContextPoints(): void {
  ipcMain.on("page-context-point", (e, x: unknown, y: unknown) => {
    if (e.sender.getType() === "webview" && Number.isFinite(x) && Number.isFinite(y)) points.set(e.sender, { x: x as number, y: y as number });
  });
}

/** `at`: the point in the page (by default the params', for a frame the preload doesn't run in). */
export function pageMenuItems(page: WebContents, p: ContextMenuParams, at = { x: p.x, y: p.y }): MenuItemConstructorOptions[] {
  const nav = page.navigationHistory;
  const link = /^https?:/i.test(p.linkURL) ? p.linkURL : "";
  const groups: MenuItemConstructorOptions[][] = [
    link
      ? [
          { label: "Open Link in New Window", click: () => page.hostWebContents?.send("open-url", link) },
          { label: "Copy Link", click: () => clipboard.writeText(link) },
        ]
      : [],
    p.isEditable
      ? [
          { label: "Cut", enabled: p.editFlags.canCut, click: () => page.cut() },
          { label: "Copy", enabled: p.editFlags.canCopy, click: () => page.copy() },
          { label: "Paste", enabled: p.editFlags.canPaste, click: () => page.paste() },
          { label: "Select All", enabled: p.editFlags.canSelectAll, click: () => page.selectAll() },
        ]
      : p.selectionText.trim()
        ? [{ label: "Copy", click: () => page.copy() }]
        : [],
    link || p.isEditable || p.selectionText.trim()
      ? []
      : [
          { label: "Back", enabled: nav.canGoBack(), click: () => nav.goBack() },
          { label: "Forward", enabled: nav.canGoForward(), click: () => nav.goForward() },
          { label: "Reload Page", click: () => page.reload() },
        ],
    [{ label: "Inspect Element", click: () => inspectElement(page, at.x, at.y) }],
  ];
  return groups.filter((g) => g.length).flatMap((g, i) => (i ? [{ type: "separator" as const }, ...g] : g));
}

/** Show it over the app window the page is in. */
export function showPageMenu(page: WebContents, p: ContextMenuParams): void {
  const host = page.hostWebContents;
  const window = host ? BrowserWindow.fromWebContents(host) : null;
  // The preload runs in the page's main frame only: in an iframe, the params' point.
  const at = p.frame && p.frame !== page.mainFrame ? undefined : points.get(page);
  points.delete(page);
  Menu.buildFromTemplate(pageMenuItems(page, p, at)).popup(window ? { window } : {});
}
