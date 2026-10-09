// The product page's feature grid (website/public/_lib/features.json): keeps
// every entry as snappy as the rest, so the grid stays even as the release
// skill adds to it.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FILE = path.join(import.meta.dirname, "../public/_lib/features.json");
const { features } = JSON.parse(fs.readFileSync(FILE, "utf8")) as { features: Feature[] };

interface Feature {
  title: string;
  text: string;
  badge?: string;
}

/** Hard caps, not targets. Lengths count what the page shows (no backticks). */
const LIMITS = {
  title: 26,
  text: 130,
  sentences: 2,
  features: { min: 9, max: 21 }, // three to a row, so a multiple of 3
  badges: 2,
  badgeWords: ["Beta", "New"],
};

const shown = (s: string) => s.replace(/`/g, "");
const sentences = (s: string) => shown(s).split(/[.!?](?:\s|$)/).filter((x) => x.trim()).length;

describe("website features", () => {
  it("fills the grid evenly", () => {
    expect(features.length).toBeGreaterThanOrEqual(LIMITS.features.min);
    expect(features.length).toBeLessThanOrEqual(LIMITS.features.max);
    expect(features.length % 3).toBe(0);
  });

  it("has unique titles", () => {
    expect(new Set(features.map((f) => f.title.toLowerCase())).size).toBe(features.length);
  });

  it.each(features.map((f) => [f.title, f] as const))("%s is snappy", (_, f) => {
    expect(Object.keys(f).filter((k) => !["title", "text", "badge"].includes(k))).toEqual([]);
    expect(f.title.trim()).not.toBe("");
    expect(shown(f.title).length, `title over ${LIMITS.title} characters`).toBeLessThanOrEqual(LIMITS.title);
    expect(f.title).not.toMatch(/[.!?:]$/);
    expect(shown(f.text).length, `text over ${LIMITS.text} characters`).toBeLessThanOrEqual(LIMITS.text);
    expect(sentences(f.text), `more than ${LIMITS.sentences} sentences`).toBeLessThanOrEqual(LIMITS.sentences);
    expect(f.text).toMatch(/\.$/);
    expect(f.text + f.title, "no HTML: `code` renders as <code>").not.toMatch(/[<>]/);
    expect((f.text.match(/`/g) ?? []).length % 2, "unbalanced backticks").toBe(0);
    if (f.badge !== undefined) expect(LIMITS.badgeWords).toContain(f.badge);
  });

  it(`badges at most ${LIMITS.badges} features`, () => {
    expect(features.filter((f) => f.badge).length).toBeLessThanOrEqual(LIMITS.badges);
  });
});
