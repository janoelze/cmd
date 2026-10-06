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

describe("agent events in the log", () => {
  it("keeps a hook payload's long strings cut in the row and the whole payload as its content, with the pane's Space", async () => {
    const { ActivityView } = await import("../src/data/views/activity.ts");
    const { ViewsStore } = await import("../src/data/views/views.ts");
    const { d } = service();
    const view = new ActivityView(d, new ViewsStore(null));
    view.spaceOf = (paneId) => (paneId === "p1" ? "space-1" : null);
    const big = "x".repeat(20_000);
    view.insert({ at: 1, agent: "claude", name: "PostToolUse", payload: { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Read", tool_response: big } }, "p1", "a1");
    const [e] = d.query({ types: ["agent.hook"] });
    expect(e!.spaceId).toBe("space-1");
    expect(JSON.stringify(e!.data).length).toBeLessThan(6000);
    expect(JSON.parse(d.store.blob(e!.blob!)!.toString()).tool_response).toBe(big);
    view.insert({ at: 2, agent: "claude", name: "Stop", payload: { hook_event_name: "Stop", session_id: "s" } }, "p1", "a1");
    expect(d.query({ types: ["agent.hook"] })[1]!.blob).toBeNull();
  });
});

describe("the notification log", () => {
  it("lists notifications from the log, newest first, and starts over after Clear", async () => {
    const { Core } = await import("../src/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0 });
    try {
      core.notifications.send(null, "first", "one");
      core.notifications.send(null, "second", "two");
      expect((await core.call("notify.list", {})).map((n) => n.title)).toEqual(["second", "first"]);
      await core.call("notify.clear", {});
      await new Promise((r) => setTimeout(r, 2));
      core.notifications.send(null, "third", "three");
      expect((await core.call("notify.list", {})).map((n) => n.title)).toEqual(["third"]);
      expect(core.data.query({ types: ["notification"] }).length).toBe(3); // cleared from the widget, kept in the log
    } finally {
      await core.close();
    }
  });
});
