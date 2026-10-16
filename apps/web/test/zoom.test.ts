// The phone's view of a Mac terminal as numbers (zoom.ts): which font it opens at,
// when it pans instead of shrinking, the vertical axis through screen and scrollback,
// and pinches and double-taps that keep what's under the fingers in place.
import { describe, expect, it } from "vitest";
import { anchors, clampView, doubleTap, fitSize, maxV, MIN_FONT, offsetOf, pinchEnd, pinchTransform, place, translateOf, zoomAt, zoomRange, type Extents } from "../src/zoom.ts";

const RATIO = { w: 0.6, h: 1.2 };

describe("the font a Mac terminal opens at", () => {
  it("a 100-column terminal on a phone in portrait: the text size, panning sideways, not 6.5 px", () => {
    const a = anchors(100, 381, RATIO, 11);
    expect(a.fit).toBeCloseTo(6.35, 1);
    expect(a.readable).toBe(11);
    expect(a.pans).toBe(true);
    expect(a.overview).toBeCloseTo(6.35, 1); // a pinch out (or a double-tap) still shows the whole width
  });

  it("never picks less than the minimum, whatever the text size says", () => {
    expect(anchors(100, 381, RATIO, 5).readable).toBe(MIN_FONT);
  });

  it("with room to spare (landscape, a narrow pane) it grows to fill the width, up to half again", () => {
    const land = anchors(100, 840, RATIO, 11);
    expect(land.readable).toBeCloseTo(14, 1);
    expect(land.pans).toBe(false);
    expect(land.overview).toBe(land.readable);
    expect(anchors(40, 840, RATIO, 11).readable).toBe(16.5);
  });

  it("measured cells count: a wider font pans sooner", () => {
    expect(anchors(60, 381, { w: 0.6, h: 1.2 }, 10).pans).toBe(false);
    expect(anchors(60, 381, { w: 0.7, h: 1.2 }, 10).pans).toBe(true);
  });

  it("a pinch goes out to the whole width and in past the text size", () => {
    const a = anchors(100, 381, RATIO, 11);
    const [lo, hi] = zoomRange(a);
    expect(lo).toBeCloseTo(a.overview);
    expect(hi).toBeGreaterThanOrEqual(32);
  });

  it("double-tap: readable ↔ the whole width; when it all fits, readable ↔ closer", () => {
    const a = anchors(100, 381, RATIO, 11);
    expect(doubleTap(11, a)).toBeCloseTo(a.overview);
    expect(doubleTap(a.overview, a)).toBe(11);
    expect(doubleTap(20, a)).toBe(11);
    const fits = anchors(50, 381, RATIO, 11);
    expect(doubleTap(fits.readable, fits)).toBeCloseTo(fits.readable * 1.6);
  });

  it("Fit to This Phone: the grid that fills the screen at the text size, in the range the Mac takes", () => {
    expect(fitSize(381, 600, RATIO, 11)).toEqual({ cols: 57, rows: 45 });
    expect(fitSize(100, 20, RATIO, 11)).toEqual({ cols: 20, rows: 5 });
  });
});

// A 100×30 terminal at 11 px (cells 6.6 × 13.2) in a 393 × 300 view, 50 lines of scrollback.
const E: Extents = { contentW: 672, contentH: 404, viewW: 393, viewH: 300, cellH: 13.2, base: 50 };

describe("up and down: the screen, then the scrollback", () => {
  it("v 0 is the latest line, the screen's bottom at the view's", () => {
    expect(place(0, E)).toEqual({ shift: 0, line: 50 });
    expect(translateOf(0, 0, E)).toEqual({ x: -0, y: -104 });
  });

  it("the screen's overflow moves first, then whole lines of history", () => {
    expect(place(60, E)).toEqual({ shift: 60, line: 50 });
    expect(place(104, E)).toEqual({ shift: 104, line: 50 });
    expect(place(104 + 13.2 * 3, E)).toEqual({ shift: 104, line: 47 });
    expect(place(1e6, E)).toEqual({ shift: 104, line: 0 });
    expect(maxV(E)).toBeCloseTo(104 + 50 * 13.2);
  });

  it("what shows maps back to the same v (output arriving keeps the place)", () => {
    const v = 104 + 13.2 * 7;
    const p = place(v, E);
    expect(offsetOf(p.shift, p.line, E)).toBeCloseTo(v);
    // Ten lines arrived: xterm keeps the first line shown, so the view is ten lines further up.
    const later = { ...E, base: 60 };
    expect(offsetOf(p.shift, p.line, later)).toBeCloseTo(v + 10 * 13.2);
  });

  it("panning stops at the edges", () => {
    expect(clampView({ font: 11, x: -20, v: -5 }, E)).toEqual({ font: 11, x: 0, v: 0 });
    expect(clampView({ font: 11, x: 999, v: 0 }, E).x).toBe(672 - 393);
  });
});

describe("pinch and double-tap keep what's under the fingers", () => {
  it("drawn as a transform: the point under the midpoint stays there", () => {
    const t0 = { x: -50, y: -104 };
    const p = { x: 200, y: 150 };
    const t = pinchTransform(t0, p, p, 2);
    // A point of the terminal at local (250, 254) was under p; at scale 2 it's at t + 2·local.
    expect(t.x + 250 * 2).toBeCloseTo(200);
    expect(t.y + 254 * 2).toBeCloseTo(150);
  });

  it("ends at the font it reached and the pan that keeps the point there", () => {
    const t0 = translateOf(50, 0, E);
    const p = { x: 200, y: 150 };
    const v = pinchEnd(11, 1.5, [3, 32], t0, p, p, E, 0);
    expect(v.font).toBeCloseTo(16.5);
    // Column under the finger: (50 + 200) / 6.6 = 37.9 before, (x + 200) / 9.9 after.
    expect((v.x + 200) / 9.9).toBeCloseTo((50 + 200) / 6.6, 1);
  });

  it("stops at the range's ends", () => {
    const p = { x: 0, y: 0 };
    expect(pinchEnd(11, 10, [3, 32], { x: 0, y: 0 }, p, p, E, 0).font).toBe(32);
    expect(pinchEnd(11, 0.01, [6, 32], { x: 0, y: 0 }, p, p, E, 0).font).toBe(6);
  });

  it("moving the fingers while pinching pans as well", () => {
    const t0 = translateOf(100, 0, E);
    const v = pinchEnd(11, 1, [3, 32], t0, { x: 200, y: 150 }, { x: 150, y: 150 }, E, 0);
    expect(v.x).toBeCloseTo(150);
  });

  it("zooming in on a point of the scrollback stays in the scrollback", () => {
    const v0 = { font: 11, x: 0, v: 104 + 13.2 * 10 };
    const v1 = zoomAt(v0, 22, { x: 0, y: 0 }, E, 10);
    // The top line shown was line 40 of the buffer: at twice the font it's still the top one.
    const e1 = { ...E, contentW: E.contentW * 2, contentH: E.contentH * 2, cellH: E.cellH * 2 };
    expect(place(v1.v, e1).line).toBe(40);
  });
});
