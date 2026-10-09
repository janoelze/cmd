import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EASE, EASE_EXIT, glide, GLIDE_EASING, GLIDE_MS, MOTION } from "../src/motion.ts";

const tokens = fs.readFileSync(path.join(import.meta.dirname, "../src/tokens.css"), "utf8");
const token = (name: string) => tokens.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();

describe("the glide", () => {
  it("runs from 0 to 1 without overshoot or a step back", () => {
    let last = -1;
    for (let ms = 0; ms <= GLIDE_MS + 50; ms += 4) {
      const p = glide(ms);
      expect(p).toBeGreaterThanOrEqual(last);
      expect(p).toBeLessThanOrEqual(1);
      last = p;
    }
    expect(glide(0)).toBe(0);
    expect(glide(GLIDE_MS)).toBe(1);
  });

  it("is most of the way there early, as a glide should feel", () => {
    expect(glide(100)).toBeGreaterThan(0.6);
    expect(glide(250)).toBeGreaterThan(0.98);
  });

  it("is the curve CSS uses: its points lie on the spring", () => {
    const points = [...GLIDE_EASING.matchAll(/([\d.]+) ([\d.]+)%/g)];
    expect(points.length).toBeGreaterThan(10);
    for (const [, v, at] of points) expect(Math.abs(glide((Number(at) / 100) * GLIDE_MS) - Number(v))).toBeLessThan(0.003);
  });
});

describe("MOTION and the tokens", () => {
  // CSS reads these as tokens, JS as MOTION: one set of values.
  it("has each timing as a token, equal", () => {
    expect(token("dur-fast")).toBe(`${MOTION.exit.ms}ms`);
    expect(token("dur")).toBe(`${MOTION.change.ms}ms`);
    expect(token("dur-slow")).toBe(`${MOTION.slow.ms}ms`);
    expect(token("glide-dur")).toBe(`${MOTION.glide.ms}ms`);
    expect(token("ease")).toBe(EASE);
    expect(token("ease-exit")).toBe(EASE_EXIT);
    expect(token("glide")).toBe(GLIDE_EASING);
    expect(MOTION.exit.easing).toBe(EASE_EXIT);
    expect(MOTION.change.easing).toBe(EASE);
  });
});
