import { describe, expect, it } from "vitest";
import { buildContext, cutMiddle } from "../src/ai/context.ts";

describe("context builder", () => {
  it("keeps fixed parts, shares the rest by weight and gives back what a small part doesn't need", () => {
    const r = buildContext({
      purpose: "t",
      budget: 1000,
      separator: "",
      parts: [
        { name: "facts", text: "F".repeat(200), fixed: true },
        { name: "small", text: "s".repeat(50) },
        { name: "big", text: "b".repeat(5000), weight: 3 },
      ],
    });
    const [facts, small, big] = r.record.parts;
    expect(facts).toMatchObject({ chars: 200, cut: false });
    expect(small).toMatchObject({ chars: 50, cut: false });
    expect(big!.cut).toBe(true);
    expect(big!.chars).toBeLessThanOrEqual(750);
    expect(big!.chars).toBeGreaterThan(600); // the small part's unused share went to it
    expect(r.text.length).toBeLessThanOrEqual(1000);
  });

  it("redacts every part, counts it, and hashes what was sent", () => {
    const r = buildContext({ purpose: "t", budget: 500, parts: [{ name: "cmd", text: "export TOKEN=abcdefghijklmnop", events: ["command:1", "command:2"] }] });
    expect(r.text).toBe("export TOKEN=[redacted]");
    expect(r.record.parts[0]).toMatchObject({ redacted: 1, events: 2 });
    expect(r.record.events).toEqual(["command:1", "command:2"]);
    expect(r.record.hash).toHaveLength(16);
    expect(buildContext({ purpose: "t", budget: 500, parts: [{ name: "cmd", text: "export TOKEN=abcdefghijklmnop" }] }).record.hash).toBe(r.record.hash);
  });

  it("lets a part fit itself into its share", () => {
    const asked: number[] = [];
    const r = buildContext({ purpose: "t", budget: 300, separator: "", parts: [{ name: "h", text: "x".repeat(100), fixed: true }, { name: "conv", fit: (max) => (asked.push(max), "y".repeat(Math.min(max, 1000))) }] });
    expect(asked).toEqual([200]);
    expect(r.record.parts[1]!.chars).toBe(200);
  });

  it("cuts the middle, keeping the start and the end", () => {
    const t = `START ${"m".repeat(1000)} END`;
    const c = cutMiddle(t, 200);
    expect(c.startsWith("START")).toBe(true);
    expect(c.endsWith("END")).toBe(true);
    expect(c.length).toBeLessThanOrEqual(200);
    expect(c).toMatch(/characters left out/);
  });
});
