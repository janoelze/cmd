// How window content shares the pointer and the wheel with the windows view
// (click to select, strip scrolling, canvas pan and zoom, drags). See
// docs/09-window-types.md → Input.
//
// - DOM content (terminals, files, text…): nothing to do. Sideways scrolling
//   goes to the content where it can scroll that way, else to the strip
//   (shared/embed-input.ts).
// - Embedded pages (<webview>, <iframe>) run in their own process: their input
//   never reaches this page. Mark the element with `data-embed`: the windows
//   view turns its pointer events off during drags, pans and resizes and on
//   unselected canvas windows. The page reports presses and the sideways
//   scrolls it doesn't use (browser pages through their preload,
//   preload/guest.ts, and the webview's ipc-message event; Magic widgets by
//   postMessage from their runtime), and the view hands each report to
//   handleEmbedMessage.

export { scrollsSideways, sidewaysForApp } from "../../shared/embed-input.ts";

export const EMBED_ATTR = "data-embed";

/** A wheel event reported by an embedded page; x/y are in the page's coordinates. */
interface WheelReport {
  type: "wheel";
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  x: number;
  y: number;
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Replay what an embedded page reports on its element, so the windows view
 * handles it as if it had happened over the window itself:
 *  - `press`: a mousedown, so the window is selected like any other;
 *  - `wheel`: the wheel event, so the strip scrolls.
 * Returns whether the message was one of these.
 */
export function handleEmbedMessage(el: HTMLElement, m: unknown): boolean {
  if (!m || typeof m !== "object") return false;
  const type = (m as { type?: unknown }).type;
  if (type === "press") {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    return true;
  }
  if (type === "wheel") {
    const w = m as WheelReport;
    const r = el.getBoundingClientRect();
    const scale = el.offsetWidth ? r.width / el.offsetWidth : 1; // canvas zoom
    el.dispatchEvent(
      new WheelEvent("wheel", {
        deltaX: n(w.deltaX),
        deltaY: n(w.deltaY),
        deltaMode: n(w.deltaMode),
        shiftKey: !!w.shiftKey,
        ctrlKey: !!w.ctrlKey,
        metaKey: !!w.metaKey,
        altKey: !!w.altKey,
        clientX: r.left + n(w.x) * scale,
        clientY: r.top + n(w.y) * scale,
        bubbles: true,
        cancelable: true,
      }),
    );
    return true;
  }
  return false;
}
