import { describe, expect, it } from "vitest";
import { MAX_SETUPS, parsePlacements, placementFor, record, setupKey, touch } from "../src/main/displays.ts";

// Window placement per display setup: docking and undocking puts windows back.

const laptop = { bounds: { x: 0, y: 0, width: 1512, height: 982 } };
const right = { bounds: { x: 1512, y: -200, width: 2560, height: 1440 } };
const left = { bounds: { x: -2560, y: -200, width: 2560, height: 1440 } };

describe("display setups", () => {
  it("keys a setup by its arrangement, in any order", () => {
    expect(setupKey([laptop, right])).toBe(setupKey([right, laptop]));
    expect(setupKey([laptop])).not.toBe(setupKey([laptop, right]));
  });

  it("counts the same monitor on the other side as another setup", () => {
    expect(setupKey([laptop, right])).not.toBe(setupKey([laptop, left]));
  });

  it("remembers each Space's window per setup", () => {
    const docked = setupKey([laptop, right]);
    const alone = setupKey([laptop]);
    let p = record({}, docked, "home", { x: 1600, y: 0, width: 1400, height: 900 });
    p = record(p, alone, "home", { x: 10, y: 30, width: 1200, height: 800, maximized: true });
    expect(placementFor(p, docked, "home")).toEqual({ x: 1600, y: 0, width: 1400, height: 900 });
    expect(placementFor(p, alone, "home")?.maximized).toBe(true);
    expect(placementFor(p, alone, "proj")).toBeUndefined();
  });

  it("keeps the most recently used setups", () => {
    let p = {};
    for (let i = 0; i < MAX_SETUPS + 3; i++) p = record(p, `s${i}`, "home", { width: 100, height: 100 });
    p = touch(p, "s3");
    const keys = Object.keys(p);
    expect(keys).toHaveLength(MAX_SETUPS);
    expect(keys.at(-1)).toBe("s3");
    expect(keys).not.toContain("s0");
    expect(keys).toContain(`s${MAX_SETUPS + 2}`);
  });

  it("reads back only valid placements", () => {
    expect(parsePlacements(null)).toEqual({});
    expect(parsePlacements({ a: { home: { width: 1, height: 2 }, bad: { x: 1 } }, b: 3 })).toEqual({ a: { home: { width: 1, height: 2 } } });
  });
});
