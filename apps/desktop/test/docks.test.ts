import { describe, expect, it } from "vitest";
import { dock, dockedIds, dockWidths, DOCK_WIDTH, EMPTY_DOCKS, liveDocks, MIN_WORKSPACE, readDocks, shownIds, sideOf, undock } from "../src/renderer/src/docks.ts";

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

  it("sends the window that held a side back to the workspace", () => {
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

  it("sizes sides within limits, keeping room for the workspace", () => {
    const d = { left: { id: "a", width: null, hidden: false }, right: { id: "b", width: 9999, hidden: false } };
    expect(dockWidths(d, 2000)).toEqual({ left: DOCK_WIDTH.default, right: DOCK_WIDTH.max });
    // Narrow: the right side gives way first, never below its minimum.
    const narrow = dockWidths(d, DOCK_WIDTH.default + DOCK_WIDTH.min + MIN_WORKSPACE + 10);
    expect(narrow).toEqual({ left: DOCK_WIDTH.default, right: DOCK_WIDTH.min + 10 });
    expect(dockWidths(d, 500)).toEqual({ left: DOCK_WIDTH.min, right: DOCK_WIDTH.min });
    expect(dockWidths({ ...d, right: { ...d.right, hidden: true } }, 2000).right).toBe(0);
  });
});
