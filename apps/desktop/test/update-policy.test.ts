// The updater's decisions (main/update-policy.ts), the blocklist installed apps read from
// master, and main's entry (main/index.ts) staying small enough to rescue a broken app.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isNewer, onFound, parseBlocklist } from "../src/main/update-policy.ts";

const root = path.join(import.meta.dirname, "../../..");

describe("update policy", () => {
  it("orders versions", () => {
    expect(isNewer("0.32.1", "0.32.0")).toBe(true);
    expect(isNewer("0.32.0", "0.32.1")).toBe(false);
    expect(isNewer("0.32.0", "0.32.0")).toBe(false);
    expect(isNewer("0.40.0", "0.32.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.33.0", "0.33.0-beta.1")).toBe(true);
    expect(isNewer("0.33.0-beta.2", "0.33.0-beta.1")).toBe(true);
  });

  it("replaces a download only with a newer version", () => {
    expect(onFound("0.32.1", null)).toBe("download");
    expect(onFound("0.32.1", "0.32.0")).toBe("download");
    expect(onFound("0.32.1", "0.32.1")).toBe("keep");
    expect(onFound("0.32.0", "0.32.1")).toBe("keep");
  });

  it("reads a blocklist, ignoring what isn't one", () => {
    expect([...parseBlocklist('{"versions":{"0.32.0":"broken","nope":"x","0.31.0":1}}')]).toEqual([
      ["0.32.0", "broken"],
      ["0.31.0", ""],
    ]);
    expect(parseBlocklist("<html>").size).toBe(0);
    expect(parseBlocklist('{"versions":["0.32.0"]}').size).toBe(0);
    expect(parseBlocklist("null").size).toBe(0);
  });

  it("blocks only real releases, from a blocklist the apps can read", () => {
    const text = fs.readFileSync(path.join(root, "updates/blocked-versions.json"), "utf8");
    const listed = Object.keys((JSON.parse(text) as { versions: Record<string, string> }).versions);
    const blocked = parseBlocklist(text);
    expect([...blocked.keys()]).toEqual(listed);
    const released = new Set([...fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8").matchAll(/^## (\S+) — /gm)].map((m) => m[1]));
    expect(listed.filter((v) => !released.has(v))).toEqual([]);
    for (const why of blocked.values()) expect(why).not.toBe("");
  });
});

describe("main's entry", () => {
  it("imports nothing up front, so a broken app can still update", () => {
    // index.ts loads app.ts and, failing that, the updater's rescue: both dynamically, so a
    // module app.ts can't load is caught instead of stopping main before any of it runs.
    const entry = fs.readFileSync(path.join(root, "apps/desktop/src/main/index.ts"), "utf8");
    expect(entry.match(/^\s*(import|export)\b[^(]/gm) ?? []).toEqual([]);
    expect(entry).toContain('import("./app.ts")');
  });
});
