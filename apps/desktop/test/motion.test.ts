import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { glide, GLIDE_MS } from "../src/renderer/src/motion.ts";

describe("glide", () => {
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

  it("lasts as long as the CSS curve that samples it", () => {
    const css = fs.readFileSync(path.join(import.meta.dirname, "../../../packages/ui/src/tokens.css"), "utf8");
    expect(Number(css.match(/--glide-dur:\s*(\d+)ms/)?.[1])).toBe(GLIDE_MS);
    // The CSS curve's points lie on the spring.
    const points = [...css.match(/--glide:\s*linear\(([^)]*)\)/)![1]!.matchAll(/([\d.]+) ([\d.]+)%/g)];
    for (const [, v, at] of points) expect(Math.abs(glide((Number(at) / 100) * GLIDE_MS) - Number(v))).toBeLessThan(0.003);
  });
});
