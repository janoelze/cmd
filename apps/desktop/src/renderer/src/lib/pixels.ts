// Keeping things on whole pixels, so icons after text stay crisp (SF Symbols are
// bitmaps drawn 1:1: at a fractional x they're resampled and go soft).

import { useLayoutEffect, type RefObject } from "react";

/**
 * Rounds an element's width up to a whole pixel when its text changes (and once the
 * fonts have loaded), so what follows it in a row (a chevron, a badge) lands on a
 * whole pixel. For text of any width. Not on every render: measuring forces a layout
 * of the whole window, which costs most when something else just added many rows.
 */
export function useWholePixelWidth(ref: RefObject<HTMLElement | null>, text: string): void {
  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      el.style.width = "";
      el.style.width = `${Math.ceil(el.getBoundingClientRect().width)}px`;
    };
    measure();
    let live = true;
    void document.fonts.ready.then(() => live && measure());
    return () => {
      live = false;
    };
  }, [ref, text]);
}
