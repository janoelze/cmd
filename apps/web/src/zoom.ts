// How the phone shows a Mac terminal without resizing it (docs/13, "Terminals on a
// phone"), as pure numbers: the font it opens at, how far it pans, pinch and double-tap.
// The terminal keeps the Mac's grid; only its font size (the zoom) and its place under
// the screen (the pan) change. Up and down is one axis: the screen's own overflow first
// (a Mac terminal is usually taller than a phone), then the scrollback above it, so a
// drag runs from the latest line up through the history without a seam. viewport.ts
// applies these to the DOM.

/**
 * The smallest text size the phone picks on its own, and the smallest the Text Size
 * control offers: 9 px SF Mono is 27 device pixels tall on a 3× iPhone, where letters
 * like e, c and o still read apart; at 8 and below they blur at arm's length. Below it
 * the terminal pans sideways instead of shrinking (a pinch can still go smaller, to see
 * the whole width).
 */
export const MIN_FONT = 9;
/** The text size a new browser starts at: a 100-column Mac terminal shows about 57 columns of it on an iPhone 15 in portrait. */
export const DEFAULT_FONT = 11;
export const MAX_FONT = 18;
/** Room to spare (a narrow pane, landscape): the text grows to fill the width, up to this much past the text size. */
export const GROW = 1.5;
/** A pinch goes no further in than this, and no further out than the whole width (or this). */
export const ZOOM_MAX = 32;
export const ZOOM_MIN = 3;

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A cell's size per pixel of font size, measured from the terminal as drawn (viewport.ts). */
export interface Ratio {
  w: number;
  h: number;
}

/**
 * The fonts a terminal of `cols` columns can show at in `width` pixels, with text size
 * `pref`: `fit` fills the width exactly; `readable` is the text size, grown to fill the
 * width when there's room; `overview` shows the whole width (smaller than readable only
 * when the terminal is wider than the screen at the text size). `pans`: it is.
 */
export function anchors(cols: number, width: number, ratio: Ratio, pref: number) {
  const fit = width / (Math.max(1, cols) * ratio.w);
  const readable = clamp(fit, Math.max(MIN_FONT, pref), Math.max(MIN_FONT, pref) * GROW);
  return { fit, readable, overview: Math.min(fit, readable), pans: fit < readable - 0.01 };
}

/** How far a pinch may go: out to the whole width, in to ZOOM_MAX. */
export function zoomRange(a: { overview: number; readable: number }): [number, number] {
  return [Math.max(ZOOM_MIN, Math.min(a.overview, a.readable)), Math.max(ZOOM_MAX, a.readable)];
}

/** Double-tap: from the readable size out to the whole width; from anywhere else back to readable. All of it fits already: in closer. */
export function doubleTap(font: number, a: { overview: number; readable: number }): number {
  const near = (x: number, y: number) => Math.abs(x - y) < 0.5;
  if (!near(font, a.readable)) return a.readable;
  return a.overview < a.readable - 0.5 ? a.overview : Math.min(ZOOM_MAX, a.readable * 1.6);
}

/** A terminal of `cols` × `rows` filling `width` × `height` at font `font` ("Fit to This Phone"), in the range the Mac accepts. */
export function fitSize(width: number, height: number, ratio: Ratio, font: number): { cols: number; rows: number } {
  return {
    cols: clamp(Math.floor(width / (ratio.w * font)), 20, 300),
    rows: clamp(Math.floor(height / (ratio.h * font)), 5, 200),
  };
}

/**
 * The vertical axis. `v` is how far above the latest line the view is, in pixels: 0 is
 * the bottom of the screen (the prompt). The first `overflow` pixels move the screen
 * down under the view (`shift`); past that, whole lines of scrollback (`line`, the first
 * line shown, xterm's viewportY; `base` is the bottom one, baseY).
 */
export interface Extents {
  /** The terminal as drawn, padding included. */
  contentW: number;
  contentH: number;
  viewW: number;
  viewH: number;
  cellH: number;
  /** Lines of scrollback (xterm's baseY). */
  base: number;
}

export const overflowOf = (e: Extents) => Math.max(0, e.contentH - e.viewH);
export const maxX = (e: Extents) => Math.max(0, e.contentW - e.viewW);
export const maxV = (e: Extents) => overflowOf(e) + e.base * e.cellH;

export function place(v: number, e: Extents): { shift: number; line: number } {
  const over = overflowOf(e);
  const shift = clamp(v, 0, over);
  const lines = v > over && e.cellH > 0 ? clamp(Math.round((v - over) / e.cellH), 0, e.base) : 0;
  return { shift, line: e.base - lines };
}

/** `v` for what is shown: the screen moved down by `shift`, its first line `line`. */
export const offsetOf = (shift: number, line: number, e: Extents) => shift + Math.max(0, e.base - line) * e.cellH;

/** Where the terminal sits under the view (a translate): `x` pixels in from its left, the screen moved down `shift`. */
export const translateOf = (x: number, shift: number, e: Extents) => ({ x: -x, y: -(overflowOf(e) - shift) });

export interface View {
  font: number;
  /** Pixels panned in from the terminal's left edge. */
  x: number;
  /** Pixels above the latest line (above). */
  v: number;
}

export function clampView(view: View, e: Extents): View {
  return { font: view.font, x: clamp(view.x, 0, maxX(e)), v: clamp(view.v, 0, maxV(e)) };
}

export interface Point {
  x: number;
  y: number;
}

/**
 * A pinch under way, drawn as a transform of the terminal as it was (`t0`, its translate
 * when the pinch began): what was under the fingers' midpoint `p0` stays under `p1`.
 */
export function pinchTransform(t0: Point, p0: Point, p1: Point, s: number): Point & { s: number } {
  return { x: p1.x - (p0.x - t0.x) * s, y: p1.y - (p0.y - t0.y) * s, s };
}

/**
 * The pinch ends: the font it settled on (`f0 × s`, kept in `range`) and the pan that
 * keeps the same point under the fingers at it. `e0` are the extents at `f0`, `lines` how
 * many lines of scrollback were scrolled back meanwhile (it holds still during a pinch).
 * The size at the new font is predicted by scaling (the drawn one follows, viewport.ts
 * clamps to it).
 */
export function pinchEnd(f0: number, s: number, range: [number, number], t0: Point, p0: Point, p1: Point, e0: Extents, lines: number): View {
  const font = clamp(f0 * s, range[0], range[1]);
  const k = font / f0;
  const t = pinchTransform(t0, p0, p1, k);
  const e1: Extents = { ...e0, contentW: e0.contentW * k, contentH: e0.contentH * k, cellH: e0.cellH * k };
  return clampView({ font, x: -t.x, v: overflowOf(e1) + t.y + lines * e1.cellH }, e1);
}

/** Zoom to `font` around `p` (double-tap, a trackpad pinch): the pinch's end with nothing moving. */
export function zoomAt(view: View, font: number, p: Point, e: Extents, lines: number): View {
  const { shift } = place(view.v, e);
  const t0 = translateOf(view.x, shift, e);
  return pinchEnd(view.font, font / view.font, [ZOOM_MIN, Math.max(ZOOM_MAX, font)], t0, p, p, e, lines);
}
