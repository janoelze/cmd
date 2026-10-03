// How window content shares the pointer and the wheel with the windows view
// (strip scrolling, canvas pan/zoom, drags, click-to-select). See
// docs/09-window-types.md → Input.
//
// - DOM content (terminals, files, text…): nothing to do. Sideways scrolling
//   goes to the content where it can scroll that way, else to the strip.
// - Embedded pages (<webview>, <iframe>) swallow pointer and wheel events and
//   never let them reach this page. Mark the element with `data-embed`: the
//   windows view then turns its pointer events off during drags, pans and
//   resizes and on unselected canvas windows, and selects the window when the
//   page takes focus or reports a press (pressing in one embedded page after
//   another moves no focus out of this page, so focus alone isn't enough).
//   For the wheel, the page hands sideways scrolls over (postMessage for iframes, see core's magic/prompt/host.js; injected
//   for webviews, see WEBVIEW_WHEEL_FORWARDER) and the view calls replayWheel.

export const EMBED_ATTR = "data-embed";

/** Is `el` (or an ancestor up to `stop`) a scroller that can still scroll sideways by dx? */
export function canScrollX(el: Element | null, dx: number, stop?: Element | null): boolean {
  for (let n = el; n && n !== stop && n !== document.documentElement; n = n.parentElement) {
    if (n.hasAttribute(EMBED_ATTR)) return false;
    const ox = getComputedStyle(n).overflowX;
    if ((ox === "auto" || ox === "scroll") && n.scrollWidth > n.clientWidth) {
      if (dx < 0 ? n.scrollLeft > 0 : n.scrollLeft + n.clientWidth < n.scrollWidth - 1) return true;
    }
  }
  return false;
}

/** A wheel event handed over by an embedded page; x/y are in the page's coordinates. */
export interface WheelMessage {
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

export function isWheelMessage(m: unknown): m is WheelMessage {
  return !!m && typeof m === "object" && (m as { type?: unknown }).type === "wheel";
}

/** A press inside an embedded page. */
export interface PressMessage {
  type: "press";
}

/**
 * Handle what an embedded page reports: a sideways wheel (replayed for the
 * strip) or a press (replayed as a mousedown, so the window is selected like
 * any other). Returns whether the message was one of these.
 */
export function handleEmbedMessage(el: HTMLElement, m: unknown): boolean {
  if (isWheelMessage(m)) {
    replayWheel(el, m);
    return true;
  }
  if (m && typeof m === "object" && (m as { type?: unknown }).type === "press") {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    return true;
  }
  return false;
}

/**
 * Replay a handed-over wheel event on the embedding element, so the windows
 * view's handlers see it as if it had happened over the window itself.
 */
export function replayWheel(el: HTMLElement, m: WheelMessage): void {
  const r = el.getBoundingClientRect();
  const scale = el.offsetWidth ? r.width / el.offsetWidth : 1; // canvas zoom
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  el.dispatchEvent(
    new WheelEvent("wheel", {
      deltaX: n(m.deltaX),
      deltaY: n(m.deltaY),
      deltaMode: n(m.deltaMode),
      shiftKey: !!m.shiftKey,
      ctrlKey: !!m.ctrlKey,
      metaKey: !!m.metaKey,
      altKey: !!m.altKey,
      clientX: r.left + n(m.x) * scale,
      clientY: r.top + n(m.y) * scale,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** Marks console messages from the webview forwarder (BrowserView listens for them). */
export const EMBED_MARK = "\u0000cmd-embed:";

/**
 * Injected into browser pages (they get no preload): reports presses, and
 * hands sideways scrolls over unless the page itself scrolls sideways there. It talks back
 * through the console, the one channel a preload-less guest has; a page that
 * imitates it can only scroll the strip.
 */
export const WEBVIEW_WHEEL_FORWARDER = `(() => {
  if (window.__cmdWheel) return;
  window.__cmdWheel = true;
  const scrollsX = (el, dx) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const ox = getComputedStyle(n).overflowX;
      const root = n === document.scrollingElement || n === document.documentElement || n === document.body;
      if ((root ? ox !== "hidden" && ox !== "clip" : ox === "auto" || ox === "scroll") && n.scrollWidth > n.clientWidth) {
        if (dx < 0 ? n.scrollLeft > 0 : n.scrollLeft + n.clientWidth < n.scrollWidth - 1) return true;
      }
    }
    return false;
  };
  window.addEventListener("pointerdown", (e) => {
    if (e.button === 0) console.debug(${JSON.stringify(EMBED_MARK)} + '{"type":"press"}');
  }, { capture: true, passive: true });
  window.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) return;
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    const sideways = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (!sideways || !dx || scrollsX(e.target, dx)) return;
    e.preventDefault();
    console.debug(${JSON.stringify(EMBED_MARK)} + JSON.stringify({ type: "wheel", deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, x: e.clientX, y: e.clientY }));
  }, { passive: false, capture: true });
})();`;
