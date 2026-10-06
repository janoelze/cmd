import { describe, expect, it } from "vitest";
import { scoreDay, type JournalCase } from "../src/journal/eval.ts";

const c: JournalCase = { name: "t", digest: "", groups: [["S1", "B1"], ["R1"], ["T1"]], minor: ["S9"], mention: ["release"], entries: [2, 5] };

describe("journal eval", () => {
  it("gives a good answer full marks", () => {
    const s = scoreDay(c, {
      headline: "Shipped the release and fixed the cart.",
      entries: [
        { refs: ["S1", "B1"], kind: "fix", title: "Cart total fix", summary: "Fixed rounding in the cart total.", outcome: "merged" },
        { refs: ["R1"], kind: "release", title: "Released v1.2", summary: "The release shipped the cart fix.", outcome: "shipped" },
        { refs: ["T1", "S9"], kind: "ops", title: "Local database reset", summary: "Reset the local database.", outcome: null },
      ],
    });
    expect(s.score).toBe(1);
    expect(s.problems).toEqual([]);
  });

  it("finds made-up refs, groups left out, long titles and what it doesn't mention", () => {
    const s = scoreDay(c, {
      headline: "A day.",
      entries: [{ refs: ["S1", "X7"], kind: "fix", title: "Worked on fixing the cart total in the shop", summary: "Fixed it.", outcome: null }],
    });
    expect(s.score).toBeLessThan(0.7);
    expect(s.problems.join(" | ")).toMatch(/unknown refs: X7.*groups left out: R1, T1.*isn't 2–4 words.*mention "release".*1 entries/);
  });
});
