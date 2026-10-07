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

  it("refuses excluded events when recording, and removes kept ones when asked", async () => {
    const { d, settings } = service();
    d.record(cmd("c1", "op read x"));
    d.record(cmd("c2", "ls"));
    settings["data.exclude"] = "cmd:^op ";
    expect(d.record(cmd("c3", "op signin"))).toBeNull();
    expect(d.query({ types: ["command"] }).map((e) => e.id)).toEqual(["c1", "c2"]);
    const removed: string[][] = [];
    d.on("removed", (r) => removed.push(r.types));
    expect(await d.applyRules()).toBe(1);
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
  it("makes a tool call's PreToolUse the parent of what follows it, looking back a day", async () => {
    const { ActivityView } = await import("../src/data/views/activity.ts");
    const { ViewsStore } = await import("../src/data/views/views.ts");
    const { d } = service();
    const view = new ActivityView(d, new ViewsStore(null));
    const hook = (at: number, name: string, tool: string) => view.insert({ at, agent: "claude", name, payload: { hook_event_name: name, session_id: "s", tool_name: "Bash", tool_use_id: tool } }, "p1", "a1");
    const parent = (id: number) => d.store.query({ types: ["agent.hook"] }).find((e) => e.seq === id)?.parentId ?? null;
    const pre = hook(1000, "PreToolUse", "t1");
    const post = hook(2000, "PostToolUse", "t1");
    expect(parent(post.id)).toBe(d.store.query({ types: ["agent.hook"] }).find((e) => e.seq === pre.id)!.id);
    hook(3000, "PreToolUse", "t2");
    expect(parent(hook(3000 + 2 * 86400_000, "PostToolUse", "t2").id)).toBeNull();
  });

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
  it("records Clear as a marker after the notifications, which stay in the log", async () => {
    const { Core } = await import("../src/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0 });
    try {
      core.notifications.send(null, "first", "one");
      core.notifications.send(null, "second", "two");
      await core.call("notify.clear", {});
      await new Promise((r) => setTimeout(r, 2));
      core.notifications.send(null, "third", "three");
      const [clear] = core.data.query({ types: ["notification.clear"] });
      const after = core.data.query({ types: ["notification"], at: [clear!.at + 1, Number.MAX_SAFE_INTEGER] });
      expect(after.map((e) => e.text)).toEqual(["third"]); // what the widget shows
      expect(core.data.query({ types: ["notification"] }).length).toBe(3); // cleared from the widget, kept in the log
    } finally {
      await core.close();
    }
  });
});

describe("replaying agents with their pane's activity", () => {
  const setup = async () => {
    const { ActivityView } = await import("../src/data/views/activity.ts");
    const { ViewsStore } = await import("../src/data/views/views.ts");
    const { d } = service();
    const view = new ActivityView(d, new ViewsStore(null));
    const hook = (at: number, name: string, extra: Record<string, unknown> = {}) => view.insert({ at, agent: "claude", name, payload: { hook_event_name: name, session_id: "s", ...extra } }, "p1", "a1");
    const span = (at: number, until: number) => d.record({ id: `activity:p1:${at}`, at, until, type: "pane.activity", source: "pty", paneId: "p1", agentId: "a1", data: {} });
    return { d, view, hook, span };
  };

  it("ends a turn as interrupted when the pane went quiet, as the live core did", async () => {
    const { view, hook, span } = await setup();
    const t0 = Date.now() - 3600_000;
    hook(t0, "UserPromptSubmit", { prompt: "do it" });
    span(t0, t0 + 20_000); // output for 20 s, then nothing (Esc, no event)
    await view.rebuild();
    const [t] = view.turns("a1");
    expect(t).toMatchObject({ outcome: "interrupted", endedAt: t0 + 20_000 });
    expect(t!.inferred.join()).toMatch(/quiet for 30 s/);
  });

  it("keeps a turn working while its pane prints, until the agent says it's done", async () => {
    const { view, hook, span } = await setup();
    const t0 = Date.now() - 3600_000;
    hook(t0, "UserPromptSubmit", { prompt: "long build" });
    span(t0, t0 + 100_000); // a 100 s build printing all along
    hook(t0 + 101_000, "Stop", { last_assistant_message: "Built." });
    const replay = view.replay("a1");
    expect(replay).toMatchObject({ state: "done", turn: { outcome: "done", final: "Built." } });
  });

  it("without recorded activity, only the agent's events count (older history rebuilds as before)", async () => {
    const { view, hook } = await setup();
    const t0 = Date.now() - 3600_000;
    hook(t0, "UserPromptSubmit", { prompt: "do it" });
    hook(t0 + 100_000, "Stop", { last_assistant_message: "Done." });
    await view.rebuild();
    expect(view.turns("a1")[0]).toMatchObject({ outcome: "done" });
  });

  it("without recorded activity, a prompt after a quiet stretch starts a turn; one typed while it works steers it", async () => {
    const { view, hook } = await setup();
    const t0 = Date.now() - 3600_000;
    hook(t0, "UserPromptSubmit", { prompt: "first" });
    hook(t0 + 5_000, "PreToolUse", { tool_name: "Bash", tool_use_id: "u1", tool_input: { command: "ls" } });
    hook(t0 + 6_000, "PostToolUse", { tool_name: "Bash", tool_use_id: "u1", tool_input: { command: "ls" }, tool_response: {} });
    hook(t0 + 61_000, "UserPromptSubmit", { prompt: "second, after Esc" }); // 55 s of nothing
    hook(t0 + 70_000, "UserPromptSubmit", { prompt: "and also this" }); // while it works
    hook(t0 + 90_000, "Stop", { last_assistant_message: "Done." });
    await view.rebuild();
    const turns = view.turns("a1");
    expect(turns.map((t) => [t.prompt, t.outcome])).toEqual([["first", "interrupted"], ["second, after Esc", "done"]]);
    expect(turns[1]!.followUps).toEqual(["and also this"]);
  });

  it("an agent that ran across the upgrade: the timing rules start where its recorded activity does", async () => {
    const { view, hook, span } = await setup();
    const t0 = Date.now() - 3600_000;
    hook(t0, "UserPromptSubmit", { prompt: "think long" }); // before the upgrade: no activity recorded
    hook(t0 + 120_000, "Stop", { last_assistant_message: "Thought." });
    hook(t0 + 200_000, "UserPromptSubmit", { prompt: "after the upgrade" });
    span(t0 + 200_000, t0 + 210_000);
    await view.rebuild();
    expect(view.turns("a1").map((t) => [t.prompt, t.outcome])).toEqual([["think long", "done"], ["after the upgrade", "interrupted"]]);
  });
});

describe("a turn's screen", () => {
  it("takes the lines from the prompt's echo, without the agent's input box", async () => {
    const { turnScreen } = await import("../src/data/sources/pane-output.ts");
    const rule = "─".repeat(60);
    const screen = [
      "❯ earlier prompt",
      "⏺ Earlier answer.",
      "",
      "❯ Add a function mul(a, b) to calc.py that returns a*b. Keep it to one edit, then",
      "  say done.",
      "  Read 1 file",
      "⏺ Update(calc.py)",
      "  ⎿  Added 4 lines",
      "",
      "",
      "⏺ Done. I added mul(a, b) to calc.py.",
      "✻ Crunched for 6s",
      rule,
      "❯ ",
      rule,
      "  repo │ main │ Opus 5.5 │ ctx 4%",
      "  ⏵⏵ auto mode on",
    ].join("\n");
    expect(turnScreen(screen, "Add a function mul(a, b) to calc.py that returns a*b. Keep it to one edit, then say done.")).toBe(
      ["❯ Add a function mul(a, b) to calc.py that returns a*b. Keep it to one edit, then", "  say done.", "  Read 1 file", "⏺ Update(calc.py)", "  ⎿  Added 4 lines", "", "⏺ Done. I added mul(a, b) to calc.py.", "✻ Crunched for 6s"].join("\n"),
    );
    // No echo of the prompt (an auto turn): the last lines.
    expect(turnScreen("a\nb\n", null)).toBe("a\nb");
  });
});

describe("the pane output recorder", () => {
  it("records stretches of an agent pane's output, and what a turn printed when it ends", async () => {
    const { PaneOutputRecorder } = await import("../src/data/sources/pane-output.ts");
    const { ActivityView } = await import("../src/data/views/activity.ts");
    const { ViewsStore } = await import("../src/data/views/views.ts");
    const { PaneManager } = await import("../src/panes.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const f = fakeFactory();
    const panes = new PaneManager(f.factory, { socketPath: "/tmp/t.sock", pollMs: 0 });
    const { d } = service();
    const view = new ActivityView(d, new ViewsStore(null));
    const rec = new PaneOutputRecorder({ data: d, panes, activity: view, paneOf: () => pane.id, settleMs: 0 });
    const pane = panes.create();
    f.ptys[0]!.output("plain shell output\r\n"); // no agent yet: not recorded
    expect(d.query({ types: ["pane.activity"] })).toEqual([]);
    panes.setAgent(pane.id, "a1");
    const start = Date.now();
    f.ptys[0]!.output("❯ fix the bug\r\n\x1b[1mthinking\x1b[0m\r\n");
    f.ptys[0]!.output("Edited calc.py\r\n");
    const spans = d.query({ types: ["pane.activity"] });
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ paneId: pane.id, agentId: "a1" });
    view.saveTurn({ format: 2, derivedBy: null, agentId: "a1", agentKind: "claude", agentVersion: null, model: null, index: 0, sessionId: "s", turnId: null, startedAt: start - 10, endedAt: Date.now(), prompt: "fix the bug", auto: false, followUps: [], notes: [], background: [], outcome: "done", ask: null, final: null, error: null, tools: [], commands: [], shellWrites: 0, files: [], subagents: 0, events: 2, inferred: [] }, 1, "/w");
    for (let i = 0; i < 100 && !d.query({ types: ["agent.output"] }).length; i++) await new Promise((r) => setTimeout(r, 10));
    const [out] = d.query({ types: ["agent.output"] });
    expect(out).toMatchObject({ agentId: "a1", sessionId: "claude:s", data: { turn: 0 } });
    expect(d.store.blob(out!.blob!)?.toString() ?? out!.data).toBe("❯ fix the bug\nthinking\nEdited calc.py");
    rec.dispose();
    panes.dispose();
  });
});
