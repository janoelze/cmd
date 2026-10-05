import { describe, expect, it } from "vitest";
import { nearPoint, placeTip } from "../src/tooltips.tsx";

const rect = (left: number, top: number, width = 20, height = 20) => ({ left, top, width, height, right: left + width, bottom: top + height });

describe("placeTip", () => {
  it("goes below an anchor in the upper part of the window, centred", () => {
    expect(placeTip(rect(100, 10), 60, 20, undefined, 800, 600)).toEqual({ side: "bottom", x: 80, y: 36 });
  });
  it("goes above an anchor in the lower part (the status bar)", () => {
    expect(placeTip(rect(100, 570), 60, 20, undefined, 800, 600)).toEqual({ side: "top", x: 80, y: 544 });
  });
  it("flips when the preferred side has no room", () => {
    expect(placeTip(rect(100, 10), 60, 20, "top", 800, 600).side).toBe("bottom");
    expect(placeTip(rect(5, 300), 60, 20, "left", 800, 600).side).toBe("right");
  });
  it("stays inside the window at the edges", () => {
    expect(placeTip(rect(790, 570, 10), 200, 20, undefined, 800, 600).x).toBe(800 - 200 - 8);
    expect(placeTip(rect(0, 10, 10), 200, 20, undefined, 800, 600).x).toBe(8);
  });
});

describe("nearPoint", () => {
  it("narrows a full-height edge to the pointer", () => {
    const edge = rect(400, 0, 6, 600);
    expect(nearPoint(edge, { x: 402, y: 450 })).toMatchObject({ left: 400, width: 6, top: 440, height: 20 });
    expect(placeTip(nearPoint(edge, { x: 402, y: 450 }), 60, 20, undefined, 800, 600)).toEqual({ side: "top", x: 373, y: 414 });
  });
  it("stays inside the anchor at its ends", () => {
    expect(nearPoint(rect(400, 0, 6, 600), { x: 402, y: 2 }).top).toBe(0);
    expect(nearPoint(rect(400, 0, 6, 600), { x: 402, y: 599 }).bottom).toBe(600);
  });
  it("leaves small anchors and keyboard focus alone", () => {
    expect(nearPoint(rect(100, 10), { x: 105, y: 15 })).toEqual(rect(100, 10));
    expect(nearPoint(rect(400, 0, 6, 600), null)).toEqual(rect(400, 0, 6, 600));
  });
});
