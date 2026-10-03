import { describe, expect, it } from "vitest";
import {
  arrange,
  CARD_ZOOM,
  DEFAULT_H,
  DEFAULT_W,
  DOT,
  frame,
  GAP,
  lerpCamera,
  MAX_ZOOM,
  MIN_H,
  MIN_W,
  overlaps,
  place,
  reveal,
  sized,
  toWorld,
  visible,
  zoomAt,
} from "../src/renderer/src/canvas.ts";

const vp = { w: 1000, h: 600 };

describe("camera", () => {
  it("zooms around the pointer", () => {
    const c = zoomAt({ x: 0, y: 0, zoom: 1 }, 2, 500, 300);
    expect(c.zoom).toBe(2);
    expect(toWorld(c, 500, 300)).toEqual({ x: 500, y: 300 });
  });

  it("clamps zoom", () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, 100, 0, 0).zoom).toBe(MAX_ZOOM);
  });

  it("interpolates around the viewport centre", () => {
    const a = { x: 0, y: 0, zoom: 1 };
    const b = { x: -500, y: -300, zoom: 0.5 }; // same centre, zoomed out
    const mid = lerpCamera(a, b, 0.5, vp);
    expect(toWorld(mid, 500, 300).x).toBeCloseTo(500);
    expect(lerpCamera(a, b, 1, vp)).toEqual(b);
  });
});

describe("placement", () => {
  it("starts at the origin", () => {
    expect(place([], null)).toEqual({ x: 0, y: 0, w: DEFAULT_W, h: DEFAULT_H });
  });

  it("goes right of the anchor, else below, never overlapping", () => {
    const a = { x: 0, y: 0, w: 400, h: 300 };
    expect(place([a], a)).toMatchObject({ x: 400 + GAP, y: 0 });
    const right = { x: 400 + GAP, y: 0, w: 400, h: 300 };
    const p = place([a, right], a);
    expect(p).toMatchObject({ x: 0, y: 300 + GAP });
    expect([a, right].some((r) => overlaps(p, r))).toBe(false);
  });

  it("lays out a first visit as a grid and keeps stored rects", () => {
    const first = arrange(["a", "b", "c"], {}, null);
    expect(first.changed).toBe(true);
    expect(first.rects.get("b")).toMatchObject({ x: DEFAULT_W + GAP, y: 0 });
    expect(first.rects.get("c")).toMatchObject({ x: 0, y: DEFAULT_H + GAP });

    const stored = { a: { x: 24, y: 48, w: 408, h: 312 } };
    const next = arrange(["a", "b"], stored, "a");
    expect(next.rects.get("a")).toEqual(stored.a);
    expect(next.rects.get("b")).toMatchObject({ x: 432 + GAP, y: 48 });
    expect(arrange(["a"], stored, null).changed).toBe(false);
  });

  it("snaps rects stored off the dot grid, and asks to store them", () => {
    const off = arrange(["a"], { a: { x: 10, y: 37, w: 400, h: 300 } }, null);
    expect(off.rects.get("a")).toEqual({ x: 0, y: 48, w: 408, h: 312 });
    expect(off.changed).toBe(true);
  });

  it("gives a new window the size of the selected one", () => {
    const stored = { a: { x: 0, y: 0, w: 480, h: 912 }, b: { x: 600, y: 0, w: 720, h: 456 } };
    expect(arrange(["a", "b", "c"], stored, "a").rects.get("c")).toMatchObject({ w: 480, h: 912 });
    expect(arrange(["b", "c"], { b: stored.b }, null).rects.get("c")).toMatchObject({ w: DEFAULT_W, h: DEFAULT_H });
  });
});

describe("framing", () => {
  const r = { x: 2000, y: 1000, w: 800, h: 400 };

  it("frames a rect centred, capped at the max zoom", () => {
    const c = frame({ x: 0, y: 0, w: 100, h: 100 }, vp, 1);
    expect(c.zoom).toBe(1);
    expect(visible(frame(r, vp, 1), r, vp)).toBe(true);
  });

  it("reveals with the smallest pan and keeps the zoom", () => {
    const cam = { x: 0, y: 0, zoom: 0.5 };
    const c = reveal(cam, r, vp);
    expect(c.zoom).toBe(0.5);
    expect(visible(c, r, vp)).toBe(true);
    expect(reveal(c, r, vp)).toBe(c); // already visible: no move
  });

  it("comes in to full size from card zoom", () => {
    const c = reveal({ x: 0, y: 0, zoom: CARD_ZOOM / 2 }, { x: 0, y: 0, w: 400, h: 300 }, vp);
    expect(c.zoom).toBe(1);
  });

  it("snaps to the dot grid and enforces a minimum size", () => {
    expect(sized({ x: 13, y: 3, w: 100, h: 1001 })).toEqual({ x: 24, y: 0, w: MIN_W, h: 1008 });
    for (const v of [DEFAULT_W, DEFAULT_H, MIN_W, MIN_H, GAP]) expect(v % DOT).toBe(0);
  });
});
