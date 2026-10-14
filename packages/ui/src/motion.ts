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
 * on it, stops this one. With Reduce Motion it gets there in the next frame.
 */
export function tween(slot: { current: number | null }, step: (t: number) => void): void {
  if (slot.current) cancelAnimationFrame(slot.current);
  if (reducedMotion()) {
    slot.current = requestAnimationFrame(() => ((slot.current = null), step(1)));
    return;
  }
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
  /** Rows that a render removed fade out where they were (a copy over the root, which must be positioned), while the rows below glide up. Default false. */
  leave?: boolean;
}

/** Where a row is shown, relative to the root, in the root's own px. */
interface Shown {
  el: HTMLElement;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A row's glide under way: its spring's start, for the speed it has when a render turns it. */
interface Flight {
  x0: number;
  y0: number;
  vx: number;
  vy: number;
  start: number;
  anim: Animation;
}

/** Every row of `root`, where it's on screen now (a glide under way, a parent's too, included). */
function shownRows(box: HTMLElement, selector: string, keyOf: (el: HTMLElement) => string | null | undefined): Map<string, Shown> {
  const b = box.getBoundingClientRect();
  // Screen px per px of the root (a window scaled while it glides).
  const k = b.width / (box.offsetWidth || b.width || 1) || 1;
  const out = new Map<string, Shown>();
  for (const el of box.querySelectorAll<HTMLElement>(selector)) {
    if (el.dataset.ghost !== undefined) continue;
    const key = keyOf(el);
    if (!key) continue;
    const r = el.getBoundingClientRect();
    out.set(key, { el, x: (r.left - b.left) / k + box.scrollLeft, y: (r.top - b.top) / k + box.scrollTop, w: r.width / k, h: r.height / k });
  }
  return out;
}

/** A glide from (x0, y0) px away to where it is, starting at (vx, vy) px/s: the glide's spring, sampled. */
function glideFrames(x0: number, y0: number, vx: number, vy: number): Keyframe[] {
  const frames: Keyframe[] = [];
  for (let i = 0; i < 24; i++) {
    const at = (i / 24) ** 1.6;
    const t = (at * GLIDE_MS) / 1000;
    frames.push({ offset: at, transform: `translate(${spring(x0, vx, t)[0]}px, ${spring(y0, vy, t)[0]}px)` });
  }
  frames.push({ offset: 1, transform: "none" });
  return frames;
}

/**
 * Rows under `root` that a render moved (inserted above, reordered, a row above growing)
 * glide from where they were shown; new ones fade in, and with `leave` gone ones fade out
 * where they were. A row whose height changed grows or shrinks on the glide, its content
 * with it. Where rows were is read as the render runs, before React changes the page, so
 * it's what was on screen: a glide under way, a parent's, or a section folding by layout.
 * Turned by another render, a row carries on from where it is at the speed it had. Rows
 * that nest move relative to their parent.
 */
export function useFlip(root: RefObject<HTMLElement | null>, { selector, keyOf = (el) => el.dataset.key, enter = true, leave = false }: FlipOptions): void {
  const flights = useRef(new Map<HTMLElement, Flight>());
  /** Rows growing or shrinking: from and to which height. */
  const sizes = useRef(new WeakMap<HTMLElement, { from: number; to: number }>());
  const watch = useRef<Watch | null>(null);
  // Render: the page is still the last commit's. Measuring it forces a layout, so where rows
  // were last time serves while nothing under the root changed and nothing glides.
  const box0 = root.current;
  const w0 = watch.current;
  if (w0?.mo.takeRecords().length) w0.rows = null; // changed since: a render run twice must not trust it either
  const cached = box0 && w0?.box === box0 && !flights.current.size ? w0.rows : null;
  const before = box0 ? (cached ?? shownRows(box0, selector, keyOf)) : null;
  useLayoutEffect(() => {
    const box = root.current;
    if (!box || !before) return;
    let w = watch.current;
    let changed = true; // the first commit watched: it may have changed anything
    if (w?.box === box) changed = w.mo.takeRecords().length > 0;
    else {
      w?.mo.disconnect();
      w?.ro.disconnect();
      const fresh: Watch = { box, rows: null, mo: new MutationObserver(() => {}), ro: new ResizeObserver(() => (fresh.rows = null)) };
      fresh.mo.observe(box, { subtree: true, childList: true, attributes: true, characterData: true });
      fresh.ro.observe(box);
      watch.current = w = fresh;
    }
    // Nothing under the root changed in this commit: no row moved (glides under way go on).
    if (!changed) {
      if (!flights.current.size) w.rows = before;
      return;
    }
    w.rows = null;
    const animate = !reducedMotion();
    const now = performance.now();
    // Glides under way stop where they are (that's in `before`); their speed carries on.
    const speed = new Map<HTMLElement, [number, number]>();
    for (const [el, f] of flights.current) {
      const t = (now - f.start) / 1000;
      speed.set(el, [spring(f.x0, f.vx, t)[1], spring(f.y0, f.vy, t)[1]]);
      f.anim.cancel();
    }
    flights.current.clear();
    const els = [...box.querySelectorAll<HTMLElement>(selector)].filter((el) => el.dataset.ghost === undefined);
    // A row whose height changed (a second line) grows from its height on screen: by layout,
    // so what's below follows it on the same curve. Rows only: a section's height is theirs.
    for (const el of els) {
      const was = before.get(keyOf(el) ?? "");
      if (!was || was.el !== el) continue;
      const growing = el.getAnimations().find((a) => a.id === "flip-size");
      const at = growing?.currentTime;
      growing?.cancel();
      const h = el.offsetHeight;
      if (!animate || el.querySelector(selector)) continue;
      // Still growing to the same height (another render): it goes on.
      const last = growing && sizes.current.get(el);
      const resume = last && last.to === h ? last : null;
      if (!resume && Math.abs(was.h - h) < 0.5) continue;
      const from = resume ? resume.from : was.h;
      el.style.overflow = "clip";
      const grow = el.animate([{ height: `${from}px` }, { height: `${h}px` }], timing("glide", { id: "flip-size" }));
      if (resume) grow.currentTime = at ?? 0;
      sizes.current.set(el, { from, to: h });
      grow.finished.then(() => (el.style.overflow = ""), () => {});
    }
    // Where each is laid out now (the heights above at their start).
    const after = shownRows(box, selector, keyOf);
    const delta = new Map<HTMLElement, [number, number]>();
    for (const el of els) {
      const key = keyOf(el);
      const laid = key ? after.get(key) : undefined;
      if (!key || !laid) continue;
      const was = before.get(key);
      if (!was) {
        if (enter && animate) el.animate([{ opacity: 0 }, { opacity: 1 }], timing("change", { id: "flip-in" }));
        continue;
      }
      let dx = was.x - laid.x;
      let dy = was.y - laid.y;
      delta.set(el, [dx, dy]);
      // Inside a row that moves too: only its own part of the move.
      const parent = el.parentElement?.closest<HTMLElement>(selector);
      const pd = parent && box.contains(parent) ? delta.get(parent) : undefined;
      if (pd) (dx -= pd[0]), (dy -= pd[1]);
      const [vx, vy] = speed.get(el) ?? [0, 0];
      if (!animate || (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(vx) < 1 && Math.abs(vy) < 1)) continue;
      const anim = el.animate(glideFrames(dx, dy, vx, vy), { duration: GLIDE_MS, easing: "linear", id: "flip" });
      const f = { x0: dx, y0: dy, vx, vy, start: now, anim };
      flights.current.set(el, f);
      anim.finished.then(() => flights.current.get(el) === f && flights.current.delete(el), () => {});
    }
    // Where rows are now serves the next render, unless something moves or grows (it's measured again then).
    const still = !flights.current.size && !els.some((el) => el.getAnimations().length);
    if (!leave || !animate || ![...before.keys()].some((key) => !after.has(key))) {
      if (still) w.rows = after;
      w.mo.takeRecords(); // this effect's own style writes
      return;
    }
    // What React removed is detached but whole: put it back over the root where it was shown, and fade it out.
    for (const [key, was] of before) {
      const el = was.el;
      if (after.has(key) || el.isConnected || el.closest("[data-closing]")) continue;
      // Inside a row that's leaving too: that one's ghost carries it.
      const parent = el.parentElement?.closest<HTMLElement>(selector);
      if (parent && before.has(keyOf(parent) ?? "") && !after.has(keyOf(parent) ?? "")) continue;
      for (const a of el.getAnimations()) a.cancel();
      el.dataset.ghost = "";
      el.setAttribute("aria-hidden", "true");
      Object.assign(el.style, { position: "absolute", left: `${was.x}px`, top: `${was.y}px`, width: `${was.w}px`, height: `${was.h}px`, margin: "0", pointerEvents: "none", transform: "" });
      box.append(el);
      el.animate([{ opacity: 1 }, { opacity: 0 }], timing("exit", { id: "flip-out", fill: "forwards" })).finished.then(() => el.remove(), () => el.remove());
    }
  });
  useEffect(
    () => () => {
      watch.current?.mo.disconnect();
      watch.current?.ro.disconnect();
      watch.current = null;
    },
    [],
  );
}

/** What useFlip watches under its root, and where its rows were when last measured (null: measure again). */
interface Watch {
  box: HTMLElement;
  rows: Map<string, Shown> | null;
  mo: MutationObserver;
  ro: ResizeObserver;
}
