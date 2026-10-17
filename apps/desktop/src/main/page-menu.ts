// A browser window's page's right-click menu (Electron shows none of its own): back, forward
// and reload, a link's and a selection's items, and Inspect Element (docs/59, main/inspector.ts).
// A page that draws its own menu (preventDefault on contextmenu) never gets here.

import { BrowserWindow, clipboard, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from "electron";
import { inspectElement } from "./inspector.ts";

export function pageMenuItems(page: WebContents, p: ContextMenuParams): MenuItemConstructorOptions[] {
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
    [{ label: "Inspect Element", click: () => inspectElement(page, p.x, p.y) }],
  ];
  return groups.filter((g) => g.length).flatMap((g, i) => (i ? [{ type: "separator" as const }, ...g] : g));
}

/** Show it over the app window the page is in. */
export function showPageMenu(page: WebContents, p: ContextMenuParams): void {
  const host = page.hostWebContents;
  const window = host ? BrowserWindow.fromWebContents(host) : null;
  Menu.buildFromTemplate(pageMenuItems(page, p)).popup(window ? { window } : {});
}
