import { describe, expect, it } from "vitest";
import { aimAt, minJerk, moveDuration, planMove, taperProfile } from "../src/motion.ts";
import { rng } from "../src/random.ts";
import { gestureMs, planScroll } from "../src/scroll.ts";
import { planKeys, planTyping, TYPING } from "../src/typing.ts";

describe("motion", () => {
  it("times moves by Fitts' law, slowed and clamped", () => {
    expect(moveDuration(800, 40)).toBeCloseTo(1.3 * (130 + 157 * Math.log2(21)), 5);
    expect(moveDuration(20, 200)).toBeCloseTo(1.3 * (130 + 157 * Math.log2(1.1)), 5);
    expect(moveDuration(3, 400)).toBeGreaterThanOrEqual(160);
    expect(moveDuration(5000, 2)).toBe(1400);
    expect(moveDuration(1, 10)).toBe(0);
  });
  it("is still at both ends", () => {
    expect(minJerk(0)).toBe(0);
    expect(minJerk(1)).toBe(1);
    expect(minJerk(0.5)).toBeCloseTo(0.5);
  });
  it("ends exactly on the target, monotonic in time, same path for the same seed", () => {
    const a = planMove({ x: 0, y: 0 }, { x: 600, y: 300 }, 40, rng(1));
    const b = planMove({ x: 0, y: 0 }, { x: 600, y: 300 }, 40, rng(1));
    expect(a).toEqual(b);
    expect(a.at(-1)).toMatchObject({ x: 600, y: 300 });
    expect(a.every((s, i) => i === 0 || s.t > a[i - 1]!.t)).toBe(true);
    // Slow at the ends, fast in the middle.
    const step = (i: number) => Math.hypot(a[i + 1]!.x - a[i]!.x, a[i + 1]!.y - a[i]!.y);
    expect(step(0)).toBeLessThan(step(Math.floor(a.length / 2)));
  });
  it("peaks before halfway and tapers slowly, like people", () => {
    for (const q of [3.6, 4.6]) {
      const f = taperProfile(3, q);
      expect(f(0)).toBe(0);
      expect(f(1)).toBeCloseTo(1, 6);
      const speeds = Array.from({ length: 99 }, (_, i) => f((i + 1) / 100) - f(i / 100));
      const peak = speeds.indexOf(Math.max(...speeds)) / 100;
      expect(peak).toBeGreaterThan(0.33);
      expect(peak).toBeLessThan(0.46);
    }
  });
  it("corrects at the end of long moves, short ones go straight there", () => {
    const long = planMove({ x: 0, y: 0 }, { x: 900, y: 200 }, 30, rng(4));
    const gaps = long.slice(1).map((s, i) => s.t - long[i]!.t);
    expect(Math.max(...gaps)).toBeGreaterThan(10); // the pause before the correction
    expect(long.at(-1)).toMatchObject({ x: 900, y: 200 });
    const short = planMove({ x: 0, y: 0 }, { x: 60, y: 0 }, 30, rng(4));
    expect(Math.max(...short.slice(1).map((s, i) => s.t - short[i]!.t))).toBeLessThan(10);
  });
  it("aims inside the target, at the start of wide ones", () => {
    const r = rng(2);
    for (let i = 0; i < 100; i++) {
      const p = aimAt({ x: 100, y: 50, width: 400, height: 24 }, r);
      expect(p.x).toBeGreaterThanOrEqual(100 + 0.2 * 160);
      expect(p.x).toBeLessThanOrEqual(100 + 0.8 * 160);
      expect(p.y).toBeGreaterThan(50);
      expect(p.y).toBeLessThan(74);
    }
  });
});

describe("scroll", () => {
  const sum = (d: number) => planScroll(d).reduce((s, x) => s + x.dy, 0);
  it("travels exactly the distance, in whole pixels", () => {
    for (const d of [7, -30, 41, 300, -800, 2500, 9000]) {
      expect(sum(d)).toBe(d);
      expect(planScroll(d).every((s) => Number.isInteger(s.dy))).toBe(true);
    }
  });
  it("speeds up, then coasts and slows down", () => {
    const s = planScroll(600);
    expect(s[0]!.phase).toBe("began");
    expect(s.at(-1)!.phase).toBe("momentum-ended");
    const momentum = s.filter((x) => x.phase === "momentum");
    expect(momentum[0]!.dy).toBeGreaterThan(momentum.at(-1)!.dy);
    expect(gestureMs(s)).toBeGreaterThan(1000);
  });
  it("splits long distances into several flings", () => {
    expect(planScroll(9000).filter((x) => x.phase === "began").length).toBeGreaterThan(1);
    expect(planScroll(-20).some((x) => x.phase.startsWith("momentum"))).toBe(false);
  });
});

describe("typing", () => {
  it("is right-skewed above a floor, with pauses before words", () => {
    const d = planTyping("git commit -m 'first version of the tour'", rng(3));
    expect(d[0]).toBe(0);
    expect(Math.min(...d.slice(1))).toBeGreaterThanOrEqual(TYPING.terminal.floor);
    const sorted = d.slice(1).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    expect(mean).toBeGreaterThan(median);
  });
});

describe("typos", () => {
  const apply = (keys: string) => [...keys].reduce((out, k) => (k === "\b" ? out.slice(0, -1) : out + k), "");
  it("always end in the text as written", () => {
    for (let seed = 1; seed < 200; seed++) {
      const text = "git commit -m 'share trips with a link'";
      const k = planKeys(text, rng(seed), { ...TYPING.field, typo: 1 });
      expect(apply(k.keys)).toBe(text);
      expect(k.delays.length).toBe([...k.keys].length);
    }
  });
  it("happen sometimes, never with the exact profile", () => {
    const text = "the date picker on mobile";
    const typos = Array.from({ length: 200 }, (_, s) => planKeys(text, rng(s), TYPING.field).keys.includes("\b")).filter(Boolean).length;
    expect(typos).toBeGreaterThan(30);
    expect(typos).toBeLessThan(110);
    expect(Array.from({ length: 50 }, (_, s) => planKeys(text, rng(s), TYPING.exact).keys.includes("\b")).some(Boolean)).toBe(false);
  });
});

describe("idle speed-up", async () => {
  const { idleSegments } = await import("../src/post.ts");
  it("speeds up long input-free stretches, keeping their ends real-time", () => {
    const ev = (s: number) => ({ t: 1e9 + s * 1e9, type: "move" });
    const segs = idleSegments([ev(1), ev(2), ev(12), ev(13)], 1e9, 15, 4);
    expect(segs).toEqual([
      [0, 2.9, 1],
      [2.9, 11.1, 4],
      [11.1, 15, 1],
    ]);
    expect(idleSegments([ev(1), ev(2)], 1e9, 3, 4)).toEqual([[0, 3, 1]]);
  });
});
