import { describe, expect, it } from "vitest";
import { arrangeTiles, gridShape, moveInOrder } from "../src/renderer/src/model.ts";

const p = (id: string, createdAt: number) => ({ id, createdAt });

describe("grid slots", () => {
  it("keeps the remembered order, drops closed panes, appends new ones oldest first", () => {
    const panes = [p("a", 1), p("b", 2), p("c", 3), p("d", 4)];
    expect(arrangeTiles(["c", "gone", "a"], panes).map((x) => x.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("inserts the dragged tile and shifts the ones in between", () => {
    expect(moveInOrder(["a", "b", "c", "d"], "a", 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveInOrder(["a", "b", "c", "d"], "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveInOrder(["a", "b", "c"], "b", 9)).toEqual(["a", "c", "b"]);
    expect(moveInOrder(["a", "b", "c"], "b", 1)).toEqual(["a", "b", "c"]);
  });

  it("lays out as square as possible", () => {
    expect(gridShape(1)).toEqual({ cols: 1, rows: 1 });
    expect(gridShape(3)).toEqual({ cols: 2, rows: 2 });
    expect(gridShape(5)).toEqual({ cols: 3, rows: 2 });
  });
});

import { nextAfterClose, pushHistory } from "../src/renderer/src/model.ts";

describe("focus after close", () => {
  const alive = (...ids: string[]) => new Set(ids);

  it("returns to the most recently used terminal", () => {
    // visited a, then c; closing c goes back to a, not to its neighbour b
    const history = pushHistory(pushHistory([], "a"), "c");
    expect(nextAfterClose("c", history, ["a", "b", "c"], alive("a", "b"))).toBe("a");
  });

  it("falls back to the next neighbour in view order, then the previous one", () => {
    expect(nextAfterClose("b", [], ["a", "b", "c"], alive("a", "c"))).toBe("c");
    expect(nextAfterClose("c", [], ["a", "b", "c"], alive("a", "b"))).toBe("b");
  });

  it("skips history entries that are gone and handles closing the last terminal", () => {
    expect(nextAfterClose("b", ["b", "x", "a"], ["a", "b"], alive("a"))).toBe("a");
    expect(nextAfterClose("a", ["a"], ["a"], alive())).toBeNull();
  });

  it("keeps history most-recent-first, unique and capped", () => {
    expect(pushHistory(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushHistory(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });
});

import { formatBytes, usageLabel } from "../src/renderer/src/model.ts";

describe("usage labels", () => {
  it("formats bytes and hides idle CPU", () => {
    expect(formatBytes(412 * 1024 ** 2)).toBe("412 MB");
    expect(formatBytes(1.25 * 1024 ** 3)).toBe("1.3 GB");
    expect(usageLabel({ memory: 300 * 1024 ** 2, cpu: 0.4 })).toBe("300 MB");
    expect(usageLabel({ memory: 300 * 1024 ** 2, cpu: 12.6 })).toBe("300 MB · 13%");
  });
});
