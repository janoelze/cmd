// Tooltips for every window (main, Settings, Task Manager), in place of the
// native `title`. Two kinds, one layer:
//
//   plain  <button data-tip="Back" data-tip-key="⌘[">: a small label, with the
//          shortcut set off on the right. `\n` breaks lines. data-tip-side
//          (top/bottom/left/right) overrides the side.
//   rich   const ref = useTooltip(() => <Summary />): any React content in a
//          larger card (the remote indicator's who-is-connected). It renders in
//          the layer's own root, so content that reads the store stays live.
//
// One delegated listener per document finds the nearest tipped ancestor of
// the pointer (or keyboard focus). The first tip waits a moment; once one has
// been shown, moving to a neighbour shows the next at once and the card glides
// over (macOS behaves the same). A press, a key, a scroll or leaving the window
// hides it, and the pressed element stays quiet until the pointer leaves it.
// Placement: the side with room (above in the lower part of the window, below
// otherwise), flipped if it doesn't fit, shifted to stay inside the window.

import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

export type TipSide = "top" | "bottom" | "left" | "right";

interface RichTip {
  render: () => ReactNode;
  side?: TipSide;
}

const SHOW_DELAY = 450; // first tip
const WARM = 400; // after a tip hides, the next shows without delay for this long
const GAP = 6; // anchor to tip
const MARGIN = 8; // tip to window edge

// Rich tips by element; the box is updated on each render of its owner.
const rich = new WeakMap<Element, { current: RichTip }>();

// ── controller ─────────────────────────────────────────

interface State {
  anchor: Element | null;
  shown: boolean;
  /** Came straight from another tip: glide over instead of popping in. */
  glide: boolean;
  /** Bumped to re-render rich content whose owner re-rendered. */
  rev: number;
}

let state: State = { anchor: null, shown: false, glide: false, rev: 0 };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};

let timer: ReturnType<typeof setTimeout> | undefined;
let candidate: Element | null = null; // under the pointer or focused, shown or waiting
let hiddenAt = 0;
let quiet: Element | null = null; // pressed: no tip until the pointer leaves it

function tipped(el: Element): boolean {
  if (rich.has(el)) return true;
  const t = el.getAttribute("data-tip");
  return !!t;
}

function anchorOf(node: EventTarget | null): Element | null {
  for (let n = node instanceof Element ? node : null; n; n = n.parentElement) if (tipped(n)) return n;
  return null;
}

/** A menu or popover is open from this element: its tip would cover it. */
const expanded = (el: Element) => el.getAttribute("aria-expanded") === "true";

function show(el: Element) {
  clearTimeout(timer);
  if (expanded(el) || !el.isConnected) return;
  set({ anchor: el, shown: true, glide: state.shown || performance.now() - hiddenAt < WARM });
}

function hide(cool = false) {
  clearTimeout(timer);
  candidate = null;
  if (state.shown) {
    hiddenAt = cool ? 0 : performance.now();
    set({ shown: false, glide: false });
  } else if (cool) hiddenAt = 0;
}

function enter(el: Element | null) {
  if (el === candidate) return;
  if (!el || el === quiet) return hide();
  candidate = el;
  clearTimeout(timer);
  if (state.shown || performance.now() - hiddenAt < WARM) show(el);
  else timer = setTimeout(() => candidate === el && show(el), SHOW_DELAY);
}

function install(doc: Document) {
  const win = doc.defaultView!;
  doc.addEventListener(
    "pointerover",
    (e) => {
      if (e.pointerType === "touch" || e.buttons) return; // not while dragging
      if (quiet && !quiet.contains(e.target as Node)) quiet = null;
      enter(anchorOf(e.target));
    },
    true,
  );
  doc.documentElement.addEventListener("pointerleave", () => hide());
  doc.addEventListener(
    "pointerdown",
    (e) => {
      quiet = anchorOf(e.target);
      hide(true);
    },
    true,
  );
  doc.addEventListener("keydown", () => hide(true), true);
  doc.addEventListener("wheel", () => hide(true), { capture: true, passive: true });
  // Only scrolls that move the anchor (a terminal printing elsewhere scrolls too).
  doc.addEventListener("scroll", (e) => state.shown && state.anchor && (e.target as Node).contains?.(state.anchor) && hide(true), true);
  // Keyboard focus shows a tip too (only focus from the keyboard: :focus-visible).
  doc.addEventListener("focusin", (e) => {
    const el = anchorOf(e.target);
    if (el && (e.target as Element).matches?.(":focus-visible")) enter(el);
  });
  doc.addEventListener("focusout", (e) => {
    if (candidate && !candidate.contains(e.relatedTarget as Node | null) && !candidate.matches(":hover")) hide();
  });
  win.addEventListener("blur", () => hide(true));
}

// ── rich tips ──────────────────────────────────────────

/**
 * A ref for an element that should show `render()` as its tip. `render` may
 * close over the owner's props; the tip updates when the owner re-renders.
 */
export function useTooltip<T extends Element = HTMLElement>(render: () => ReactNode, opts: { side?: TipSide } = {}): (el: T | null) => void {
  const box = useRef<RichTip>({ render, side: opts.side });
  box.current.render = render;
  box.current.side = opts.side;
  const el = useRef<T | null>(null);
  useEffect(() => {
    if (state.shown && state.anchor && state.anchor === el.current) set({ rev: state.rev + 1 });
  });
  return useCallback((node: T | null) => {
    if (el.current) rich.delete(el.current);
    el.current = node;
    if (node) rich.set(node, box);
  }, []);
}

// ── the layer ──────────────────────────────────────────

function Layer() {
  const s = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );
  const pos = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  // What the card shows: the anchor's tip as of now. Kept while it fades out.
  const anchor = s.anchor;
  const r = anchor ? rich.get(anchor)?.current : undefined;
  const text = anchor && !r ? (anchor.getAttribute("data-tip") ?? "") : "";
  const key = anchor && !r ? anchor.getAttribute("data-tip-key") : null;

  useLayoutEffect(() => {
    const p = pos.current!;
    const c = card.current!;
    if (!s.shown || !anchor) {
      c.removeAttribute("data-shown");
      return;
    }
    const side = (anchor.getAttribute("data-tip-side") as TipSide | null) ?? r?.side;
    let last = "";
    const place = (first: boolean) => {
      const a = anchor.getBoundingClientRect();
      const w = p.offsetWidth;
      const h = p.offsetHeight;
      const sig = `${a.left},${a.top},${a.width},${a.height},${w},${h},${innerWidth},${innerHeight}`;
      if (sig === last) return;
      last = sig;
      const at = placeTip(a, w, h, side);
      p.style.transition = first && s.glide ? "" : "none";
      p.style.transform = `translate(${at.x}px, ${at.y}px)`;
      c.dataset.side = at.side;
      // Grows from the point nearest the anchor's centre.
      const ox = Math.min(w, Math.max(0, a.left + a.width / 2 - at.x));
      const oy = Math.min(h, Math.max(0, a.top + a.height / 2 - at.y));
      c.style.transformOrigin = `${ox}px ${oy}px`;
    };
    place(true);
    if (!s.glide) void c.offsetWidth; // start from the hidden pose, then animate in
    c.setAttribute("data-shown", "");
    // Follow the anchor while shown (it can move, resize or disappear).
    let raf = requestAnimationFrame(function tick() {
      if (!anchor.isConnected || expanded(anchor)) return hide();
      if (!tipped(anchor)) return hide();
      if (!r && (anchor.getAttribute("data-tip") !== text || anchor.getAttribute("data-tip-key") !== key)) return set({ rev: state.rev + 1 });
      place(false);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  });

  return (
    <div ref={pos} className="tip-pos" aria-hidden={!s.shown}>
      <div ref={card} id="cmd-tooltip" role="tooltip" className={r ? "tip rich" : "tip"}>
        {r ? (
          r.render()
        ) : (
          <>
            <span className="tip-text">{text}</span>
            {key && <kbd className="tip-key">{key}</kbd>}
          </>
        )}
      </div>
    </div>
  );
}

/** Where a w×h tip goes beside rect `a`: the preferred side if it fits, else the other, kept inside the window. */
export function placeTip(
  a: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  w: number,
  h: number,
  prefer: TipSide | undefined,
  vw = innerWidth,
  vh = innerHeight,
): { x: number; y: number; side: TipSide } {
  const room: Record<TipSide, number> = {
    top: a.top - GAP - MARGIN,
    bottom: vh - a.bottom - GAP - MARGIN,
    left: a.left - GAP - MARGIN,
    right: vw - a.right - GAP - MARGIN,
  };
  const need = (s: TipSide) => (s === "top" || s === "bottom" ? h : w);
  const flip: Record<TipSide, TipSide> = { top: "bottom", bottom: "top", left: "right", right: "left" };
  const first = prefer ?? (a.top + a.height / 2 > vh * 0.6 ? "top" : "bottom");
  const side = room[first] >= need(first) ? first : room[flip[first]] >= need(first) ? flip[first] : room[first] >= room[flip[first]] ? first : flip[first];
  const clamp = (v: number, size: number, max: number) => Math.max(MARGIN, Math.min(v, max - size - MARGIN));
  if (side === "top" || side === "bottom")
    return { side, x: Math.round(clamp(a.left + a.width / 2 - w / 2, w, vw)), y: Math.round(side === "top" ? Math.max(MARGIN, a.top - GAP - h) : Math.min(vh - h - MARGIN, a.bottom + GAP)) };
  return { side, y: Math.round(clamp(a.top + a.height / 2 - h / 2, h, vh)), x: Math.round(side === "left" ? Math.max(MARGIN, a.left - GAP - w) : Math.min(vw - w - MARGIN, a.right + GAP)) };
}

/** Called once by each window's entry point, like installScrollbars. */
export function installTooltips(doc: Document = document): void {
  install(doc);
  const host = doc.createElement("div");
  host.className = "tip-layer";
  doc.body.appendChild(host);
  createRoot(host).render(<Layer />);
}
