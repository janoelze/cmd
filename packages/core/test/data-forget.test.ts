import { describe, expect, it } from "vitest";
import os from "node:os";
import { DEFAULT_SETTINGS, type Settings } from "@cmd/protocol";
import { DataService } from "../src/data/service.ts";
import { excludedBy, parseExclude } from "../src/data/exclude.ts";

const service = (over: Partial<Record<string, unknown>> = {}) => {
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...over };
  const d = new DataService({ file: null, recordedBy: "test", settings: () => settings as unknown as Settings });
  return { d, settings };
};
const cmd = (id: string, command: string, cwd = "/w", at = 1) => ({ id, at, type: "command" as const, source: "osc", projectId: `dir:${cwd}`, text: command, data: { command, exitCode: 0, cwd, output: null } });
const msg = (id: string, session: string, at = 1) => ({ id, at, type: "transcript.message" as const, source: "t", sessionId: session, text: "hi", data: { role: "user" } });

describe("exclusion rules", () => {
  it("reads folders, hosts and commands, and says what's wrong", () => {
    const r = parseExclude("~/private, /Volumes/x, host:*.bank.example, cmd:^op\\s, cmd:([, oops", "/Users/me");
    expect(r.folders).toEqual(["/Users/me/private", "/Volumes/x"]);
    expect(r.hosts).toEqual(["bank.example"]);
    expect(r.commands.map((c) => c.source)).toEqual(["^op\\s"]);
    expect(r.errors).toEqual(["cmd:([", "oops"]);
  });

  it("matches events by folder, host and command", () => {
    const r = parseExclude(`${os.homedir()}/private, host:bank.example, cmd:^op\\s`);
    expect(excludedBy(r, cmd("a", "ls", `${os.homedir()}/private/notes`))).toMatch(/folder/);
    expect(excludedBy(r, cmd("b", "ls", `${os.homedir()}/privateer`))).toBeNull();
    expect(excludedBy(r, cmd("c", "op read op://vault/x"))).toMatch(/command/);
    expect(excludedBy(r, { id: "v", at: 1, type: "browser.visit", source: "window", data: { url: "https://login.bank.example/x", title: null } })).toMatch(/host/);
    expect(excludedBy(r, { id: "w", at: 1, type: "browser.visit", source: "window", data: { url: "https://notbank.example/", title: null } })).toBeNull();
  });

  it("refuses excluded events when recording, and removes kept ones when asked", () => {
    const { d, settings } = service();
    d.record(cmd("c1", "op read x"));
    d.record(cmd("c2", "ls"));
    settings["data.exclude"] = "cmd:^op ";
    expect(d.record(cmd("c3", "op signin"))).toBeNull();
    expect(d.query({ types: ["command"] }).map((e) => e.id)).toEqual(["c1", "c2"]);
    const removed: string[][] = [];
    d.on("removed", (r) => removed.push(r.types));
    expect(d.applyRules()).toBe(1);
    expect(d.query({ types: ["command"] }).map((e) => e.id)).toEqual(["c2"]);
    expect(removed).toEqual([["command"]]);
  });
});

describe("forget", () => {
  it("deletes a session's events, its blobs, and never takes it again", () => {
    const { d } = service();
    d.record({ ...msg("m1", "claude:s1"), content: "x".repeat(5000) });
    d.record(msg("m2", "claude:s2"));
    expect(d.store.stats().blobs.count).toBe(1);
    expect(d.forget({ sessionId: "claude:s1" })).toBe(1);
    expect(d.query({ types: ["transcript."] }).map((e) => e.id)).toEqual(["m2"]);
    expect(d.store.stats().blobs.count).toBe(0);
    // The transcript read again (a reindex): refused.
    expect(d.recordAll([msg("m1", "claude:s1"), msg("m3", "claude:s1")])).toBe(0);
    expect(d.query({ types: ["data.op"] })[0]!.data).toMatchObject({ op: "forget", detail: { events: 1, session: true } });
  });

  it("forgets a project, or what's older than a date, of some types", () => {
    const { d } = service();
    d.record(cmd("c1", "ls", "/a", 100));
    d.record(cmd("c2", "ls", "/b", 100));
    d.record(cmd("c3", "ls", "/b", 300));
    d.record(msg("m1", "claude:s", 100));
    expect(d.forget({ before: 200, types: ["command"] })).toBe(2);
    expect(d.query({ types: ["command", "transcript."] }).map((e) => e.id)).toEqual(["c3", "m1"]);
    expect(d.forget({ projectId: "dir:/b" })).toBe(1);
    expect(d.record(cmd("c4", "ls", "/b", 400))).toBeNull();
    expect(() => d.forget({})).toThrow(/say what/);
  });
});
