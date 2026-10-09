// Motion helpers for the kit and the app (docs/37-motion.md): what comes and goes
// does so with a short fade, and what moves in a list glides there.
//
// - usePresence keeps an overlay rendered while it animates out ([data-closing]),
//   so sheets, popovers, menus and the palette fade rather than vanish.
// - useFlip makes rows that a render moved (inserted above, reordered, a row
//   above growing) glide from where they were to where they are, on the app's
//   one curve (--glide), and new rows fade in. Interrupted, a row turns from where
//   it is. Rows that nest move relative to their parent.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** How long overlays take to leave: --dur-fast. */
export const EXIT_MS = 120;

export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Rendered while `open` and for `ms` after it closes: `present` says whether to render,
 * `closing` whether it's on its way out (mark it [data-closing], make it inert).
 */
export function usePresence(open: boolean, ms = EXIT_MS): { present: boolean; closing: boolean } {
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  useEffect(() => {
    if (open || !present) return;
    const t = setTimeout(() => setPresent(false), reducedMotion() ? 0 : ms);
    return () => clearTimeout(t);
  }, [open, present, ms]);
  return { present: open || present, closing: !open && present };
}

/**
 * usePresence for something shown while a value is set (a palette's query, a picker):
 * the last value stays while it leaves.
 */
export function usePresentValue<T>(value: T, open: boolean, ms = EXIT_MS): { value: T | undefined; closing: boolean } {
  const last = useRef<T>(value);
  if (open) last.current = value;
  const { present, closing } = usePresence(open, ms);
  return { value: present ? last.current : undefined, closing };
}

let glideCurve: { easing: string; duration: number } | null = null;
/** The app's curve for moves, from the tokens (--glide, --glide-dur). */
export function glideTiming(): { easing: string; duration: number } {
  if (glideCurve) return glideCurve;
  const cs = getComputedStyle(document.documentElement);
  const easing = cs.getPropertyValue("--glide").trim() || "cubic-bezier(0.2, 0.8, 0.2, 1)";
  const duration = parseFloat(cs.getPropertyValue("--glide-dur")) || 380;
  return (glideCurve = { easing, duration });
}

interface FlipOptions {
  /** The rows: elements under the root to follow. */
  selector: string;
  /** A row's identity across renders. Default: its data-key. */
  keyOf?: (el: HTMLElement) => string | null | undefined;
  /** New rows (after the first render) fade in. Default true. */
  enter?: boolean;
}

/**
 * After every render, rows under `root` that moved glide from where they were. Positions
 * are kept relative to the root's content (so scrolling it isn't a move).
 */
export function useFlip(root: RefObject<HTMLElement | null>, { selector, keyOf = (el) => el.dataset.key, enter = true }: FlipOptions): void {
  const last = useRef<Map<string, { x: number; y: number }> | null>(null);
  useLayoutEffect(() => {
    const box = root.current;
    if (!box) return;
    const els = [...box.querySelectorAll<HTMLElement>(selector)];
    // Where each is shown now (a glide under way included), then where it's laid out.
    const shown = new Map<HTMLElement, { x: number; y: number }>();
    for (const el of els) {
      const running = el.getAnimations().filter((a) => a.id === "flip");
      if (!running.length) continue;
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform === "none" ? undefined : getComputedStyle(el).transform);
      shown.set(el, { x: m.m41, y: m.m42 });
      running.forEach((a) => a.cancel());
    }
    const b = box.getBoundingClientRect();
    const at = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - b.left + box.scrollLeft, y: r.top - b.top + box.scrollTop };
    };
    const next = new Map<string, { x: number; y: number }>();
    const moved = new Map<HTMLElement, { x: number; y: number }>();
    const prev = last.current;
    const animate = prev && !reducedMotion();
    const { easing, duration } = glideTiming();
    for (const el of els) {
      const key = keyOf(el);
      if (!key) continue;
      const now = at(el);
      next.set(key, now);
      if (!animate) continue;
      const was = prev.get(key);
      if (!was) {
        if (enter) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration * 0.6, easing, id: "flip-in" } as KeyframeAnimationOptions);
        continue;
      }
      const off = shown.get(el) ?? { x: 0, y: 0 };
      let dx = was.x + off.x - now.x;
      let dy = was.y + off.y - now.y;
      // Inside a row that moves too: only its own part of the move.
      const parent = el.parentElement?.closest<HTMLElement>(selector);
      const pm = parent && box.contains(parent) ? moved.get(parent) : undefined;
      if (pm) (dx -= pm.x), (dy -= pm.y);
      moved.set(el, { x: dx + (pm?.x ?? 0), y: dy + (pm?.y ?? 0) });
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration, easing, id: "flip" } as KeyframeAnimationOptions);
    }
    last.current = next;
  });
}
