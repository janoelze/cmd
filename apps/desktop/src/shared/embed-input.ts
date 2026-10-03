// The one rule for sideways scrolling, shared by the app's page (renderer
// embed.ts, WindowsView) and browser pages (preload/guest.ts). Magic widgets'
// runtime (core's magic/prompt/host.js) carries a copy, since it can't import.
// See docs/09-window-types.md → Input.

/**
 * The sideways amount of a wheel event that belongs to cmd (the strip), or 0
 * when it doesn't: a vertical scroll, a pinch or ⌘-scroll, or content under
 * the pointer that can still scroll sideways that way itself.
 */
export function sidewaysForApp(e: WheelEvent, stop?: Element | null): number {
  if (e.ctrlKey || e.metaKey) return 0;
  const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
  if (!dx || (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX))) return 0;
  return scrollsSideways(e.target as Element | null, dx, stop) ? 0 : dx;
}

/** Can `el` or an ancestor (up to `stop`) still scroll sideways by dx? */
export function scrollsSideways(el: Element | null, dx: number, stop?: Element | null): boolean {
  for (let n = el; n && n !== stop && n.nodeType === 1; n = n.parentElement) {
    if (n.hasAttribute("data-embed")) return false;
    const ox = getComputedStyle(n).overflowX;
    // The page's own scroller scrolls unless clipped; other elements only with auto/scroll.
    const root = n === document.scrollingElement || n === document.documentElement || n === document.body;
    const scroller = root ? ox !== "hidden" && ox !== "clip" : ox === "auto" || ox === "scroll";
    if (scroller && n.scrollWidth > n.clientWidth) {
      if (dx < 0 ? n.scrollLeft > 0 : n.scrollLeft + n.clientWidth < n.scrollWidth - 1) return true;
    }
  }
  return false;
}
