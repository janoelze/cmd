// @vitest-environment happy-dom
// API 1.3's `fmt` additions (docs/57 A11) print what the native views print, because they are
// the native views' functions: `fmt.value` and `fmt.delta` the Stats window's formatValue and
// formatDelta, `fmt.hue` the app's projectHue (lib/model.ts), coarse `fmt.dur` the app's
// durationText (lib/widgets.ts). The app's names are re-exports of protocol format.ts, the
// module @cmd/widget-api's fmt calls: one function, never a copy.
import { describe, expect, it, vi } from "vitest";
import * as format from "@cmd/protocol/format";
import { formatDelta, formatValue, type StatUnit } from "@cmd/protocol";
import { fmt } from "@cmd/widget-api";

vi.mock("../src/renderer/src/lib/bridge.ts", () => ({ cmd: new Proxy({}, { get: () => () => new Promise(() => {}) }) }));
const { projectHue } = await import("../src/renderer/src/lib/model.ts");
const { durationText } = await import("../src/renderer/src/lib/widgets.ts");

const UNITS: StatUnit[] = ["count", "ms", "bytes", "tokens", "percent"];
const VALUES = [0, 0.4, 3, 12.5, 950, 1234, 18_000, 3_600_000, 11_520_000, 2.9e9];

describe("fmt's 1.3 helpers are the app's formatters", () => {
  it("are the same functions the app calls, not copies", () => {
    expect(projectHue).toBe(format.projectHue);
    expect(durationText).toBe(format.durationText);
    expect(formatValue).toBe(format.formatValue);
    expect(formatDelta).toBe(format.formatDelta);
  });

  it("fmt.value writes a value as the Stats window does, long and short", () => {
    for (const unit of UNITS)
      for (const v of VALUES) {
        expect(fmt.value(v, unit)).toBe(formatValue(v, unit));
        expect(fmt.value(v, unit, { short: true })).toBe(formatValue(v, unit, true));
      }
    expect(fmt.value(11_520_000, "ms")).toBe("3h 12m");
    expect(fmt.value(1234)).toBe(formatValue(1234, "count"));
  });

  it("fmt.delta writes a change as the Stats window's tiles do", () => {
    const pairs: [number, number][] = [
      [118, 100],
      [96, 100],
      [100, 100],
      [5, 0],
      [0, 0],
      [12.5, 10],
    ];
    for (const unit of [undefined, ...UNITS]) for (const [cur, prev] of pairs) expect(fmt.delta(cur, prev, unit)).toBe(formatDelta(cur, prev, unit));
    expect(fmt.delta(118, 100)).toBe("+18%");
    expect(fmt.delta(12.5, 10, "percent")).toBe("+2.5 pt");
  });

  it("fmt.hue gives a name the hue its project has in every window", () => {
    for (const name of ["cmd", "cmd-perf", "site", "agents", "", "ünïcode"]) expect(fmt.hue(name)).toBe(projectHue(name));
  });

  it("fmt.dur with coarse says a duration as the app's lists do; without it, as 1.0 did", () => {
    for (const s of [0, 0.4, 4, 59, 60, 420, 3900, 7200]) expect(fmt.dur(s, { coarse: true })).toBe(durationText(s * 1000));
    expect(fmt.dur(420, { coarse: true })).toBe("7 min");
    expect(fmt.dur(3900, { coarse: true })).toBe("1 h 5 min");
    expect(fmt.dur(243)).toBe("4m 3s");
    expect(fmt.dur(null, { coarse: true })).toBe("0 s");
  });
});
