// Live Code's music features (livecode/analyze.ts) on events built by hand.
import { describe, expect, it } from "vitest";
import { analyze, GENRES, score, type Ev } from "../src/livecode/analyze.ts";

/** Events at 16th steps over `bars` bars: `at(bar)` lists [step, sound, midi?]. */
function make(bars: number, at: (bar: number) => [number, string, number?][]): Ev[] {
  const out: Ev[] = [];
  for (let bar = 0; bar < bars; bar++) for (const [step, sound, midi] of at(bar)) out.push({ b: bar + step / 16, e: bar + (step + 1) / 16, sound, ...(midi !== undefined ? { midi } : {}) });
  return out;
}

const twoStep = (): [number, string, number?][] => [[0, "rolandtr909_bd"], [10, "rolandtr909_bd"], [4, "rolandtr909_sd"], [12, "rolandtr909_sd"], ...[0, 2, 4, 6, 8, 10, 12, 14].map((s): [number, string] => [s, "rolandtr909_hh"])];

describe("analyze", () => {
  it("hears a DnB two-step as the genre's groove", () => {
    const f = analyze(make(8, twoStep), 8, 174, GENRES.dnb);
    expect(f.groove).toBe(1);
    expect(f.drums).toEqual({ kick: true, snare: true, hats: true, break: false });
  });

  it("hears four-on-the-floor as off the DnB groove", () => {
    const f = analyze(make(8, () => [0, 4, 8, 12].map((s): [number, string] => [s, "bd"])), 8, 174, GENRES.dnb);
    expect(f.groove!).toBeLessThan(0.5);
  });

  it("finds the key, the notes outside it, chords and the bass register", () => {
    // A minor: chords a-c-e, a bass on A1 (33), one F# outside the key.
    const ev = make(4, () => [[0, "supersaw", 57], [0, "supersaw", 60], [0, "supersaw", 64], [0, "sine", 33], [8, "piano", 69], [12, "piano", 72], [14, "piano", 66]]);
    const f = analyze(ev, 4, 120);
    expect(f.key).toBe("A minor");
    expect(f.chordSize).toBe(3);
    expect(f.bassMedian).toBe(33);
    expect(f.outOfKey!).toBeGreaterThan(0);
    expect(f.outOfKey!).toBeLessThan(0.2);
  });

  it("calls a one-bar loop static, and parts coming in an arrangement", () => {
    const loop = analyze(make(16, twoStep), 16, 174);
    expect(loop.variety).toBe(1 / 16);
    expect(loop.sectionChanges).toBe(0);
    const built = analyze(make(16, (bar) => [...twoStep(), ...(bar >= 8 ? [[0, "supersaw", 50] as [number, string, number]] : [])]), 16, 174);
    expect(built.sectionChanges).toBe(1);
  });

  it("scores a sub below E1 and heavy distortion down", () => {
    const ev = make(4, () => [[0, "sine", 22], [0, "bd"], [4, "sd"]]).map((e) => ({ ...e, distort: 1.5 }));
    const s = score(analyze(ev, 4, 174, GENRES.dnb), GENRES.dnb, 0);
    expect(s.checks.find((c) => c.name === "bass")!.score).toBeLessThan(0.6);
    expect(s.checks.find((c) => c.name === "mix")!.score).toBeLessThanOrEqual(0.5);
  });
});
