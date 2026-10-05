import { describe, expect, it } from "vitest";
import { focusLayout, gridLayout, stripLayout } from "../src/renderer/src/layouts.ts";

const vp = { w: 1000, h: 600 };
const even = { x: 8, y: 8, gap: 8 };

describe("grid layout", () => {
  const l = gridLayout(["a", "b", "c"], vp, even); // 2×2

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

  it("pads the edges and spaces the windows independently", () => {
    const g = gridLayout(["a", "b", "c", "d"], vp, { x: 20, y: 10, gap: 4 });
    expect(g.rects.get("a")).toEqual({ x: 20, y: 10, w: 478, h: 288 });
    expect(g.rects.get("d")).toEqual({ x: 502, y: 302, w: 478, h: 288 }); // ends 20 / 10 from the edges
    expect(g.dropIndex(499, 0)).toBe(0); // left of the gap's middle
    expect(g.dropIndex(501, 0)).toBe(1);
  });
});

describe("strip layout", () => {
  const l = stripLayout(["a", "b"], [400, 700], vp, even);

  it("stacks windows horizontally at full height", () => {
    expect(l.rects.get("a")).toEqual({ x: 8, y: 8, w: 400, h: 600 - 16 });
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

  it("pads the edges and spaces the windows independently", () => {
    const s = stripLayout(["a", "b"], [400, 700], vp, { x: 20, y: 10, gap: 4 });
    expect(s.rects.get("a")).toEqual({ x: 20, y: 10, w: 400, h: 600 - 20 });
    expect(s.rects.get("b")!.x).toBe(424);
    expect(s.contentWidth).toBe(20 + 400 + 4 + 700 + 20);
  });

  it("fills the height with no padding: the page dots are in the footer", () => {
    const s = stripLayout(["a"], [400], vp, { x: 0, y: 0, gap: 0 });
    expect(s.rects.get("a")!.h).toBe(600);
  });
});

describe("focus layout", () => {
  it("shows only the selected window, full size, without chrome; others keep their size", () => {
    const l = focusLayout(["a", "b"], "b", vp, even);
    expect(l.hidden).toEqual(new Set(["a"]));
    // Maximized, but still a window: the usual margins and its title bar.
    expect(l.rects.get("a")).toEqual({ x: 8, y: 8, w: 984, h: 584 });
    expect(l.chrome).toBe(true);
    expect(l.dropIndex(1, 1)).toBe(-1);
  });
});
