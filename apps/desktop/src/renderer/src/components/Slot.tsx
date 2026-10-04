// Animated title-bar pieces (docs/10-window-titles.md, "Motion"). A Slot is one
// field that stays mounted when empty (width 0), so a value never pops in or out:
//  - a new key swaps: the old value scales down and fades out, then the new one
//    scales up and fades in, and the slot's width eases between them;
//  - the same key updates in place, so counters ("3m ago", usage) don't animate;
//  - a value stays at least DWELL ms (changes in between coalesce), a transient
//    one (loading) appears only if it lasts DELAY ms, and an emptied slot waits
//    GRACE ms before collapsing, so a value that's replaced (⌘E remounting a
//    window's view) swaps once instead of going out and coming back in.
// Mark is the window's status light or type icon, cross-fading between them.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Led } from "../model.ts";
import { ICON, Symbol } from "./Symbol.tsx";
import { countRender } from "../perf.ts";

const DWELL = 600;
const DELAY = 200;
const GRACE = 250;
/** The width transition (styles.css, .slot) plus a frame. */
const MOVE_MS = 200;
/** Narrower than this and narrower than its value, a divided slot hides (just a gap and "…" otherwise). */
const SLIVER = 28;

/** False where changes should be instant: windows off screen, a canvas zoomed out too far to read. */
export const SlotMotion = createContext(true);

export interface SlotValue {
  text: string;
  /** Which state this is; defaults to the text. */
  key?: string;
  transient?: boolean;
}

const keyOf = (v: SlotValue | undefined) => (v ? (v.key ?? v.text) : null);

/** `v`, but held for DWELL ms per state and delayed while transient. */
function useSettled(v: SlotValue | undefined, animate: boolean): SlotValue | undefined {
  const [shown, setShown] = useState(() => (v?.transient ? undefined : v));
  const since = useRef(0);
  const shownKey = keyOf(shown);
  const key = keyOf(v);
  useEffect(() => {
    if (key === shownKey) {
      if (v?.text !== shown?.text) setShown(v); // same state, new text: in place
      return;
    }
    const show = () => {
      since.current = performance.now();
      setShown(v);
    };
    const hold = v?.transient ? DELAY : !v && shown ? GRACE : 0;
    const wait = animate ? Math.max(since.current + DWELL - performance.now(), hold) : hold;
    if (wait <= 0) return show();
    const t = setTimeout(show, wait);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, v?.text, shownKey, shown?.text]);
  return shown;
}

/**
 * The value's untruncated width in CSS px. scrollWidth is layout px (not scaled by
 * the canvas zoom) but rounded to an integer; 1px more keeps a fraction from
 * ellipsizing the last characters.
 */
const naturalWidth = (el: HTMLElement) => el.scrollWidth + 1;

export function Slot({
  value,
  fallback,
  className = "",
  fade = false,
  clipStart = false,
  divider = false,
  title,
}: {
  value: SlotValue | undefined;
  /** Shown while `value` is empty, after the grace period (the sidebar's place under a status). */
  fallback?: SlotValue;
  className?: string;
  /** Cross-fade without movement (names). */
  fade?: boolean;
  /** Truncate at the start, keeping the end (paths). */
  clipStart?: boolean;
  /** A thin divider before the value. Part of the slot, so it collapses with it and
   *  stays put while values swap. */
  divider?: boolean;
  title?: string;
}) {
  countRender("Slot");
  const animate = useContext(SlotMotion);
  const shown = useSettled(value, animate) ?? fallback;
  const key = keyOf(shown);
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const mounted = useRef(false);
  const prev = useRef<{ key: string | null; text: string }>({ key, text: shown?.text ?? "" });
  const [leaving, setLeaving] = useState<{ id: number; text: string } | null>(null);
  /** The value that replaced another (its entry waits for the exit; see styles.css). */
  const [swapped, setSwapped] = useState<string | null>(null);
  /**
   * The value animating in, until its animation ends. Not derived from `animate`
   * per render: a window scrolling into view would then (re)play its title's
   * entry animations, as would dropping .still from one that already played.
   */
  const [entering, setEntering] = useState<string | null>(null);
  const gen = useRef(0);
  const natural = useRef(0);

  // Divided slots (place, status): hide when squeezed to a sliver. A ResizeObserver
  // reports flex squeezing without forcing layout; while the width eases (entering,
  // swapping) it's never a sliver, and it's checked once more when that ends.
  const sliver = (el: HTMLElement, w: number) =>
    el.classList.toggle("sliver", !el.classList.contains("moving") && w < natural.current - 0.5 && w < SLIVER);
  useEffect(() => {
    const el = outer.current;
    if (!divider || !el) return;
    const ro = new ResizeObserver(([e]) => e && sliver(el, e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [divider]);

  // Width follows the content; measured only when the content changes (not per render).
  // While it eases, the text is clipped rather than ellipsized: an ellipsis riding
  // along the growing edge ("15 l…", "15 lines…") reads as flicker.
  useLayoutEffect(() => {
    const el = outer.current;
    if (!el) return;
    natural.current = shown && inner.current ? naturalWidth(inner.current) : 0;
    const w = `${natural.current}px`;
    if (el.style.width === w) return;
    const first = !el.style.width;
    el.style.width = w;
    if (first || !animate) return;
    el.classList.add("moving");
    el.classList.remove("sliver");
    const t = setTimeout(() => {
      el.classList.remove("moving");
      if (divider) sliver(el, el.clientWidth);
    }, MOVE_MS);
    return () => {
      clearTimeout(t);
      el.classList.remove("moving");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, shown?.text, divider]);

  useLayoutEffect(() => {
    if (prev.current.key !== key && prev.current.key !== null && animate && mounted.current) {
      setLeaving({ id: ++gen.current, text: prev.current.text });
      setSwapped(key);
      setEntering(key);
    } else if (prev.current.key !== key) {
      setSwapped(null);
      setEntering(animate && mounted.current ? key : null);
    }
    prev.current = { key, text: shown?.text ?? "" };
    mounted.current = true;
  }, [key, shown?.text, animate]);

  const text = (t: string) => (clipStart ? `‎${t}‎` : t);
  const cls = `${fade ? "fade" : ""} ${clipStart ? "clip-start" : ""}`;
  return (
    <span ref={outer} className={`slot ${className} ${divider ? "divided" : ""} ${animate ? "" : "still"}`} data-tip={title}>
      {divider && <span className="slot-divider" aria-hidden />}
      {leaving && (
        <span key={`out-${leaving.id}`} className={`slot-v out ${cls}`} onAnimationEnd={() => setLeaving(null)} aria-hidden>
          {text(leaving.text)}
        </span>
      )}
      {shown && (
        <span
          key={key!}
          ref={inner}
          className={`slot-v ${entering === key ? "in" : ""} ${swapped === key ? "swap" : ""} ${cls}`}
          onAnimationEnd={(e) => e.target === e.currentTarget && setEntering(null)}
        >
          {text(shown.text)}
        </span>
      )}
    </span>
  );
}

/** The window's mark: an agent's status light, else the type icon. */
export function Mark({ light, icon }: { light?: Led; icon: string }) {
  return (
    <span className={`mark ${light ? "has-light" : ""}`}>
      <Symbol name={icon} size={ICON.small} className="mark-icon" />
      <span className={`led led-${light ?? "off"} mark-light`} />
    </span>
  );
}

/** Unsaved changes: a dot that scales in and out. */
export function DirtyDot({ on }: { on: boolean }) {
  return <span className={`dirty-dot ${on ? "on" : ""}`} data-tip={on ? "Unsaved changes" : undefined} />;
}
