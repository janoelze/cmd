import { describe, expect, it } from "vitest";
import {
  clampWidth,
  fullyVisible,
  landedOn,
  layout,
  maxWidth,
  nextPreset,
  revealOffset,
  snapPoints,
  snapTarget,
  widthFor,
} from "../src/renderer/src/strip.ts";

const G = 8;
const VP = 1000;

describe("strip geometry", () => {
  it("lays windows out left to right with gutters", () => {
    const { slots, total } = layout([400, 500, 300], G);
    expect(slots).toEqual([
      { x: 8, w: 400 },
      { x: 416, w: 500 },
      { x: 924, w: 300 },
    ]);
    expect(total).toBe(1232);
  });

  it("never makes a window wider than the pane", () => {
    expect(maxWidth(VP, G)).toBe(984);
    expect(clampWidth(5000, VP, G)).toBe(984);
    expect(clampWidth(100, VP, G)).toBe(320);
    expect(widthFor(1, VP, G)).toBe(984);
    expect(widthFor(0.5, VP, G)).toBe(492);
  });

  it("cycles PaperWM-style width presets", () => {
    expect(nextPreset(0.382)).toBe(0.5);
    expect(nextPreset(0.5)).toBe(0.618);
    expect(nextPreset(1)).toBe(0.382);
    expect(nextPreset(0.45)).toBe(0.5);
  });
});

describe("snapping", () => {
  const { slots, total } = layout([400, 500, 600], G); // total 1532, max offset 532
  const pts = snapPoints(slots, VP, G, total);

  it("offers window-edge alignments within the scroll range", () => {
    expect(pts[0]).toBe(0);
    expect(pts.at(-1)).toBe(532);
    expect(pts).toContain(408); // window 2 flush left
    expect(pts.every((p) => p >= 0 && p <= 532)).toBe(true);
  });

  it("settles on the nearest point when scrolling stopped slowly", () => {
    expect(snapTarget(30, pts, 0)).toBe(0);
    expect(snapTarget(400, pts, 0)).toBe(408);
  });

  it("carries on in the direction of a flick instead of falling back", () => {
    expect(snapTarget(30, pts, 1)).toBeGreaterThan(30);
    expect(snapTarget(400, pts, -1)).toBeLessThanOrEqual(400);
  });
});

describe("reveal", () => {
  const { slots, total } = layout([400, 500, 600], G);

  it("scrolls the least needed to show a window fully", () => {
    expect(revealOffset(0, slots[0]!, VP, G, total)).toBe(0); // already visible
    expect(revealOffset(0, slots[2]!, VP, G, total)).toBe(532); // flush right
    expect(revealOffset(532, slots[0]!, VP, G, total)).toBe(0); // flush left
    expect(fullyVisible(slots[1]!, 0, VP)).toBe(true);
    expect(fullyVisible(slots[2]!, 0, VP)).toBe(false);
  });

  it("knows which window the strip landed on", () => {
    expect(landedOn(slots, 532, VP, G, 1)).toBe(2); // moved right: rightmost flush window
    expect(landedOn(slots, 408, VP, G, -1)).toBe(1); // moved left: window flush with left edge
    expect(landedOn(slots, 0, VP, G, 0)).toBe(0);
  });
});
