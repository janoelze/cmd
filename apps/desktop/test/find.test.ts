import { describe, expect, it } from "vitest";
import { findCount, NO_FIND_OPTIONS } from "@cmd/ui";
import { findRegExp } from "../src/renderer/src/find.tsx";

const o = (p: Partial<typeof NO_FIND_OPTIONS> = {}) => ({ ...NO_FIND_OPTIONS, ...p });
const all = (q: string, text: string, opts = o()) => [...text.matchAll(findRegExp(q, opts)!)].map((m) => m[0]);

describe("findRegExp", () => {
  it("finds the text as typed, any case, regex characters literal", () => {
    expect(all("a.b", "a.b axb A.B")).toEqual(["a.b", "A.B"]);
  });
  it("honours Match Case, Whole Words and Regular Expression", () => {
    expect(all("Core", "core Core", o({ caseSensitive: true }))).toEqual(["Core"]);
    expect(all("core", "core coreHello", o({ wholeWord: true }))).toEqual(["core"]);
    expect(all("co.e", "core code", o({ regex: true }))).toEqual(["core", "code"]);
    expect(all("a|b", "a b c", o({ regex: true, wholeWord: true }))).toEqual(["a", "b"]);
  });
  it("is null for a regex still being typed", () => {
    expect(findRegExp("(core", o({ regex: true }))).toBeNull();
  });
});

describe("findCount", () => {
  it("says where you are, how many, or that there are none", () => {
    expect(findCount("", { index: 0, count: 3 })).toBeUndefined();
    expect(findCount("x", null)).toBeUndefined();
    expect(findCount("x", { index: -1, count: -1 })).toBeUndefined();
    expect(findCount("x", { index: 2, count: 17 })).toBe("3 of 17");
    expect(findCount("x", { index: -1, count: 17 })).toBe("17");
    expect(findCount("x", { index: -1, count: 1000, more: true })).toBe("1000+");
    expect(findCount("x", { index: -1, count: 0 })).toBe("No matches");
  });
});
