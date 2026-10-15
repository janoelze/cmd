// API 1.2's verbs (docs/57, wave 2; widgets/api/reads.ts, clipboard.ts, act.ts's actions.stop)
// against a Core with fixtures: each answers in its ApiMethods shape with its grant and is
// refused without it, naming the permission; each is scoped to the widget's own workspace
// unless the grant says "all" (a stat that can't tell workspaces apart needs "all"); the
// journal is read, never written; media.control and clipboard.write take a press, one each, and
// never a paired device's; a stat's key that is a folder comes back as its name; events carry
// the log's text and actions their run.

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import { API, API_VERBS, noPermissions, type ApiMethods, type ApiVerb, type CoreEvent, type NowPlaying, type StatResult, type WidgetPermissions, type WireValue, type Workspace } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { ApiRefusal } from "../src/widgets/api/access.ts";
import { AiUsage } from "../src/widgets/api/ai.ts";
import { widgetApi, type WidgetApi } from "../src/widgets/api/adapter.ts";
import { CLIPBOARD_MAX, apiStat } from "../src/widgets/api/reads.ts";
import { fakeFactory } from "./fake-pty.ts";
import { tmp, writePackage } from "./fake-widget-runtime.ts";

let core: Core;
let A: Workspace;
let B: Workspace;
let windowId: string;
let paneA: string;
let paneB: string;
let pressed = 0;
let remote = false;
const clipboard: string[] = [];
const controls: unknown[] = [];
const PLAYING: NowPlaying = { app: "com.apple.Music", title: "Song", artist: "Artist", album: null, playing: true, duration: 200, elapsed: 10, at: 1, rate: 1, artwork: null };
const called = new Set<ApiVerb>();

function adapter(permissions: Partial<WidgetPermissions>): WidgetApi {
  const pkg = core.library.packages.forKind("pkg:demo/main")!;
  const ctx = { agents: core.agents, panes: core.panes, windows: core.windows, windowTypes: core.windowTypes, workspaces: core.workspaces, data: core.data, actions: core.actions, notifications: core.notifications, ai: core.ai, settings: core.settings, resources: core.resources, stats: core.stats, journal: core.journal, processes: core.processes, commands: core.commands, broadcast: (e: CoreEvent) => core.server.broadcast(e), opened: <W>(w: W) => w, call: core.call.bind(core) as never };
  return widgetApi(ctx, {
    windowId,
    workspaceId: () => A.id,
    pkg,
    widget: pkg.widgets[0]!,
    permissions: { ...noPermissions(), ...permissions },
    press: { at: () => pressed, remote: () => remote, take: () => void (pressed = 0) },
    secret: () => null,
    aiUsage: new AiUsage(null),
    clipboard: async (t) => void clipboard.push(t),
    media: { get: async () => PLAYING, control: async (o) => void controls.push(o) },
  });
}

async function call<V extends ApiVerb>(api: WidgetApi, verb: V, ...params: ApiMethods[V]["params"]): Promise<ApiMethods[V]["result"]> {
  called.add(verb);
  return (await api.call(verb, params as WireValue[])) as ApiMethods[V]["result"];
}

async function refusal(p: Promise<unknown>): Promise<ApiRefusal["error"]> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiRefusal) return e.error;
    throw e;
  }
  throw new Error("the call wasn't refused");
}
const perm = async (p: Promise<unknown>) => (await refusal(p)).permission;

beforeAll(async () => {
  const home = tmp("cmd-widgets-home-");
  writePackage(home);
  process.env.CMD_WIDGETS_HOME = home;
  core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0 });
  delete process.env.CMD_WIDGETS_HOME;
  core.start();
  await core.scheduler.idle();
  core.library.packages.start();
  const repo = tmp("cmd-widget-repo-");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { dev: "vite", test: "vitest run" } }));
  A = core.workspaces.open(repo).workspace;
  B = core.workspaces.open(tmp("cmd-widget-other-")).workspace;
  windowId = core.windows.open("pkg:demo/main", {}, A).id;
  paneA = core.panes.create({ workspaceId: A.id, cwd: repo }).id;
  paneB = core.panes.create({ workspaceId: B.id }).id;
  const sample = { memory: 50 * 2 ** 20, cpu: 12.5, processes: 3, top: [{ pid: 4242, name: "node", memory: 40 * 2 ** 20 }], sampledAt: Date.now() };
  core.panes.setUsage(paneA, sample);
  core.panes.setUsage(paneB, { ...sample, cpu: 99 });
});

afterAll(async () => {
  await core?.close();
});

describe("API 1.2", () => {
  it("serves every 1.2 verb with its grant, in the shape the d.ts says", async () => {
    const api = adapter({ workspace: ["read"], events: ["agents"], media: ["read", "control"], act: ["actions"] });

    const classes = await call(api, "events.classes");
    expectTypeOf(classes).toEqualTypeOf<ApiMethods["events.classes"]["result"]>();
    expect(classes).toContainEqual({ class: "agents", title: "Agent events", types: expect.arrayContaining(["agent."]) });
    expect(classes.map((c) => c.class)).not.toContain("remote"); // widgets never read it

    const usage = await call(api, "terminals.usage");
    expect(usage).toEqual([{ id: paneA, workspaceId: A.id, cpu: 12.5, memory: 50 * 2 ** 20, processes: 3, top: [{ name: "node", memory: 40 * 2 ** 20 }], at: expect.any(Number) }]);

    const stat = await call(api, "stats.query", { stat: "commands.runs", range: "7d" });
    expect(stat).toMatchObject({ stat: { id: "commands.runs", title: expect.any(String), unit: "count", class: "output" }, grain: "day", buckets: expect.any(Array), series: [expect.objectContaining({ key: "total" })], total: 0 });

    const days = vi.spyOn(core.journal, "days").mockResolvedValue([]);
    expect(await call(api, "journal.days", { count: 99 })).toEqual([]);
    // This workspace's, at most 30, read only: a widget never has a day written.
    expect(days).toHaveBeenCalledWith(`workspace:${A.id}`, 30, "never");
    days.mockRestore();

    expect(await call(api, "media.get")).toEqual(PLAYING);
    pressed = Date.now();
    expect(await call(api, "media.control", "toggle")).toBeNull();
    pressed = Date.now();
    expect(await call(api, "media.control", null, { seek: 30 })).toBeNull();
    expect(controls.splice(0)).toEqual([{ command: "toggle" }, { seek: 30 }]);
    pressed = Date.now();
    expect(await call(api, "clipboard.write", "pnpm test")).toBeNull();
    expect(clipboard.at(-1)).toBe("pnpm test");

    // actions.stop is an act: widget-act.test.ts asks for it. Every other 1.2 verb is called here.
    expect([...called, "actions.stop"].sort()).toEqual(API_VERBS.filter((v) => API[v].since === "1.2").sort());
  });

  it("refuses each without its permission, naming what to add", async () => {
    const api = adapter({});
    expect(await perm(api.call("terminals.usage", []))).toBe('workspace: ["read"]');
    expect(await perm(api.call("stats.query", [{ stat: "agents.turns" }]))).toBe('events: ["agents"]');
    expect(await perm(api.call("journal.days", []))).toBe('workspace: ["read"]');
    expect(await perm(adapter({ workspace: ["read"] }).call("journal.days", []))).toBe('events: ["agents"]');
    expect(await perm(api.call("media.get", []))).toBe('media: ["read"]');
    pressed = Date.now();
    expect(await perm(adapter({ media: ["read"] }).call("media.control", ["toggle"]))).toBe('media: ["control"]');
    pressed = Date.now();
    expect(await perm(api.call("actions.stop", ["dev"]))).toBe('act: ["actions"]');
    // What needs nothing still answers.
    expect(((await api.call("events.classes", [])) as unknown[]).length).toBeGreaterThan(3);
    // A stat of a class anyone reads (commands' lines) needs no events grant.
    expect(await api.call("stats.query", [{ stat: "commands.runs" }])).toMatchObject({ stat: { id: "commands.runs" } });
    expect(await refusal(api.call("stats.query", [{ stat: "no.such" }]))).toMatchObject({ code: "invalid", message: expect.stringMatching(/no stat “no.such”/) });
    expect(await refusal(api.call("stats.query", [{ stat: "commands.runs", range: "forever" }]))).toMatchObject({ code: "invalid" });
  });

  it("sees its own workspace only, unless granted all", async () => {
    const own = adapter({ workspace: ["read"], events: ["ai", "agents"] });
    expect(await perm(own.call("terminals.usage", [{ scope: "all" }]))).toBe('workspace: ["all"]');
    const spy = vi.spyOn(core.stats, "query");
    await own.call("stats.query", [{ stat: "commands.runs", filter: { workspace: B.id, result: "fail" } }]);
    // The workspace is forced; a filter can't name another one.
    expect(spy.mock.calls.at(-1)![0]).toMatchObject({ stat: "commands.runs", workspaceId: A.id, filter: { result: "fail" } });
    expect(await perm(own.call("stats.query", [{ stat: "commands.runs", by: "workspace" }]))).toBe('workspace: ["all"]');
    expect(await perm(own.call("stats.query", [{ stat: "commands.runs", scope: "all" }]))).toBe('workspace: ["all"]');
    // A stat that counts every workspace together (model calls) needs "all".
    expect(await refusal(own.call("stats.query", [{ stat: "ai.calls" }]))).toMatchObject({ permission: 'workspace: ["all"]', message: expect.stringMatching(/counts every workspace together/) });

    const all = adapter({ workspace: ["read", "all"], events: ["ai"] });
    expect(((await all.call("terminals.usage", [{ scope: "all" }])) as { id: string }[]).map((u) => u.id).sort()).toEqual([paneA, paneB].sort());
    expect(((await all.call("terminals.usage", [])) as { id: string }[]).map((u) => u.id)).toEqual([paneA]); // the default is still its own
    await all.call("stats.query", [{ stat: "ai.calls", scope: "all" }]);
    expect(spy.mock.calls.at(-1)![0]).not.toHaveProperty("workspaceId");
    spy.mockRestore();
  });

  it("gives a stat's folder keys as their names", () => {
    const r = { stat: { id: "agents.time", title: "Agent time", description: "", kind: "duration", unit: "ms", dims: [{ id: "project", title: "Project" }], measure: "sum", class: "agents", available: true }, from: 0, to: 1, grain: "day", measure: "sum", buckets: [0], series: [{ key: "dir:/Users/me/src/cmd", label: "cmd", values: [5], total: 5 }], total: 5, ranking: [{ key: "/Users/me/secret/x.ts", label: "x.ts", value: 2 }, { key: "claude", label: "Claude", value: 1 }], asOf: 1 } as StatResult;
    const out = apiStat(r);
    expect(JSON.stringify(out)).not.toContain("/Users/me");
    expect(out.series[0]!.key).toBe("cmd");
    expect(out.ranking!.map((x) => x.key)).toEqual(["x.ts", "claude"]);
  });

  it("controls what plays and writes the clipboard only right after a press on this Mac, once per press", async () => {
    const api = adapter({ media: ["read", "control"] });
    pressed = Date.now() - 60_000;
    expect((await refusal(api.call("media.control", ["next"]))).message).toMatch(/right after the person presses/);
    expect((await refusal(api.call("clipboard.write", ["x"]))).message).toMatch(/right after the person presses/);
    pressed = Date.now();
    expect(await api.call("clipboard.write", ["one"])).toBeNull();
    expect((await refusal(api.call("clipboard.write", ["two"]))).message).toMatch(/right after the person presses/); // the press is taken
    // A paired device's press: never.
    pressed = Date.now();
    remote = true;
    try {
      expect(await refusal(api.call("clipboard.write", ["from the phone"]))).toMatchObject({ code: "denied", message: expect.stringMatching(/paired device/) });
      pressed = Date.now();
      expect(await refusal(api.call("media.control", ["toggle"]))).toMatchObject({ code: "denied" });
    } finally {
      remote = false;
    }
    expect(clipboard).not.toContain("from the phone");
    pressed = Date.now();
    expect(await refusal(api.call("media.control", ["louder"]))).toMatchObject({ code: "invalid" });
    // Text past the limit is cut.
    pressed = Date.now();
    await api.call("clipboard.write", ["x".repeat(CLIPBOARD_MAX + 10)]);
    expect(clipboard.at(-1)!.length).toBe(CLIPBOARD_MAX);
  });

  it("gives events the log's text and actions their run", async () => {
    const api = adapter({ workspace: ["read"] });
    core.data.record({ id: "note-a", at: Date.now() - 1000, type: "note", source: "cmd", workspaceId: A.id, text: "remember the milk", data: { by: "user", agentSession: null } });
    expect(await call(api, "events.query", { types: ["note"] })).toEqual([expect.objectContaining({ type: "note", text: "remember the milk" })]);

    const before = await call(api, "actions.list");
    expect(before.find((a) => a.name === "dev")).toEqual({ name: "dev", title: expect.any(String), risky: false, command: expect.stringContaining("dev"), kind: "dev", package: null, pinned: false, primary: expect.any(Boolean), running: false, terminalId: null, url: null, exitCode: null });
    expect(before.filter((a) => a.primary).length).toBeLessThanOrEqual(1);
    const list = core.actions.list(A.root);
    const dev = list.actions.find((a) => a.name === "dev")!;
    const r = await core.call("actions.run", { root: list.root, actionId: dev.id, workspaceId: A.id });
    expect((await call(api, "actions.list")).find((a) => a.name === "dev")).toMatchObject({ running: true, terminalId: r.paneId, exitCode: null });
  });
});
