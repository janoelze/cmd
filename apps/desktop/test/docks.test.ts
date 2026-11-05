import { describe, expect, it } from "vitest";
import { dock, dockedIds, dockWidths, DOCK_STEP, DOCK_WIDTH, EMPTY_DOCKS, liveDocks, MIN_BOARD, nextDockPreset, readDocks, resizeDock, shownIds, sideOf, stepDock, undock } from "../src/renderer/src/shell/board/docks.ts";

describe("sidebars", () => {
  it("reads stored values, filling in what's missing", () => {
    expect(readDocks(null)).toEqual(EMPTY_DOCKS);
    expect(readDocks({ left: { id: "nav", width: 300 } })).toEqual({
      left: { id: "nav", width: 300, hidden: false },
      right: { id: null, width: null, hidden: false },
    });
  });

  it("docks a window to one side at a time", () => {
    const a = dock(EMPTY_DOCKS, "files", "left");
    expect(sideOf(a, "files")).toBe("left");
    const b = dock(a, "files", "right");
    expect(b.left.id).toBeNull();
    expect(sideOf(b, "files")).toBe("right");
  });

  it("sends the window that held a side back to the board", () => {
    const d = dock(dock(EMPTY_DOCKS, "nav", "left"), "files", "left");
    expect(d.left.id).toBe("files");
    expect(dockedIds(d).has("nav")).toBe(false);
  });

  it("docking shows a hidden side; undocking keeps its width", () => {
    const hidden = { ...EMPTY_DOCKS, left: { id: null, width: 320, hidden: true } };
    const d = dock(hidden, "nav", "left");
    expect(d.left).toEqual({ id: "nav", width: 320, hidden: false });
    expect(undock(d, "nav").left).toEqual({ id: null, width: 320, hidden: false });
    expect(undock(d, "other")).toBe(d);
  });

  it("treats closed windows as empty sides", () => {
    const d = liveDocks(dock(dock(EMPTY_DOCKS, "nav", "left"), "gone", "right"), (id) => id === "nav");
    expect(d.left.id).toBe("nav");
    expect(d.right.id).toBeNull();
  });

  it("hidden sides are docked but not shown", () => {
    const d = { ...dock(EMPTY_DOCKS, "nav", "left"), right: { id: "ci", width: null, hidden: true } };
    expect([...shownIds(d)]).toEqual(["nav"]);
    expect([...dockedIds(d)].sort()).toEqual(["ci", "nav"]);
  });

  it("sizes sides within limits, keeping room for the board", () => {
    const d = { left: { id: "a", width: null, hidden: false }, right: { id: "b", width: 9999, hidden: false } };
    expect(dockWidths(d, 2000)).toEqual({ left: DOCK_WIDTH.default, right: DOCK_WIDTH.max });
    // Narrow: the right side gives way first, never below its minimum.
    const narrow = dockWidths(d, DOCK_WIDTH.default + DOCK_WIDTH.min + MIN_BOARD + 10);
    expect(narrow).toEqual({ left: DOCK_WIDTH.default, right: DOCK_WIDTH.min + 10 });
    expect(dockWidths(d, 500)).toEqual({ left: DOCK_WIDTH.min, right: DOCK_WIDTH.min });
    expect(dockWidths({ ...d, right: { ...d.right, hidden: true } }, 2000).right).toBe(0);
  });

  it("steps a sidebar's width from the one it shows, within what dragging allows (⌥⌘+ / ⌥⌘−, ⌃⌘R)", () => {
    const d = dock(dock(EMPTY_DOCKS, "files", "left"), "notes", "right");
    const wider = resizeDock(d, "right", 1440, (px) => stepDock(px, 1));
    expect(wider.right.width).toBe(DOCK_WIDTH.default + DOCK_STEP);
    expect(wider.left).toEqual(d.left);
    // Never past max or min.
    expect(resizeDock({ ...d, right: { ...d.right, width: DOCK_WIDTH.max } }, "right", 1440, (px) => stepDock(px, 1)).right.width).toBe(DOCK_WIDTH.max);
    expect(resizeDock({ ...d, left: { ...d.left, width: DOCK_WIDTH.min } }, "left", 1440, (px) => stepDock(px, -1)).left.width).toBe(DOCK_WIDTH.min);
    // The board keeps MIN_BOARD beside the other side.
    expect(resizeDock(d, "right", 900, () => 10_000).right.width).toBe(900 - MIN_BOARD - DOCK_WIDTH.default);
    // Presets cycle and wrap.
    expect(nextDockPreset(DOCK_WIDTH.default)).toBe(DOCK_WIDTH.max);
    expect(nextDockPreset(DOCK_WIDTH.max)).toBe(DOCK_WIDTH.min);
  });
});
