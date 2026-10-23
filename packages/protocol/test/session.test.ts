// Telling a process from an earlier login (session.ts): one that outlived a
// logout can't reach system services such as DNS.
import { describe, expect, it } from "vitest";
import { fromEarlierLogin, loginOf, parseEtime, parsePs } from "../src/session.ts";

const LW = "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow";
const NOW = Date.UTC(2026, 9, 24, 12);
const H = 3600_000;

describe("login session", () => {
  it("reads ps elapsed times", () => {
    expect(parseEtime("00:05")).toBe(5000);
    expect(parseEtime("12:34")).toBe((12 * 60 + 34) * 1000);
    expect(parseEtime("01:02:03")).toBe((3600 + 120 + 3) * 1000);
    expect(parseEtime("8-01:00:00")).toBe((8 * 24 + 1) * H);
    expect(parseEtime("ELAPSED")).toBeNull();
  });

  it("finds the login from this user's loginwindow", () => {
    const procs = parsePs([`  412 5-08:00:00 ${LW}`, `  995 8-12:00:00 /Applications/cmd.app/Contents/MacOS/cmd`, " 4200    00:10 -zsh", "garbage"].join("\n"), NOW);
    expect(procs.map((p) => p.pid)).toEqual([412, 995, 4200]);
    expect(procs[2]!.command).toBe("-zsh");
    expect(loginOf(procs)).toBe(NOW - (5 * 24 + 8) * H);
    expect(loginOf(procs.slice(1))).toBeNull();
  });

  it("calls what started before the login earlier, and nothing without one", () => {
    const login = NOW - 5 * 24 * H;
    expect(fromEarlierLogin(login - 3 * 24 * H, login)).toBe(true);
    expect(fromEarlierLogin(login + H, login)).toBe(false);
    // ps rounds to whole seconds
    expect(fromEarlierLogin(login - 1000, login)).toBe(false);
    expect(fromEarlierLogin(0, null)).toBe(false);
  });
});
