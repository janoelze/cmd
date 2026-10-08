// One scrollbar look for every window: lists, editors, Markdown, terminals and the
// pages inside browser windows (BrowserView injects SCROLLBAR_CSS and SCROLLBAR_JS
// into each page). Minimal: no track, a thin, faint thumb that thickens and brightens
// under the pointer. The hit area stays 10px wide; a transparent border narrows what's
// drawn. Gray reads on dark panes and white pages.
//
// Like macOS, the thumb shows while you scroll and fades out about a second later
// (unless the pointer rests on it), or stays put when the system's "Show scroll bars"
// is set to Always. CSS alone can't do that: Chromium doesn't repaint ::-webkit-scrollbar
// when the scroller's :hover changes, and pseudo-scrollbars don't transition. What does
// work is a class toggled from a scroll listener driving a registered custom property,
// which the thumb takes its colour from: that repaints, and the property animates.

const THUMB = "rgb(128 128 128 / 0.34)";
const THUMB_HOVER = "rgb(128 128 128 / 0.62)";
const THUMB_ACTIVE = "rgb(128 128 128 / 0.8)";

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

/** The behaviour as a script for a page (BrowserView runs it in each page it shows). */
export function scrollbarScript(o: ScrollbarsOptions = {}): string {
  return o.always
    ? `document.documentElement.classList.add("cmd-scrollbars-always");`
    : `(${watchScrollbars.toString()})(document, ${SCROLLBAR_HOLD});`;
}

export function installScrollbars(o: ScrollbarsOptions = {}): void {
  const style = document.createElement("style");
  style.dataset.cmd = "scrollbars";
  style.textContent = SCROLLBAR_CSS + XTERM_CSS;
  document.head.appendChild(style);
  if (o.always) document.documentElement.classList.add("cmd-scrollbars-always");
  else watchScrollbars(document, SCROLLBAR_HOLD);
}
