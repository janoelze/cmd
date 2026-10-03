// How window content shares the pointer and the wheel with the windows view
// (click to select, strip scrolling, canvas pan and zoom, drags). See
// docs/09-window-types.md → Input.
//
// - DOM content (terminals, files, text…): nothing to do. Sideways scrolling
//   goes to the content where it can scroll that way, else to the strip
//   (Chromium's native scroll chaining; see WindowsView).
// - Embedded pages (<webview>, <iframe>) run in their own process: their input
//   never reaches this page. Mark the element with `data-embed`: the windows
//   view turns its pointer events off during drags, pans and resizes and on
//   unselected canvas windows. The page reports presses (browser pages through
//   their preload, preload/guest.ts, and the webview's ipc-message event; Magic
//   widgets by postMessage from their runtime), and the view hands each report
//   to handleEmbedMessage. Sideways scrolls need no report: Chromium bubbles
//   what the page doesn't use into the strip's native scroller.

export const EMBED_ATTR = "data-embed";

/**
 * Replay a press reported by an embedded page as a mousedown on its element,
 * so the window is selected like any other. Returns whether it was one.
 */
export function handleEmbedMessage(el: HTMLElement, m: unknown): boolean {
  if (!m || typeof m !== "object" || (m as { type?: unknown }).type !== "press") return false;
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  return true;
}
