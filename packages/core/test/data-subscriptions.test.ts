import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, type Connection } from "@cmd/protocol/node";
import type { CoreEvent, DataEvent } from "@cmd/protocol";
import { Core } from "../src/core.ts";
import { fakeFactory } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-subs-"));
const socketPath = path.join(dir, "core.sock");
let core: Core;
let conn: Connection;
const received: Extract<CoreEvent, { type: "data.changed" }>[] = [];
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  core = new Core({ socketPath, dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0 });
  await core.listen();
  conn = await connect(socketPath);
  conn.client.onEvent((e) => {
    if (e.type === "data.changed") received.push(e);
  });
  await conn.client.call("events.subscribe", { types: ["data.changed"] });
});
afterAll(async () => {
  conn.close();
  await core.close();
  rmTemp(dir);
});

describe("data subscriptions", () => {
  it("answers with the events now, then with every event that matches as it's recorded", async () => {
    core.data.record({ id: "n1", at: 1, type: "note", source: "cmd", text: "first", data: { by: "user", agentSession: null } });
    const { id, events } = await conn.client.call("data.subscribe", { query: { types: ["note", "git."] } });
    expect(events.map((e) => e.id)).toEqual(["n1"]);
    core.data.record({ id: "n2", at: 2, type: "note", source: "cmd", text: "second", data: { by: "user", agentSession: null } });
    core.data.record({ id: "c1", at: 3, type: "command", source: "osc", text: "ls", data: { command: "ls", exitCode: 0, cwd: "/", output: null } }); // not asked for
    core.data.recordAll([{ id: "g1", at: 4, type: "git.tag", source: "git", text: "v1", data: { tag: "v1", hash: "h", repo: "/r" } }]);
    await settle();
    const mine = received.filter((e) => e.id === id);
    expect(mine.flatMap((e) => e.events.map((x: DataEvent) => x.id))).toEqual(["n2", "g1"]);
  });

  it("sends an updated event again (a command that ended), and nothing after unsubscribing", async () => {
    const { id } = await conn.client.call("data.subscribe", { query: { types: ["command"], workspaceId: "s1" } });
    core.data.record({ id: "command:x", at: 10, type: "command", source: "osc", workspaceId: "s1", text: "pnpm test", data: { command: "pnpm test", exitCode: null, cwd: "/", output: null } });
    core.data.record({ id: "command:x", at: 10, until: 20, type: "command", source: "osc", workspaceId: "s1", text: "pnpm test", data: { command: "pnpm test", exitCode: 0, cwd: "/", output: null } });
    core.data.record({ id: "command:y", at: 11, type: "command", source: "osc", workspaceId: "s2", text: "ls", data: { command: "ls", exitCode: 0, cwd: "/", output: null } }); // another workspace
    await settle();
    const mine = received.filter((e) => e.id === id).flatMap((e) => e.events as DataEvent[]);
    expect(mine.map((e) => [e.id, e.until])).toEqual([
      ["command:x", null],
      ["command:x", 20],
    ]);
    await conn.client.call("data.unsubscribe", { id });
    core.data.record({ id: "command:z", at: 12, type: "command", source: "osc", workspaceId: "s1", text: "pwd", data: { command: "pwd", exitCode: 0, cwd: "/", output: null } });
    await settle();
    expect(received.filter((e) => e.id === id).flatMap((e) => e.events as DataEvent[]).length).toBe(2);
  });

  it("matches full text too", async () => {
    const { id } = await conn.client.call("data.subscribe", { query: { types: ["note"], text: "quokka" } });
    core.data.record({ id: "n3", at: 30, type: "note", source: "cmd", text: "a quokka appeared", body: "a quokka appeared", data: { by: "user", agentSession: null } });
    core.data.record({ id: "n4", at: 31, type: "note", source: "cmd", text: "nothing here", body: "nothing here", data: { by: "user", agentSession: null } });
    await settle();
    expect(received.filter((e) => e.id === id).flatMap((e) => e.events.map((x: DataEvent) => x.id))).toEqual(["n3"]);
  });

  it("forgets a connection's subscriptions when it closes", async () => {
    const other = await connect(socketPath);
    await other.client.call("events.subscribe", { types: ["data.changed"] });
    const { id } = await other.client.call("data.subscribe", { query: { types: ["note"] } });
    other.close();
    await settle();
    core.data.record({ id: "n5", at: 40, type: "note", source: "cmd", text: "late", data: { by: "user", agentSession: null } });
    await settle();
    expect(received.some((e) => e.id === id)).toBe(false);
  });
});

describe("the widgets socket", () => {
  it("lets a widget that says who it is read events, and nothing else", async () => {
    const { widgetsSocketPath } = await import("../src/core.ts");
    const w = await connect(widgetsSocketPath(socketPath));
    await expect(w.client.call("data.query", { query: {} })).rejects.toThrow(/widget.hello/);
    await expect(w.client.call("widget.hello", { token: "nope" })).rejects.toThrow(/unknown or expired/);
    core.data.record({ id: "ws1-note", at: 50, type: "note", source: "cmd", workspaceId: "s1", text: "in s1", data: { by: "user", agentSession: null } });
    const token = core.widgetTokens.issue({ widgetId: "w1", workspaceId: "s1", events: [] });
    expect(await w.client.call("widget.hello", { token })).toEqual({ widgetId: "w1", workspaceId: "s1", events: [] });
    const events = await w.client.call("data.query", { query: { types: ["note"], limit: 5000 } });
    expect(events.length).toBeGreaterThan(0);
    await expect(w.client.call("pane.list", {})).rejects.toThrow(/only read events/);
    w.close();
  });
});

describe("view subscriptions", () => {
  it("answers with a view's rows now, then each turn and session that changes and matches", async () => {
    const turn = (index: number, outcome: "working" | "done") => ({ format: 2, derivedBy: null, agentId: "va", agentKind: "claude" as const, agentVersion: null, model: null, index, sessionId: "vs", turnId: null, startedAt: Date.now(), endedAt: outcome === "done" ? Date.now() : null, prompt: `p${index}`, auto: false, followUps: [], notes: [], background: [], outcome, ask: null, final: null, error: null, tools: [], commands: [], shellWrites: 0, files: [], subagents: 0, events: 1, inferred: [] });
    core.agents.activity.saveTurn(turn(0, "done"), 1, "/w");
    const views: Extract<CoreEvent, { type: "view.changed" }>[] = [];
    conn.client.onEvent((e) => {
      if (e.type === "view.changed") views.push(e);
    });
    await conn.client.call("events.subscribe", { types: ["data.changed", "view.changed"] });
    const t = await conn.client.call("data.subscribeView", { query: { view: "turns", agentId: "va" } });
    expect(t.rows.map((r) => ("index" in r ? r.index : -1))).toEqual([0]);
    core.agents.activity.saveTurn(turn(1, "working"), 2, "/w");
    core.agents.activity.saveTurn(turn(1, "done"), 3, "/w");
    core.agents.activity.saveTurn({ ...turn(0, "done"), agentId: "other" }, 4, "/w"); // another agent
    const s = await conn.client.call("data.subscribeView", { query: { view: "sessions" } });
    core.sessions.apply(core.data.recordBatch([{ id: "vm1", at: Date.now(), type: "transcript.message", source: "t", sessionId: "claude:vs2", text: "hello", data: { role: "user", cwd: "/w" } }]));
    await settle();
    const mine = views.filter((e) => e.id === t.id).flatMap((e) => e.rows);
    expect(mine.map((r) => ("index" in r ? `${r.index}:${r.outcome}` : "?"))).toEqual(["1:done"]); // the two saves of turn 1 coalesced
    expect(views.filter((e) => e.id === s.id).flatMap((e) => e.rows).map((r) => ("key" in r ? r.key : "?"))).toEqual(["claude:vs2"]);
  });

  it("keeps a workspace's sessions, and starts over when workspaces change or the view is rebuilt", async () => {
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(dir, "proj-")));
    fs.mkdirSync(path.join(proj, "sub"));
    const workspace = core.workspaces.open(proj).workspace;
    const views: Extract<CoreEvent, { type: "view.changed" }>[] = [];
    conn.client.onEvent((e) => {
      if (e.type === "view.changed") views.push(e);
    });
    await conn.client.call("events.subscribe", { types: ["data.changed", "view.changed"] });
    const session = (key: string, cwd: string, at: number) =>
      core.sessions.apply(core.data.recordBatch([{ id: `m-${key}`, at, type: "transcript.message", source: "t", sessionId: `claude:${key}`, text: "hi", data: { role: "user", cwd } }]));
    session("in", path.join(proj, "src"), 1000);
    session("out", "/elsewhere", 2000);
    const keys = (rows: unknown[]) => rows.map((r) => (r as { key: string }).key);
    const s = await conn.client.call("data.subscribeView", { query: { view: "sessions", workspaceId: workspace.id } });
    expect(keys(s.rows)).toEqual(["claude:in"]);
    session("nested", path.join(proj, "sub"), 3000);
    session("out2", "/elsewhere/too", 4000);
    await settle();
    expect(keys(views.filter((e) => e.id === s.id).flatMap((e) => e.rows))).toEqual(["claude:nested"]);
    expect(keys(await conn.client.call("data.view", { query: { view: "sessions", workspaceId: workspace.id } }))).toEqual(["claude:nested", "claude:in"]);

    // A nested workspace takes its folder's sessions: the subscription gets the whole list again.
    views.length = 0;
    core.workspaces.open(path.join(proj, "sub"));
    await settle();
    const reset = views.filter((e) => e.id === s.id);
    expect(reset.map((e) => [e.reset, keys(e.rows)])).toEqual([[true, ["claude:in"]]]);

    views.length = 0;
    await core.sessions.rebuild();
    await settle();
    expect(views.filter((e) => e.id === s.id).map((e) => e.reset)).toEqual([true]);
  });
});
