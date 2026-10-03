import os from "node:os";
import { describe, expect, it } from "vitest";
import type { CrashReport } from "@cmd/protocol/node";
import { payload, scrub, signature } from "../src/main/crash-format.ts";

const report = (o: Partial<CrashReport> = {}): CrashReport => ({
  id: "abc",
  time: "2026-10-04T00:00:00.000Z",
  process: "core",
  kind: "uncaughtException",
  message: "TypeError: Cannot read properties of undefined (reading 'pid')",
  stack: `TypeError: Cannot read properties of undefined\n    at PaneManager.kill (${os.homedir()}/src/cmd/packages/core/src/panes.ts:447:10)`,
  context: { version: "0.2.6", channel: "release", platform: "darwin 25.4.0 arm64", build: "abcdef" },
  log: [],
  ...o,
});

describe("crash reports", () => {
  it("replace home folders with ~", () => {
    expect(scrub(`${os.homedir()}/x and /Users/someone/y`)).toBe("~/x and ~/y");
    expect(scrub('"C:\\\\Users\\\\someone\\\\x"')).toBe('"~\\\\x"');
  });

  it("treat the same crash at other lines and paths as a repeat", () => {
    const a = signature(report());
    const b = signature(report({ stack: "TypeError: Cannot read properties of undefined\n    at PaneManager.kill (/elsewhere/panes.ts:450:3)" }));
    const other = signature(report({ message: "RangeError: Invalid array length" }));
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });

  it("make a Discord embed without the user's home", () => {
    const p = payload(report(), 3) as { embeds: { title: string; description: string; fields: { name: string; value: string }[] }[] };
    const e = p.embeds[0];
    expect(e.title).toBe("core: TypeError: Cannot read properties of undefined (reading 'pid')");
    expect(e.description).toContain("~/src/cmd/packages/core/src/panes.ts:447:10");
    expect(e.description).not.toContain(os.homedir());
    expect(e.fields.map((f) => f.name)).toEqual(["Version", "Process", "Platform", "build", "Repeats"]);
  });
});
