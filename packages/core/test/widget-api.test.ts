// The widget API, major 1 (docs/56, "The host API"; widgets/api/adapter.ts, access.ts) against a
// Core with fixtures: every verb answers in the shape protocol widget-tree.ts's ApiMethods
// says; each namespace without its permission is refused with the permission to add, and
// the next call works; a widget sees its own workspace only, unless granted "all"; a
// terminal's screen comes back clipped and marked untrusted; windows.open only right after a
// press; notify.send once per key and words.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { API, API_VERBS, noPermissions, type ApiMethods, type ApiVerb, type AppNotification, type CoreEvent, type WidgetPermissions, type WireValue, type Workspace } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { AiNotConfigured } from "../src/ai/service.ts";
import { ApiRefusal } from "../src/widgets/api/access.ts";
import { AiUsage } from "../src/widgets/api/ai.ts";
import { widgetApi, type WidgetApi } from "../src/widgets/api/adapter.ts";
import { fakeFactory } from "./fake-pty.ts";
import { tmp, until, writePackage } from "./fake-widget-runtime.ts";

let core: Core;
let ptys: ReturnType<typeof fakeFactory>["ptys"];
let A: Workspace;
let B: Workspace;
let windowId: string;
let paneA: string;
let paneB: string;
let server: http.Server;
let port: number;
const events: CoreEvent[] = [];
let pressed = 0;
const called = new Set<ApiVerb>();

const ALL: WidgetPermissions = { ...noPermissions(), workspace: ["read", "all"], events: ["agents"], ai: ["complete"], net: [] };

function adapter(permissions: WidgetPermissions): WidgetApi {
  const pkg = core.library.packages.forKind("pkg:demo/main")!;
  // The services as a feature gets them (kernel/context.ts), with `opened` counting nothing.
  const ctx = { agents: core.agents, panes: core.panes, windows: core.windows, windowTypes: core.windowTypes, workspaces: core.workspaces, data: core.data, actions: core.actions, notifications: core.notifications, ai: core.ai, settings: core.settings, resources: core.resources, stats: core.stats, journal: core.journal, processes: core.processes, commands: core.commands, broadcast: (e: CoreEvent) => core.server.broadcast(e), opened: <W>(w: W) => w, call: core.call.bind(core) as never };
  return widgetApi(ctx, { windowId, workspaceId: () => A.id, pkg, widget: pkg.widgets[0]!, permissions, press: { at: () => pressed, remote: () => false, take: () => void (pressed = 0) }, secret: () => null, aiUsage: new AiUsage(null) });
}

/** A verb, typed as the d.ts types it. */
async function call<V extends ApiVerb>(api: WidgetApi, verb: V, ...params: ApiMethods[V]["params"]): Promise<ApiMethods[V]["result"]> {
  called.add(verb);
  return (await api.call(verb, params as WireValue[])) as ApiMethods[V]["result"];
}

/** The refusal of a call. */
async function refusal(p: Promise<unknown>): Promise<ApiRefusal["error"]> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiRefusal) return e.error;
    throw e;
  }
  throw new Error("the call wasn't refused");
}

beforeAll(async () => {
  const home = tmp("cmd-widgets-home-");
  writePackage(home);
  process.env.CMD_WIDGETS_HOME = home;
  const f = fakeFactory();
  ptys = f.ptys;
  core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: f.factory, pollMs: 0 });
  delete process.env.CMD_WIDGETS_HOME;
  core.start();
  await core.scheduler.idle();
  core.library.packages.start();
  core.serve({ access: "local", send: (line) => {
    const m = JSON.parse(line) as { method?: string; params?: CoreEvent };
    if (m.method === "event") events.push(m.params!);
  }, close: () => {} }).receive(JSON.stringify({ id: 1, method: "events.subscribe", params: {} }));

  // Workspace A: a repository with a commit, a change and an npm script; B: another folder.
  const repo = tmp("cmd-widget-repo-");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { test: "vitest run" } }));
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
  A = core.workspaces.open(repo).workspace;
  B = core.workspaces.open(tmp("cmd-widget-other-")).workspace;
  windowId = core.windows.open("pkg:demo/main", {}, A).id;
  paneA = core.panes.create({ workspaceId: A.id, cwd: repo }).id;
  paneB = core.panes.create({ workspaceId: B.id }).id;
  core.agents.ingestHook(paneA, "claude", "UserPromptSubmit", { session_id: "sa", prompt: "fix the tests" });
  core.agents.ingestHook(paneB, "claude", "UserPromptSubmit", { session_id: "sb", prompt: "elsewhere" });
  core.data.record({ id: "note-a", at: Date.now() - 1000, type: "note", source: "cmd", workspaceId: A.id, text: "in A", data: { by: "user", agentSession: null } });
  core.data.record({ id: "note-b", at: Date.now() - 1000, type: "note", source: "cmd", workspaceId: B.id, text: "in B", data: { by: "user", agentSession: null } });

  server = http.createServer((req, res) => res.end(JSON.stringify({ path: req.url })));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server?.close();
  await core?.close();
});

describe("API 1", () => {
  it("serves every verb, each in the shape the d.ts says", async () => {
    const api = adapter({ ...ALL, net: [`localhost:${port}`] });

    const ws = await call(api, "workspace.get");
    expectTypeOf(ws).toEqualTypeOf<ApiMethods["workspace.get"]["result"]>();
    expect(ws).toEqual({ id: A.id, name: A.name, root: A.root, branch: "main" });
    const wins = await call(api, "workspace.windows");
    expect(wins.map((w) => w.id)).toEqual(expect.arrayContaining([windowId, paneA]));
    expect(wins.every((w) => w.workspaceId === A.id && typeof w.selected === "boolean" && typeof w.kind === "string")).toBe(true);
    core.workspaces.update(A.id, { view: { "selection.pane": paneA } });
    expect(await call(api, "workspace.selected")).toMatchObject({ id: paneA, kind: "terminal", selected: true });

    const agents = await call(api, "agents.list");
    expectTypeOf(agents).toEqualTypeOf<ApiMethods["agents.list"]["result"]>();
    expect(agents).toEqual([expect.objectContaining({ kind: "claude", name: expect.any(String), state: "working", bucket: "rest", light: "working", icon: expect.any(String), windowId: paneA, terminalId: paneA, workspaceId: A.id, parentId: null, depth: 0, stateSince: expect.any(Number), cwd: expect.any(String) })]);
    expect(await call(api, "agents.get", agents[0]!.id)).toEqual(agents[0]);

    const terms = await call(api, "terminals.list");
    expect(terms).toEqual([expect.objectContaining({ id: paneA, windowId: paneA, workspaceId: A.id, title: expect.any(String), cwd: expect.any(String) })]);
    ptys[0]!.output("build ok\r\nready on 4242\r\n");
    await until(async () => (await core.panes.read(paneA, 10)).includes("ready on"), "the screen");
    const screen = await call(api, "terminals.read", paneA);
    expectTypeOf(screen).toEqualTypeOf<ApiMethods["terminals.read"]["result"]>();
    expect(screen).toMatchObject({ text: expect.stringContaining("ready on 4242"), untrusted: true, clipped: expect.any(Boolean) });
    expect(await call(api, "terminals.waitFor", paneA, "ready on \\d+", { timeoutMs: 1000 })).toEqual({ matched: true, line: expect.stringContaining("ready on 4242") });
    const waiting = call(api, "terminals.waitFor", paneA, "^done$", { timeoutMs: 2000 });
    setTimeout(() => ptys[0]!.output("done\r\n"), 50);
    expect(await waiting).toEqual({ matched: true, line: "done" });

    expect((await call(api, "windows.list")).map((w) => w.workspaceId)).not.toContain(B.id);
    pressed = Date.now();
    const opened = await call(api, "windows.open", "pkg:demo/main");
    expect(core.windows.others().find((w) => w.id === opened.id)?.kind).toBe("pkg:demo/main");
    events.length = 0;
    expect(await call(api, "windows.select", paneA)).toBeNull();
    expect(events).toContainEqual({ type: "window.focus", id: paneA });

    const evs = await call(api, "events.query", { types: ["note"] });
    expectTypeOf(evs).toEqualTypeOf<ApiMethods["events.query"]["result"]>();
    expect(evs).toEqual([expect.objectContaining({ id: expect.any(Number), at: expect.any(Number), type: "note", workspaceId: A.id, data: expect.any(Object) })]);
    expect(await call(api, "events.stats", { types: ["note"] })).toEqual({ total: 1, byType: { note: 1 } });

    const st = await call(api, "git.status");
    expect(st).toMatchObject({ branch: "main", ahead: 0, behind: 0, files: [{ path: "a.txt", status: "modified" }] });
    const diff = await call(api, "git.diff", "a.txt");
    expect(diff).toMatchObject({ text: expect.stringContaining("+two"), clipped: false });
    expect(await call(api, "git.worktrees")).toEqual([{ path: expect.any(String), branch: "main", main: true }]);
    expect(await call(api, "actions.list")).toEqual(expect.arrayContaining([expect.objectContaining({ name: "test", title: expect.any(String), risky: false })]));

    const notes: AppNotification[] = [];
    core.notifications.on("notification", (n) => notes.push(n));
    expect(await call(api, "notify.send", { key: "ci-1", title: "CI · failed", body: "3 tests" })).toBeNull();
    expect(notes).toEqual([expect.objectContaining({ source: "widget", windowId, title: "CI · failed", body: "3 tests" })]);

    expect(await call(api, "state.set", "count", 3)).toBeNull();
    expect(await call(api, "state.get", "count")).toBe(3);
    expect(await call(api, "state.get", "missing")).toBeNull();
    expect(await call(api, "state.history", "load", 1)).toEqual([1]);
    expect(await call(api, "state.history", "load", 2, 5)).toEqual([1, 2]);

    const res = await call(api, "net.fetch", `http://localhost:${port}/hi`);
    expectTypeOf(res).toEqualTypeOf<ApiMethods["net.fetch"]["result"]>();
    expect(res).toMatchObject({ status: 200, body: JSON.stringify({ path: "/hi" }), clipped: false, headers: expect.any(Object) });

    const realComplete = core.ai.complete.bind(core.ai);
    core.ai.complete = (async () => ({ value: "hello", usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 }, model: "fake" })) as never;
    try {
      const done = await call(api, "ai.complete", { prompt: "say hello" });
      expectTypeOf(done).toEqualTypeOf<ApiMethods["ai.complete"]["result"]>();
      expect(done).toEqual({ text: "hello", usage: { input: 3, output: 1 } });
    } finally {
      core.ai.complete = realComplete;
    }

    // The verbs of 1.0 here; widget-act.test.ts calls those 1.1 added.
    expect([...called].sort()).toEqual(API_VERBS.filter((v) => API[v].since === "1.0").sort());
  });

  it("refuses each namespace without its permission, naming it, and serves the next call", async () => {
    const api = adapter(noPermissions());
    const perm = async (p: Promise<unknown>) => (await refusal(p)).permission;
    for (const verb of ["workspace.get", "workspace.windows", "workspace.selected", "agents.list", "terminals.list", "windows.list", "git.status", "git.diff", "git.worktrees", "actions.list"] as const)
      expect(await perm(api.call(verb, [])), verb).toBe('workspace: ["read"]');
    expect(await perm(api.call("agents.get", ["x"]))).toBe('workspace: ["read"]');
    expect(await perm(api.call("terminals.read", [paneA]))).toBe('workspace: ["read"]');
    expect(await perm(api.call("events.query", [{ types: ["agent.hook"] }]))).toBe('events: ["agents"]');
    // The refusal names the class from the policy's error, and the type asked for; a class widgets can't declare is no permission to ask for.
    expect((await refusal(api.call("events.query", [{ types: ["agent.hook"] }]))).message).toMatch(/"agent\.hook"/);
    expect(await refusal(api.call("events.query", [{ types: ["remote.audit"] }]))).toMatchObject({ code: "invalid", message: expect.stringMatching(/remote data, which widgets can't read/) });
    expect(await perm(api.call("net.fetch", [`http://localhost:${port}/`]))).toBe(`net: ["localhost:${port}"]`);
    expect(await perm(api.call("ai.complete", [{ prompt: "hi" }]))).toBe('ai: ["complete"]');
    expect(await perm(adapter({ ...noPermissions(), workspace: ["read"] }).call("agents.list", [{ scope: "all" }]))).toBe('workspace: ["all"]');
    // What needs no permission still works, after all those refusals.
    expect(await api.call("state.get", ["count"])).toBe(3);
    expect(await api.call("events.query", [{ types: ["note"] }])).toHaveLength(1);
    const e = await refusal(api.call("agents.list", []));
    expect(e.message).toContain("package.json");
  });

  it("sees only its own workspace, unless granted all", async () => {
    const own = adapter({ ...noPermissions(), workspace: ["read"] });
    expect((await own.call("agents.list", [])) as unknown[]).toHaveLength(1);
    const theirs = core.agents.list().find((a) => a.workspaceId === B.id)!;
    expect(await own.call("agents.get", [theirs.id])).toBeNull();
    expect((await refusal(own.call("terminals.read", [paneB]))).code).toBe("invalid");
    expect((await refusal(own.call("windows.select", [paneB]))).code).toBe("invalid");
    expect(((await own.call("events.query", [{ types: ["note"] }])) as { workspaceId: string }[]).map((x) => x.workspaceId)).toEqual([A.id]);
    expect(((await own.call("terminals.list", [{ scope: "all" }]).catch((x) => x)) as ApiRefusal).error.permission).toBe('workspace: ["all"]');

    const all = adapter({ ...noPermissions(), workspace: ["all"] });
    expect(((await all.call("agents.list", [{ scope: "all" }])) as unknown[]).length).toBe(2);
    expect(((await all.call("agents.list", [])) as unknown[]).length).toBe(1); // the default is still its own
    expect(await all.call("agents.get", [theirs.id])).toMatchObject({ workspaceId: B.id });
    expect(((await all.call("events.query", [{ types: ["note"], scope: "all" }])) as unknown[]).length).toBe(2);
  });

  it("gives a terminal's screen clipped and marked untrusted", async () => {
    const api = adapter({ ...noPermissions(), workspace: ["read"] });
    for (let i = 0; i < 40; i++) ptys[0]!.output(`line ${i} ${"x".repeat(60)}\r\n`);
    await until(async () => (await core.panes.read(paneA, 5)).includes("line 39"), "the lines");
    const r = (await api.call("terminals.read", [paneA, { lines: 5 }])) as unknown as ApiMethods["terminals.read"]["result"];
    expect(r.untrusted).toBe(true);
    expect(r.clipped).toBe(true);
    expect(r.text).toContain("line 39");
    expect(r.text).not.toContain("line 30 ");
  });

  it("opens one window per press, only right after it", async () => {
    const api = adapter(noPermissions());
    pressed = Date.now() - 60_000;
    expect((await refusal(api.call("windows.open", ["pkg:demo/main"]))).message).toMatch(/presses something/);
    pressed = Date.now();
    expect(await api.call("windows.open", ["pkg:demo/main"])).toMatchObject({ id: expect.any(String) });
    // One window per press: the second waits for another.
    expect((await refusal(api.call("windows.open", ["pkg:demo/main"]))).message).toMatch(/presses something/);
  });

  it("notifies once per key and words", async () => {
    const api = adapter(noPermissions());
    const notes: AppNotification[] = [];
    core.notifications.on("notification", (n) => notes.push(n));
    await api.call("notify.send", [{ key: "k", title: "Build · failed" }]);
    await api.call("notify.send", [{ key: "k", title: "Build · failed" }]);
    await api.call("notify.send", [{ key: "k", title: "Build · fixed" }]);
    expect(notes.map((n) => n.title)).toEqual(["Build · failed", "Build · fixed"]);
  });

  it("says when no AI is set up", async () => {
    const api = adapter({ ...noPermissions(), ai: ["complete"] });
    const real = core.ai.complete.bind(core.ai);
    core.ai.complete = (() => Promise.reject(new AiNotConfigured())) as never;
    try {
      expect((await refusal(api.call("ai.complete", [{ prompt: "hi" }]))).message).toBe("No AI provider is set up yet. Add an API key in Settings → AI.");
    } finally {
      core.ai.complete = real;
    }
  });
});
