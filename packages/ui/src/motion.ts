// How things move (docs/37-motion.md): the one place the curves and timings are
// defined, and the helpers built on them. CSS reads the same values as tokens
// (tokens.css; a test keeps the two equal).
//
// - MOTION: named timings. `glide` moves things (windows, sidebars, rows) on a
//   critically damped spring; `change` is a state change (a ring, a size);
//   `exit` is something leaving; `slow` is an indicator.
// - glide / glideNow / spring: the glide's curve, its clock and its maths, for
//   motion driven frame by frame (the app's TileMotion, tweens).
// - usePresence / usePresentValue keep what's leaving rendered while it plays its
//   exit ([data-closing]; how it enters and leaves is its [data-motion], components.css).
// - useFlip makes rows that a render moved glide from where they were.
// - slide moves an element in from or out to an edge on the glide.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

// ── the glide ──────────────────────────────────────────

/** Seconds for the spring to (nearly) get there. 0.26 s: quick, and calm at the end. */
const RESPONSE = 0.26;
const OMEGA = (2 * Math.PI) / RESPONSE;
/** ms until 99.9% of the way: CSS transitions on the same curve last this long (--glide-dur). */
export const GLIDE_MS = Math.round((9.23 / OMEGA) * 1000);

/** The spring's offset from its target and velocity, t seconds after (x0, v0). Critically damped: no bounce. */
export function spring(x0: number, v0: number, t: number): [number, number] {
  const e = Math.exp(-OMEGA * t);
  const b = v0 + OMEGA * x0;
  return [(x0 + b * t) * e, (v0 - OMEGA * b * t) * e];
}

/** How far along (0…1) a glide is after `ms`: for tweens (scrolling, the canvas camera). */
export const glide = (ms: number): number => (ms >= GLIDE_MS ? 1 : 1 - spring(1, 0, ms / 1000)[0]);

/** The glide as a CSS easing, sampled densely early where it moves fast: --glide. */
export const GLIDE_EASING = `linear(${Array.from({ length: 25 }, (_, i) => {
  const at = (i / 24) ** 1.6;
  return `${i === 24 ? 1 : +glide(at * GLIDE_MS).toFixed(4)} ${+(at * 100).toFixed(1)}%`;
}).join(", ")})`;

/** The longest step the glides' clock takes between two looks at it: a stalled frame pauses a glide rather than skipping it. */
const MAX_STEP_MS = 34;
let clock = 0;
let real = typeof performance === "undefined" ? 0 : performance.now();
/**
 * The clock every glide runs on (ms): real time, except that it never jumps more than
 * MAX_STEP_MS. Shared, so moves that make one change (a window growing and the strip
 * scrolling to show it) stay together through a stalled frame.
 */
export function glideNow(): number {
  const r = performance.now();
  clock += Math.min(MAX_STEP_MS, Math.max(0, r - real));
  real = r;
  return clock;
}

/**
 * Run `step(t)` every frame on the glide (t from 0 to 1, on the glides' clock) until it
 * gets there. `slot` holds the frame request: starting another in it, or cancelAnimationFrame
 * on it, stops this one.
 */
export function tween(slot: { current: number | null }, step: (t: number) => void): void {
  if (slot.current) cancelAnimationFrame(slot.current);
  const start = glideNow();
  const frame = () => {
    const t = glide(glideNow() - start);
    step(t);
    slot.current = t < 1 ? requestAnimationFrame(frame) : null;
  };
  slot.current = requestAnimationFrame(frame);
}

// ── named timings ──────────────────────────────────────

/** The kit's curves: --ease (in and settle) and --ease-exit (leave). */
export const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
export const EASE_EXIT = "cubic-bezier(0.4, 0, 1, 1)";

/** Every timing there is; tokens.css has each as --<name>-dur / easing (see the test). */
export const MOTION = {
  /** Something leaving: --dur-fast, --ease-exit. Entering pops take the same time. */
  exit: { ms: 120, easing: EASE_EXIT },
  /** A state changing (a ring, a colour, a size): --dur, --ease. */
  change: { ms: 150, easing: EASE },
  /** An indicator (a progress, a dot): --dur-slow, --ease. */
  slow: { ms: 240, easing: EASE },
  /** Something moving (windows, sidebars, rows, workspaces): --glide-dur, --glide. */
  glide: { ms: GLIDE_MS, easing: GLIDE_EASING },
} as const;

export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Web Animations options for a named timing (none with Reduce Motion). */
export const timing = (m: keyof typeof MOTION, more: KeyframeAnimationOptions = {}): KeyframeAnimationOptions => ({
  duration: reducedMotion() ? 0 : MOTION[m].ms,
  easing: MOTION[m].easing,
  ...more,
});

// ── coming and going ───────────────────────────────────

/**
 * Rendered while `open` and for `ms` after it closes: `present` says whether to render,
 * `closing` whether it's on its way out (mark it [data-closing], make it inert).
 */
export function usePresence(open: boolean, ms: number = MOTION.exit.ms): { present: boolean; closing: boolean } {
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
export function usePresentValue<T>(value: T, open: boolean, ms: number = MOTION.exit.ms): { value: T | undefined; closing: boolean } {
  const last = useRef<T>(value);
  if (open) last.current = value;
  const { present, closing } = usePresence(open, ms);
  return { value: present ? last.current : undefined, closing };
}

/**
 * Slide an element in from (or out to) `offset` (a CSS translate) on the glide; turning
 * back halfway reverses the slide under way. Out leaves it there (fill forwards).
 */
export function slide(el: HTMLElement, offset: string, dir: "in" | "out"): Animation | null {
  const running = el.getAnimations().find((a) => a.id === "slide" && a.playState === "running");
  if (running) {
    running.reverse();
    return running;
  }
  if (reducedMotion()) return null;
  const off = { transform: `translate(${offset})` };
  const on = { transform: "none" };
  return el.animate(dir === "in" ? [off, on] : [on, off], timing("glide", { id: "slide", fill: dir === "out" ? "forwards" : "none" }));
}

// ── rows that move ─────────────────────────────────────

interface FlipOptions {
  /** The rows: elements under the root to follow. */
  selector: string;
  /** A row's identity across renders. Default: its data-key. */
  keyOf?: (el: HTMLElement) => string | null | undefined;
  /** New rows (after the first render) fade in. Default true. */
  enter?: boolean;
}

/**
 * After every render, rows under `root` that moved (inserted above, reordered, a row
 * above growing) glide from where they were; new ones fade in. Interrupted, a row turns
 * from where it is; rows that nest move relative to their parent. Positions are kept
 * relative to the root's content, so scrolling it isn't a move.
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
      const t = getComputedStyle(el).transform;
      const m = new DOMMatrixReadOnly(t === "none" ? undefined : t);
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
    for (const el of els) {
      const key = keyOf(el);
      if (!key) continue;
      const now = at(el);
      next.set(key, now);
      if (!animate) continue;
      const was = prev.get(key);
      if (!was) {
        if (enter) el.animate([{ opacity: 0 }, { opacity: 1 }], timing("change", { id: "flip-in" }));
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
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], timing("glide", { id: "flip" }));
    }
    last.current = next;
  });
}
