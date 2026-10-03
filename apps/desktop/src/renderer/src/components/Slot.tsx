// Animated title-bar pieces (docs/10-window-titles.md, "Motion"). A Slot is one
// field that stays mounted when empty (width 0), so a value never pops in or out:
//  - a new key swaps: the old value fades up and out, the new one fades in from
//    below, and the slot's width eases between them;
//  - the same key updates in place, so counters ("3m ago", usage) don't animate;
//  - a value stays at least DWELL ms (changes in between coalesce), and a
//    transient one (loading) appears only if it lasts DELAY ms.
// Mark is the window's status light or type icon, cross-fading between them.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Led } from "../model.ts";
import { ICON, Symbol } from "./Symbol.tsx";

const DWELL = 600;
const DELAY = 200;

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
    const wait = animate
      ? Math.max(since.current + DWELL - performance.now(), v?.transient ? DELAY : 0)
      : v?.transient
        ? DELAY
        : 0;
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
  className = "",
  fade = false,
  clipStart = false,
  title,
}: {
  value: SlotValue | undefined;
  className?: string;
  /** Cross-fade without movement (names). */
  fade?: boolean;
  /** Truncate at the start, keeping the end (paths). */
  clipStart?: boolean;
  title?: string;
}) {
  const animate = useContext(SlotMotion);
  const shown = useSettled(value, animate);
  const key = keyOf(shown);
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const mounted = useRef(false);
  const prev = useRef<{ key: string | null; text: string }>({ key, text: shown?.text ?? "" });
  const [leaving, setLeaving] = useState<{ id: number; text: string } | null>(null);
  const gen = useRef(0);

  // Width follows the content; measured only when the content changes (not per render).
  useLayoutEffect(() => {
    const el = outer.current;
    if (el) el.style.width = `${shown && inner.current ? naturalWidth(inner.current) : 0}px`;
  }, [key, shown?.text]);

  useLayoutEffect(() => {
    if (prev.current.key !== key && prev.current.key !== null && animate && mounted.current) {
      setLeaving({ id: ++gen.current, text: prev.current.text });
    }
    prev.current = { key, text: shown?.text ?? "" };
    mounted.current = true;
  }, [key, shown?.text, animate]);

  const text = (t: string) => (clipStart ? `‎${t}‎` : t);
  const cls = `${fade ? "fade" : ""} ${clipStart ? "clip-start" : ""}`;
  return (
    <span ref={outer} className={`slot ${className} ${animate ? "" : "still"}`} title={title}>
      {leaving && (
        <span key={`out-${leaving.id}`} className={`slot-v out ${cls}`} onAnimationEnd={() => setLeaving(null)} aria-hidden>
          {text(leaving.text)}
        </span>
      )}
      {shown && (
        <span key={key!} ref={inner} className={`slot-v ${mounted.current && animate ? "in" : ""} ${cls}`}>
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
  return <span className={`dirty-dot ${on ? "on" : ""}`} title={on ? "Unsaved changes" : undefined} />;
}
