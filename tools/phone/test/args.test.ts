// The phone driver's command line: commands, flags and the values they take, keys, targets.
import { describe, expect, it } from "vitest";
import { isSelector, keyName, parseArgs, parseCore } from "../src/args.ts";

describe("parseArgs", () => {
  it("reads a command, its words and its flags", () => {
    expect(parseArgs(["shot", "--device", "se", "--theme=all", "--keyboard"])).toEqual({ command: "shot", args: [], flags: { device: "se", theme: "all", keyboard: true } });
    expect(parseArgs(["type", "hello", "world"])).toEqual({ command: "type", args: ["hello", "world"], flags: {} });
    expect(parseArgs(["start", "--core", "scenario:busy", "--browser", "chromium"]).flags).toEqual({ core: "scenario:busy", browser: "chromium" });
    expect(parseArgs([]).command).toBe("help");
  });

  it("says what's wrong", () => {
    expect(() => parseArgs(["shoot"])).toThrow("There's no “shoot” command");
    expect(() => parseArgs(["shot", "--device", "pixel"])).toThrow("--device is se, 15 or promax");
    expect(() => parseArgs(["shot", "--theme", "sepia"])).toThrow("--theme is light, dark or all");
    expect(() => parseArgs(["start", "--browser", "firefox"])).toThrow("--browser is webkit or chromium");
    expect(() => parseArgs(["start", "--core", "prod"])).toThrow("--core is scenario");
    expect(() => parseArgs(["tap", "--theme", "dark", "x"])).toThrow("tap doesn't take --theme");
    expect(() => parseArgs(["shot", "--out"])).toThrow("--out needs a value");
    expect(() => parseArgs(["logs", "--lines", "0"])).toThrow("--lines needs a number");
    expect(() => parseArgs(["tap"])).toThrow("tap needs what to tap");
    expect(() => parseArgs(["goto"])).toThrow("goto needs a terminal");
  });
});

describe("parseCore", () => {
  it("defaults to the default scenario", () => {
    expect(parseCore(undefined)).toEqual({ kind: "scenario", name: "default" });
    expect(parseCore("scenario")).toEqual({ kind: "scenario", name: "default" });
    expect(parseCore("scenario:long-log")).toEqual({ kind: "scenario", name: "long-log" });
    expect(parseCore("dev")).toEqual({ kind: "dev" });
    expect(() => parseCore("scenario:../x")).toThrow();
  });
});

describe("keyName", () => {
  it("maps keys as people write them to Playwright's", () => {
    expect(keyName("enter")).toBe("Enter");
    expect(keyName("ESC")).toBe("Escape");
    expect(keyName("shift-tab")).toBe("Shift+Tab");
    expect(keyName("up")).toBe("ArrowUp");
    expect(keyName("ctrl-c")).toBe("Control+c");
    expect(keyName("^d")).toBe("Control+d");
    expect(keyName("f5")).toBe("F5");
    expect(keyName("q")).toBe("q");
    expect(() => keyName("hyper")).toThrow("isn't a key here");
  });
});

describe("isSelector", () => {
  it("tells selectors from text on screen", () => {
    for (const s of [".compose input", "#root", "[aria-label=Send]", "button", "header.bar h1", "div > span"]) expect(isSelector(s), s).toBe(true);
    for (const s of ["Settings", "Pair This Browser", "Back to Now", "api", "Next"]) expect(isSelector(s), s).toBe(false);
  });
});
