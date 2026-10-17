import { describe, expect, it } from "vitest";
import { afterClose, arrival, insertNew, liveOpeners, type Closing } from "../src/renderer/src/lib/placement.ts";

describe("where new windows go", () => {
  it("goes right after the window it was opened from", () => {
    expect(insertNew(["a", "b", "c"], "n", "a", [], "next")).toEqual(["a", "n", "b", "c"]);
  });

  it("goes behind the windows opened from the same one just before it, like tabs", () => {
    expect(insertNew(["a", "x", "y", "b"], "n", "a", ["x", "y"], "next")).toEqual(["a", "x", "y", "n", "b"]);
  });

  it("joins the run of its opener only until the selection moved elsewhere", () => {
    const here = ["a", "x", "b"].map((id, i) => ({ id, createdAt: i }));
    const view = { "grid.order": ["a", "x", "b"], "selection.pane": "a" };
    expect(arrival({ ...view, "openers.run": { opener: "a", ids: ["x"] } }, here, "n", null, "next")).toMatchObject({ "grid.order": ["a", "x", "n", "b"], "openers.run": { opener: "a", ids: ["x", "n"] } });
    expect(arrival({ ...view, "openers.run": null }, here, "n", null, "next")).toMatchObject({ "grid.order": ["a", "n", "x", "b"], openers: { n: "a" } });
  });

  it("leaves a reopened window where it was put back, and skips an opener in a sidebar", () => {
    const here = ["a", "b"].map((id, i) => ({ id, createdAt: i }));
    expect(arrival({ "grid.order": ["n", "a", "b"] }, here, "n", "a", "next")).toBeNull();
    expect(arrival({ "selection.pane": "a", docks: { left: { id: "a" } } }, here, "n", null, "next")).toEqual({ "grid.order": ["a", "b", "n"] });
  });

  it("goes at the end without an opener on the board, or when set to", () => {
    expect(insertNew(["a", "b"], "n", null, [], "next")).toEqual(["a", "b", "n"]);
    expect(insertNew(["a", "b"], "n", "gone", [], "next")).toEqual(["a", "b", "n"]);
    expect(insertNew(["a", "b"], "n", "a", [], "end")).toEqual(["a", "b", "n"]);
  });

  it("keeps openers only of windows that are still there", () => {
    expect(liveOpeners({ x: "a", y: "gone", gone: "a" }, (id) => id !== "gone")).toEqual({ x: "a" });
  });
});

describe("which window is selected after a close", () => {
  const alive = (...ids: string[]) => new Set(ids);
  const closing = (c: Partial<Closing> & { closed: string }): Closing => ({ history: [], order: [], alive: alive(), opener: null, ...c });

  it("selects the next window, else the previous one", () => {
    const order = ["a", "b", "c"];
    expect(afterClose(closing({ closed: "b", history: ["b", "a"], order, alive: alive("a", "c") }), "neighbour")).toBe("c");
    expect(afterClose(closing({ closed: "c", history: ["c", "a"], order, alive: alive("a", "b") }), "neighbour")).toBe("b");
  });

  it("goes back to the opener when closed without going anywhere else", () => {
    const order = ["a", "n", "b"];
    expect(afterClose(closing({ closed: "n", history: ["n", "a"], order, alive: alive("a", "b"), opener: "a" }), "neighbour")).toBe("a");
    // went to b and back: the next one instead
    expect(afterClose(closing({ closed: "n", history: ["n", "b", "a"], order, alive: alive("a", "b"), opener: "a" }), "neighbour")).toBe("b");
  });

  it("selects the nearest window on the canvas", () => {
    const rects = { a: { x: 0, y: 0, w: 10, h: 10 }, b: { x: 500, y: 0, w: 10, h: 10 }, c: { x: 0, y: 40, w: 10, h: 10 } };
    expect(afterClose(closing({ closed: "a", order: ["a", "b", "c"], alive: alive("b", "c"), rects }), "neighbour")).toBe("c");
  });

  it("selects the last one used when set to", () => {
    expect(afterClose(closing({ closed: "c", history: ["c", "a"], order: ["a", "b", "c"], alive: alive("a", "b") }), "recent")).toBe("a");
    expect(afterClose(closing({ closed: "b", order: ["a", "b", "c"], alive: alive("a", "c") }), "recent")).toBe("c");
  });

  it("selects nothing when nothing is left", () => {
    expect(afterClose(closing({ closed: "a", history: ["a"], order: ["a"] }), "neighbour")).toBeNull();
  });
});
