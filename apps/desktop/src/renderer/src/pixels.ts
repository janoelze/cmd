// Keeping things on whole pixels, so icons after text stay crisp (SF Symbols are
// bitmaps drawn 1:1: at a fractional x they're resampled and go soft).

import { useLayoutEffect, type RefObject } from "react";

/**
 * Rounds an element's width up to a whole pixel after every render, so what follows
 * it in a row (a chevron, a badge) lands on a whole pixel. For text of any width.
 */
export function useWholePixelWidth(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.width = "";
    el.style.width = `${Math.ceil(el.getBoundingClientRect().width)}px`;
  });
}
