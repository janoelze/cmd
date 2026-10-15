// mergeEvents (widget-events.ts): an event recorded again under its key replaces the one before,
// within one burst too; events without a key are all kept; another key can be read.

import { describe, expect, it } from "vitest";
import { mergeEvents } from "../src/widget-events.ts";

const ev = (id: number, key?: string) => ({ id, ...(key ? { key } : {}) });

describe("mergeEvents", () => {
  it("replaces an event recorded again, the latest at the end", () => {
    expect(mergeEvents([ev(1, "a"), ev(2, "b"), ev(3)], [ev(4, "a")])).toEqual([ev(2, "b"), ev(3), ev(4, "a")]);
  });

  it("keeps the last of a key within the new ones (a start and an end in one burst)", () => {
    expect(mergeEvents([ev(1, "x")], [ev(2, "a"), ev(3, "b"), ev(4, "a")])).toEqual([ev(1, "x"), ev(3, "b"), ev(4, "a")]);
  });

  it("keeps every event without a key, and leaves the list as it was", () => {
    const list = [ev(1), ev(2, "a")];
    expect(mergeEvents(list, [ev(3), ev(4)])).toEqual([ev(1), ev(2, "a"), ev(3), ev(4)]);
    expect(list).toEqual([ev(1), ev(2, "a")]);
  });

  it("reads another key when told", () => {
    expect(mergeEvents([{ id: "c1", n: 1 }], [{ id: "c1", n: 2 }], (e) => e.id)).toEqual([{ id: "c1", n: 2 }]);
  });
});
