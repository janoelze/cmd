import { describe, expect, it } from "vitest";
import { focusLayout, gridLayout, STRIP_BAR, stripLayout } from "../src/renderer/src/layouts.ts";

const vp = { w: 1000, h: 600 };

describe("grid layout", () => {
  const l = gridLayout(["a", "b", "c"], vp, 8); // 2×2

  it("places windows in cells with gutters", () => {
    expect(l.rects.get("a")).toEqual({ x: 8, y: 8, w: 488, h: 288 });
    expect(l.rects.get("c")).toEqual({ x: 8, y: 304, w: 488, h: 288 });
    expect(l.slots).toHaveLength(4);
  });

  it("maps the pointer to an insertion index (spare cell → last)", () => {
    expect(l.dropIndex(100, 100)).toBe(0);
    expect(l.dropIndex(900, 100)).toBe(1);
    expect(l.dropIndex(900, 500)).toBe(2);
  });
});

describe("strip layout", () => {
  const l = stripLayout(["a", "b"], [400, 700], vp, 8);

  it("stacks windows horizontally at full height", () => {
    expect(l.rects.get("a")).toEqual({ x: 8, y: 8, w: 400, h: 600 - 16 - STRIP_BAR });
    expect(l.rects.get("b")!.x).toBe(416);
    expect(l.contentWidth).toBe(1124);
    expect(l.resizable).toBe(true);
  });

  it("drops onto the window under the pointer, or the nearer one from a gutter", () => {
    expect(l.dropIndex(200, 0)).toBe(0);
    expect(l.dropIndex(900, 0)).toBe(1);
    expect(l.dropIndex(411, 0)).toBe(0);
    expect(l.dropIndex(414, 0)).toBe(1);
  });
});

describe("focus layout", () => {
  it("shows only the selected window, full size, without chrome; others keep their size", () => {
    const l = focusLayout(["a", "b"], "b", vp);
    expect(l.hidden).toEqual(new Set(["a"]));
    expect(l.rects.get("a")).toEqual({ x: 0, y: 0, w: 1000, h: 600 });
    expect(l.chrome).toBe(false);
    expect(l.dropIndex(1, 1)).toBe(-1);
  });
});
