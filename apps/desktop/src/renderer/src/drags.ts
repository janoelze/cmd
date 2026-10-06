// Dragging files out of cmd's UI (docs/22-drag-and-drop.md): a file browser's
// rows, a window's title icon. The page's own drag is cancelled and a native
// macOS drag of the files takes its place (main process, startDrag), so wherever
// it goes (Finder, Mail, another app, a page's upload field, or one of cmd's own
// windows through drops.ts) it is a drag of real files. Links drag as the
// page's own drag of a URL, which every app understands already.

import { cmd } from "./bridge.ts";

/** Call from a `dragstart` handler on an element with `draggable`. */
export function dragFiles(e: { preventDefault(): void; stopPropagation(): void }, paths: string[]): void {
  e.preventDefault();
  e.stopPropagation();
  if (paths.length) cmd.startFileDrag(paths);
}

/** Call from a `dragstart` handler: drag a link (a browser window's page). */
export function dragLink(e: React.DragEvent, url: string): void {
  e.stopPropagation();
  e.dataTransfer.setData("text/uri-list", url);
  e.dataTransfer.setData("text/plain", url);
  e.dataTransfer.effectAllowed = "copyLink";
}
