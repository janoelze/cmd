// One scrollbar look for every window: lists, editors, Markdown, terminals and the
// pages inside browser windows. Except in terminals, they float over the content. Minimal: no track, a thin, faint thumb that thickens and brightens
// under the pointer. The hit area stays 10px wide; a transparent border narrows what's
// drawn. Gray reads on dark panes and white pages.
//
// Like macOS, the thumb shows while you scroll and fades out about a second later
// (unless the pointer rests on it), or stays put when the system's "Show scroll bars"
// is set to Always. CSS alone can't do that: Chromium doesn't repaint ::-webkit-scrollbar
// when the scroller's :hover changes, and pseudo-scrollbars don't transition. What does
// work is a class toggled from a scroll listener driving a registered custom property,
// which the thumb takes its colour from: that repaints, and the property animates.
//
// Pages draw theirs differently. Styling a page's ::-webkit-scrollbar turns macOS's
// overlay scrollbars into classic ones, which take 10px off every scrolling page, so
// BrowserView hides the page's scrollbars (PAGE_SCROLLBAR_CSS) and runs pageScrollbars
// in it, which floats the same thumb over each scroller, light on dark pages.

const THUMB = "rgb(128 128 128 / 0.34)";
const THUMB_HOVER = "rgb(128 128 128 / 0.62)";
const THUMB_ACTIVE = "rgb(128 128 128 / 0.8)";
/** On dark pages, where the gray barely shows. */
const THUMB_ON_DARK: Tones = ["rgb(255 255 255 / 0.34)", "rgb(255 255 255 / 0.55)", "rgb(255 255 255 / 0.7)"];

/** How long after the last scroll the thumb stays, in ms. */
export const SCROLLBAR_HOLD = 1000;

export const SCROLLBAR_CSS = `
@property --cmd-scrollbar { syntax: "<color>"; inherits: true; initial-value: transparent; }
* { --cmd-scrollbar: transparent; transition: --cmd-scrollbar 350ms ease-out; }
.cmd-scrolling { --cmd-scrollbar: ${THUMB}; transition-duration: 100ms; }
.cmd-scrollbars-always, .cmd-scrollbars-always * { --cmd-scrollbar: ${THUMB}; }
::-webkit-scrollbar { width: 10px; height: 10px; background: transparent; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb {
  min-height: 32px;
  min-width: 32px;
  border: 3px solid transparent;
  border-radius: 5px;
  background: var(--cmd-scrollbar) padding-box;
}
.cmd-scrolling::-webkit-scrollbar-thumb:hover, .cmd-scrollbars-always ::-webkit-scrollbar-thumb:hover { border-width: 2px; background-color: ${THUMB_HOVER}; }
.cmd-scrolling::-webkit-scrollbar-thumb:active, .cmd-scrollbars-always ::-webkit-scrollbar-thumb:active { border-width: 2px; background-color: ${THUMB_ACTIVE}; }
`;

/**
 * xterm.js draws its own scrollbar: style its slider the same, show it only when there
 * is scrollback (terminals.ts sets .scrollable on the host) and, since xterm keeps it
 * shown while the pointer is anywhere over the terminal, only while the terminal
 * scrolls (terminals.ts calls scrolled() on the host) or the pointer is on the bar.
 */
const XTERM_CSS = `
.xterm .xterm-scrollable-element > .scrollbar.vertical > .slider {
  left: auto !important;
  right: 3px;
  width: 4px !important;
  border-radius: 2px;
  background: ${THUMB} !important;
}
.xterm .xterm-scrollable-element > .scrollbar.vertical:hover > .slider,
.xterm .xterm-scrollable-element > .scrollbar.vertical > .slider.active {
  right: 2px;
  width: 6px !important;
  border-radius: 3px;
  background: ${THUMB_HOVER} !important;
}
.xterm .xterm-scrollable-element > .scrollbar.vertical > .slider.active { background: ${THUMB_ACTIVE} !important; }
.xterm .xterm-scrollable-element > .scrollbar.vertical { transition: opacity 350ms ease-out !important; }
.xterm-host.scrollable .xterm .xterm-scrollable-element > .scrollbar.vertical.visible { opacity: 0; }
.xterm-host.scrollable.cmd-scrolling .xterm .xterm-scrollable-element > .scrollbar.vertical.visible { opacity: 1; transition-duration: 100ms !important; }
.xterm-host.scrollable .xterm .xterm-scrollable-element > .scrollbar.vertical.visible:hover,
.xterm-host.scrollable .xterm .xterm-scrollable-element > .scrollbar.vertical.visible:has(.slider.active) { opacity: 1; }
.cmd-scrollbars-always .xterm-host.scrollable .xterm .xterm-scrollable-element > .scrollbar.vertical { opacity: 1; }
.xterm-host:not(.scrollable) .xterm .xterm-scrollable-element > .scrollbar.vertical { opacity: 0; pointer-events: none; }
.xterm .xterm-scrollable-element > .shadow { display: none; }
`;

const holds = new Map<Element, ReturnType<typeof setTimeout>>();

/** Marks `el` as scrolling (.cmd-scrolling) until SCROLLBAR_HOLD ms after the last call. */
export function scrolled(el: Element): void {
  el.classList.add("cmd-scrolling");
  clearTimeout(holds.get(el));
  holds.set(
    el,
    setTimeout(() => {
      el.classList.remove("cmd-scrolling");
      holds.delete(el);
    }, SCROLLBAR_HOLD),
  );
}

/**
 * Marks whatever scrolls with .cmd-scrolling until `hold` ms after its last scroll,
 * longer while the pointer rests on its scrollbar or holds the thumb. Self-contained
 * (no outer references), so BrowserView can stringify it into a page.
 */
export function watchScrollbars(doc: Document, hold: number): void {
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  let held: Element | null = null;
  const hide = (el: Element) => {
    el.classList.remove("cmd-scrolling");
    timers.delete(el);
  };
  const keep = (el: Element) => {
    el.classList.add("cmd-scrolling");
    clearTimeout(timers.get(el));
    timers.set(
      el,
      setTimeout(() => (held === el ? keep(el) : hide(el)), hold),
    );
  };
  // Over the strip the scrollbar occupies: past the client box, inside the border box.
  const overBar = (el: Element, e: { clientX: number; clientY: number }) => {
    if (el === doc.documentElement) return e.clientX >= el.clientWidth || e.clientY >= el.clientHeight;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left - el.clientLeft;
    const y = e.clientY - r.top - el.clientTop;
    if (x < 0 || y < 0 || x > r.width || y > r.height) return false;
    return x >= el.clientWidth || y >= el.clientHeight;
  };
  doc.addEventListener(
    "scroll",
    (e) => {
      const t = e.target === doc ? doc.documentElement : e.target;
      if (t && typeof t === "object" && "classList" in t) keep(t as Element);
    },
    { capture: true, passive: true },
  );
  doc.addEventListener(
    "pointermove",
    (e) => {
      for (const el of timers.keys()) if (overBar(el, e)) keep(el);
    },
    { capture: true, passive: true },
  );
  doc.addEventListener(
    "pointerdown",
    (e) => {
      for (const el of timers.keys()) if (overBar(el, e)) held = el;
    },
    { capture: true, passive: true },
  );
  const release = () => {
    if (held) keep(held);
    held = null;
  };
  doc.addEventListener("pointerup", release, { capture: true, passive: true });
  doc.addEventListener("pointercancel", release, { capture: true, passive: true });
}

export type ScrollbarsOptions = {
  /** Keep thumbs shown instead of fading them: the system's "Show scroll bars: Always". */
  always?: boolean;
};

/** For pages: hides their own scrollbars, which pageScrollbars draws instead. */
export const PAGE_SCROLLBAR_CSS = `* { scrollbar-width: none !important; }`;

/** Where a scroller's thumb goes along its track, in px: offset and length. */
export function thumbSpan(track: number, view: number, size: number, scroll: number): { offset: number; length: number } {
  const length = Math.min(track, Math.max(32, (track * view) / size));
  const max = size - view;
  const at = max > 0 ? Math.min(1, Math.max(0, scroll / max)) : 0;
  return { offset: (track - length) * at, length };
}

type Tones = [thumb: string, hover: string, active: string];
type PageScrollbarsOptions = { hold: number; always: boolean; light: Tones; dark: Tones };

/**
 * Floats a thumb over each scroller of a page (its own are hidden by PAGE_SCROLLBAR_CSS),
 * drawn like SCROLLBAR_CSS's: shown while it scrolls and for `hold` ms after, kept while
 * the pointer rests on it, draggable, a click on its track pages. Thumbs live in a closed
 * shadow root over the page, styled through a constructed sheet, which pages' CSS and CSP
 * don't reach. Self-contained (only its arguments), so BrowserView can stringify it.
 */
export function pageScrollbars(doc: Document, o: PageScrollbarsOptions, span: typeof thumbSpan): void {
  const win = doc.defaultView as (Window & typeof globalThis & { __cmdScrollbars?: boolean }) | null;
  if (!win || win.__cmdScrollbars) return;
  win.__cmdScrollbars = true;
  const HIT = 10;
  const host = doc.createElement("cmd-scrollbars");
  const fixed = { all: "initial", position: "fixed", inset: "0", "pointer-events": "none", "z-index": "2147483647" };
  for (const [k, v] of Object.entries(fixed)) {
    host.style.setProperty(k, v, "important");
  }
  const shadow = host.attachShadow({ mode: "closed" });
  const sheet = new win.CSSStyleSheet();
  sheet.replaceSync(`
    .bar { position: fixed; pointer-events: none; opacity: 0; transition: opacity 350ms ease-out; }
    .bar.on { opacity: 1; pointer-events: auto; transition-duration: 100ms; }
    .thumb { position: absolute; }
    .thumb::before { content: ""; position: absolute; inset: 3px; border-radius: 2px; background: var(--thumb); }
    .thumb:hover::before, .held .thumb::before { inset: 2px; border-radius: 3px; background: var(--hover); }
    .held .thumb::before { background: var(--active); }
  `);
  shadow.adoptedStyleSheets = [sheet];

  type Axis = "x" | "y";
  type Bar = { el: HTMLElement; thumb: HTMLElement; track: number; offset: number; length: number };
  type State = { bars: Partial<Record<Axis, Bar>>; on: boolean; hovered: boolean; held: boolean; timer?: ReturnType<typeof setTimeout> };
  const states = new Map<Element, State>();
  const root = () => doc.scrollingElement ?? doc.documentElement;
  const metrics = (el: Element, axis: Axis) =>
    axis === "y" ? { view: el.clientHeight, size: el.scrollHeight, scroll: el.scrollTop } : { view: el.clientWidth, size: el.scrollWidth, scroll: el.scrollLeft };
  // The scroller's visible box: the viewport for the page itself, else its padding box.
  const box = (el: Element) => {
    if (el === root()) return { left: 0, top: 0, width: el.clientWidth, height: el.clientHeight };
    const r = el.getBoundingClientRect();
    return { left: r.left + el.clientLeft, top: r.top + el.clientTop, width: el.clientWidth, height: el.clientHeight };
  };

  // Light thumbs on dark backgrounds: the first opaque one behind the scroller decides.
  const paint = doc.createElement("canvas").getContext("2d");
  const dark = (el: Element) => {
    for (let at: Element | null = el === root() ? (doc.body ?? el) : el; at; at = at.parentElement) {
      const bg = win.getComputedStyle(at).backgroundColor;
      if (!paint) break;
      paint.fillStyle = "#000";
      paint.fillStyle = bg;
      const c = String(paint.fillStyle);
      const m = c.match(/^#(..)(..)(..)$/);
      const n = m ? m.slice(1).map((h) => parseInt(h, 16)) : c.startsWith("rgb") ? (c.match(/[\d.]+/g) ?? []).map(Number) : [];
      const [r = 0, g = 0, b = 0, alpha = 1] = n;
      if (n.length < 3 || alpha < 0.5) continue;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    }
    const scheme = win.getComputedStyle(doc.documentElement).colorScheme;
    return /dark/.test(scheme) && !/light/.test(scheme);
  };

  const bar = (el: Element, s: State, axis: Axis): Bar => {
    const existing = s.bars[axis];
    if (existing) return existing;
    const b: Bar = { el: doc.createElement("div"), thumb: doc.createElement("div"), track: 0, offset: 0, length: 0 };
    b.el.className = `bar ${axis}`;
    b.thumb.className = "thumb";
    b.el.append(b.thumb);
    shadow.append(b.el);
    b.el.addEventListener("pointerenter", () => (s.hovered = true));
    b.el.addEventListener("pointerleave", () => {
      s.hovered = false;
      if (!s.held) keep(el);
    });
    // The bar sits over the scroller, so scroll it rather than whatever is under the host.
    b.el.addEventListener("wheel", (e) => {
      e.preventDefault();
      el.scrollBy(e.deltaX, e.deltaY);
    }, { passive: false });
    b.el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = b.el.getBoundingClientRect();
      const at = axis === "y" ? e.clientY - r.top : e.clientX - r.left;
      const m = metrics(el, axis);
      if (at < b.offset || at > b.offset + b.length) {
        // On the track: a page towards the pointer.
        const page = Math.sign(at - b.offset) * m.view * 0.9;
        el.scrollBy(axis === "y" ? { top: page } : { left: page });
        return;
      }
      s.held = true;
      b.el.classList.add("held");
      b.el.setPointerCapture(e.pointerId);
      const from = axis === "y" ? e.clientY : e.clientX;
      const start = m.scroll;
      const ratio = (m.size - m.view) / Math.max(1, b.track - b.length);
      const move = (e: PointerEvent) => {
        const to = start + ((axis === "y" ? e.clientY : e.clientX) - from) * ratio;
        if (axis === "y") el.scrollTop = to;
        else el.scrollLeft = to;
      };
      const up = () => {
        s.held = false;
        b.el.classList.remove("held");
        b.el.removeEventListener("pointermove", move);
        b.el.removeEventListener("pointerup", up);
        b.el.removeEventListener("pointercancel", up);
        keep(el);
      };
      b.el.addEventListener("pointermove", move);
      b.el.addEventListener("pointerup", up);
      b.el.addEventListener("pointercancel", up);
    });
    s.bars[axis] = b;
    return b;
  };

  const place = (el: Element, s: State) => {
    if (!el.isConnected) {
      for (const b of Object.values(s.bars)) b?.el.remove();
      clearTimeout(s.timer);
      states.delete(el);
      return;
    }
    const v = box(el);
    for (const axis of ["y", "x"] as const) {
      const m = metrics(el, axis);
      const scrolls = m.size > m.view + 1;
      if (!scrolls && !s.bars[axis]) continue;
      const b = bar(el, s, axis);
      b.el.classList.toggle("on", s.on && scrolls);
      if (!scrolls) continue;
      b.track = axis === "y" ? v.height : v.width;
      const t = span(b.track, m.view, m.size, m.scroll);
      b.offset = t.offset;
      b.length = t.length;
      const px = (n: number) => `${n}px`;
      if (axis === "y") {
        Object.assign(b.el.style, { left: px(v.left + v.width - HIT), top: px(v.top), width: px(HIT), height: px(v.height) });
        Object.assign(b.thumb.style, { left: "0", right: "0", top: px(t.offset), height: px(t.length) });
      } else {
        Object.assign(b.el.style, { left: px(v.left), top: px(v.top + v.height - HIT), width: px(v.width), height: px(HIT) });
        Object.assign(b.thumb.style, { top: "0", bottom: "0", left: px(t.offset), width: px(t.length) });
      }
    }
  };

  let frame = 0;
  const placeAll = () => {
    frame = 0;
    if (!host.isConnected) doc.documentElement.append(host);
    for (const [el, s] of states) if (s.on) place(el, s);
  };
  const soon = () => (frame ||= win.requestAnimationFrame(placeAll));

  const hide = (el: Element, s: State) => {
    s.on = false;
    for (const b of Object.values(s.bars)) b?.el.classList.remove("on");
  };
  function keep(el: Element) {
    let s = states.get(el);
    if (!s) {
      s = { bars: {}, on: false, hovered: false, held: false };
      states.set(el, s);
    }
    if (!s.on) {
      const tones = dark(el) ? o.dark : o.light;
      s.on = true;
      place(el, s);
      for (const b of Object.values(s.bars)) {
        b?.el.style.setProperty("--thumb", tones[0]);
        b?.el.style.setProperty("--hover", tones[1]);
        b?.el.style.setProperty("--active", tones[2]);
      }
    }
    soon();
    clearTimeout(s.timer);
    if (o.always) return;
    const st = s;
    st.timer = setTimeout(() => (st.hovered || st.held ? keep(el) : hide(el, st)), o.hold);
  }

  doc.documentElement.append(host);
  doc.addEventListener(
    "scroll",
    (e) => {
      const t = e.target === doc ? root() : e.target;
      if (t instanceof win.Element) keep(t);
      soon(); // others move with it
    },
    { capture: true, passive: true },
  );
  win.addEventListener("resize", soon, { passive: true });
  if (doc.body) new win.ResizeObserver(soon).observe(doc.body);
  if (o.always) {
    // Shown from the start: the page itself, and whatever scrolls under the pointer.
    const r = root();
    if (r.scrollHeight > r.clientHeight + 1 || r.scrollWidth > r.clientWidth + 1) keep(r);
    doc.addEventListener(
      "pointerover",
      (e) => {
        for (let at = e.target instanceof win.Element ? e.target : null; at && at !== r; at = at.parentElement) {
          if (states.has(at)) break;
          const cs = win.getComputedStyle(at);
          if ((/auto|scroll/.test(cs.overflowY) && at.scrollHeight > at.clientHeight + 1) || (/auto|scroll/.test(cs.overflowX) && at.scrollWidth > at.clientWidth + 1)) keep(at);
        }
      },
      { capture: true, passive: true },
    );
  }
}

/** The page side as a script for a page (BrowserView runs it in each page it shows). */
export function scrollbarScript(o: ScrollbarsOptions = {}): string {
  const options: PageScrollbarsOptions = { hold: SCROLLBAR_HOLD, always: !!o.always, light: [THUMB, THUMB_HOVER, THUMB_ACTIVE], dark: THUMB_ON_DARK };
  return `(${pageScrollbars.toString()})(document, ${JSON.stringify(options)}, ${thumbSpan.toString()});`;
}

/**
 * The app's own windows draw their scrollbars like pages do: native ones hidden, the
 * thumb floated over each scroller (pageScrollbars), so a scrollbar never takes room
 * from the content and nothing moves when one appears. Terminals keep xterm's, styled.
 */
export function installScrollbars(o: ScrollbarsOptions = {}): void {
  const style = document.createElement("style");
  style.dataset.cmd = "scrollbars";
  style.textContent = PAGE_SCROLLBAR_CSS + XTERM_CSS;
  document.head.appendChild(style);
  if (o.always) document.documentElement.classList.add("cmd-scrollbars-always");
  pageScrollbars(document, { hold: SCROLLBAR_HOLD, always: !!o.always, light: [THUMB, THUMB_HOVER, THUMB_ACTIVE], dark: THUMB_ON_DARK }, thumbSpan);
}
