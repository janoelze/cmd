// API 1.3's data verbs and topics (docs/57 "1.3 additions" C2–C12; widgets/api/reads.ts,
// topics.ts, adapter.ts's agents.select) against a Core with fixtures: a stat's kind, `many`,
// `asOf` and quantiles (only when asked); the live stat again 1.5 s after the core says it
// changed and each minute for time; the journal of every workspace only with "all", its week,
// entries' projects by name, and the live journal on a write of its scope; workspaces by name
// only, never a folder; events' windowId; agents.select within the widget's reach (a
// subagent's host's terminal) marking the agent seen; cmd's own use with `events: ["system"]`,
// sampled only while someone watches. Each topic stops its work when its subscriber leaves.

import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { noPermissions, type Agent, type ApiMethods, type ApiVerb, type CoreEvent, type JournalDay, type JournalWeek, type StatResult, type WidgetPermissions, type WireValue, type Workspace } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { ApiRefusal } from "../src/widgets/api/access.ts";
import { AiUsage } from "../src/widgets/api/ai.ts";
import { widgetApi, type WidgetApi } from "../src/widgets/api/adapter.ts";
import { apiStat } from "../src/widgets/api/reads.ts";
import { APP_USAGE_MS, STATS_COALESCE_MS, STATS_TIME_MS } from "../src/widgets/api/topics.ts";
import { ProcessSampler } from "../src/terminals/resources.ts";
import { fakeFactory } from "./fake-pty.ts";
import { tmp, writePackage } from "./fake-widget-runtime.ts";

let core: Core;
let A: Workspace;
let B: Workspace;
let windowId: string;
let paneA: string;
let paneB: string;
const events: CoreEvent[] = [];

function adapter(permissions: Partial<WidgetPermissions>, o: { processes?: ProcessSampler } = {}): WidgetApi {
  const pkg = core.library.packages.forKind("pkg:demo/main")!;
  const ctx = { agents: core.agents, panes: core.panes, windows: core.windows, windowTypes: core.windowTypes, workspaces: core.workspaces, data: core.data, actions: core.actions, notifications: core.notifications, ai: core.ai, settings: core.settings, resources: core.resources, stats: core.stats, journal: core.journal, processes: o.processes ?? core.processes, commands: core.commands, broadcast: (e: CoreEvent) => void events.push(e), opened: <W>(w: W) => w, call: core.call.bind(core) as never };
  return widgetApi(ctx, { windowId, workspaceId: () => A.id, pkg, widget: pkg.widgets[0]!, permissions: { ...noPermissions(), ...permissions }, press: { at: () => 0, remote: () => false, take: () => {} }, secret: () => null, aiUsage: new AiUsage(null) });
}

async function call<V extends ApiVerb>(api: WidgetApi, verb: V, ...params: ApiMethods[V]["params"]): Promise<ApiMethods[V]["result"]> {
  return (await api.call(verb, params as WireValue[])) as ApiMethods[V]["result"];
}

async function refusal(p: Promise<unknown> | (() => unknown)): Promise<ApiRefusal["error"]> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (e instanceof ApiRefusal) return e.error;
    throw e;
  }
  throw new Error("it wasn't refused");
}

/** A subscription's pushes. */
function watch(api: WidgetApi, topic: string, query?: unknown) {
  const got: WireValue[] = [];
  const stop = api.subscribe(topic, query ?? null, (d) => void got.push(d));
  return { got, stop };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

const DAY: JournalDay = {
  date: new Date(new Date().setHours(0, 0, 0, 0)).getTime(),
  scope: "x",
  headline: "Shipped the footer",
  entries: [{ id: "e1", kind: "feature", title: "Built the footer", summary: "And its tests.", outcome: "merged", start: 1, end: 2, repo: "/Users/me/src/cmd", threads: ["t1"], counts: { agents: 1, prompts: 2, commands: 3, commits: 1, pages: 0, files: 4 } }],
  writtenBy: "a model",
  writtenAt: 5,
  format: { schema: 1, threads: 1, writer: 1 },
  eventsHash: "h",
  inputHash: "i",
  minor: 0,
};

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
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "x" }));
  A = core.workspaces.open(repo).workspace;
  B = core.workspaces.open(tmp("cmd-widget-other-")).workspace;
  windowId = core.windows.open("pkg:demo/main", {}, A).id;
  paneA = core.panes.create({ workspaceId: A.id, cwd: repo }).id;
  paneB = core.panes.create({ workspaceId: B.id }).id;
});

afterAll(async () => {
  await core?.close();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("API 1.3: stats", () => {
  it("names a stat's kind and its many-valued dimensions, says when it was counted, and gives quantiles only when asked", async () => {
    const api = adapter({ workspace: ["read"], events: ["output"] });
    const r = await call(api, "stats.query", { stat: "commands.runs", range: "7d" });
    expect(r.stat).toMatchObject({ id: "commands.runs", kind: "count" });
    expect(r.stat.dims).toContainEqual({ id: "command", title: "Command", many: true });
    expect(r.stat.dims.find((d) => d.id === "result")).not.toHaveProperty("many");
    expect(r.asOf).toEqual(expect.any(Number));
    expect((await call(api, "stats.query", { stat: "commands.failrate" })).stat.kind).toBe("rate");
    expect((await call(api, "stats.query", { stat: "commands.duration" })).stat.kind).toBe("distribution");

    // Quantiles: the core's, only with `quantiles: true`.
    const base = core.stats.query({ stat: "commands.duration", workspaceId: A.id });
    const withQ: StatResult = { ...base, quantiles: { p50: 1200, p90: 9000 } };
    expect(apiStat(withQ)).not.toHaveProperty("quantiles");
    expect(apiStat(withQ, { quantiles: true }).quantiles).toEqual({ p50: 1200, p90: 9000 });
    vi.spyOn(core.stats, "query").mockReturnValue(withQ);
    expect(await call(api, "stats.query", { stat: "commands.duration" })).not.toHaveProperty("quantiles");
    expect((await call(api, "stats.query", { stat: "commands.duration", quantiles: true })).quantiles).toEqual({ p50: 1200, p90: 9000 });
  });

  it("is live: counted again 1.5 s after the core says that stat changed, each minute for time spent, and not after unsubscribing", async () => {
    const api = adapter({ workspace: ["read"], events: ["output", "agents"] });
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    const real = core.stats.query.bind(core.stats);
    let n = 0;
    const query = vi.spyOn(core.stats, "query").mockImplementation((q) => ({ ...real(q), asOf: ++n }));
    const runs = watch(api, "stats", { stat: "commands.runs" });
    await flush();
    expect(runs.got).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
    // Another stat changed: nothing. This one: read again after the Stats window's wait, once for a burst.
    core.stats.emit("changed", ["git.commits"]);
    core.stats.emit("changed", ["commands.runs"]);
    core.stats.emit("changed", ["commands.runs", "git.commits"]);
    vi.advanceTimersByTime(STATS_COALESCE_MS - 1);
    expect(query).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await flush();
    expect(query).toHaveBeenCalledTimes(2);
    expect(runs.got).toHaveLength(2);
    // A count doesn't grow by itself: no minute's read.
    vi.advanceTimersByTime(STATS_TIME_MS);
    expect(query).toHaveBeenCalledTimes(2);
    // Time spent grows without events: read each minute.
    const time = watch(api, "stats", { stat: "agents.time" });
    expect(query).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(STATS_TIME_MS + STATS_COALESCE_MS);
    expect(query).toHaveBeenCalledTimes(4);
    // Gone: no listener, no timer.
    runs.stop();
    time.stop();
    expect(core.stats.listenerCount("changed")).toBe(0);
    core.stats.emit("changed", ["commands.runs", "agents.time"]);
    vi.advanceTimersByTime(2 * STATS_TIME_MS);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("refuses a live stat the grant doesn't reach, before listening", async () => {
    const api = adapter({ workspace: ["read"] });
    expect(await refusal(() => api.subscribe("stats", { stat: "agents.turns" }, () => {}))).toMatchObject({ code: "permission", permission: 'events: ["agents"]' });
    expect(core.stats.listenerCount("changed")).toBe(0);
  });
});

describe("API 1.3: the journal", () => {
  it("reads every workspace's only with workspace: [\"all\"], names projects by folder, and reads the week without writing it", async () => {
    const days = vi.spyOn(core.journal, "days").mockResolvedValue([DAY]);
    const own = adapter({ workspace: ["read"], events: ["agents"] });
    const [day] = await call(own, "journal.days", {});
    expect(days).toHaveBeenLastCalledWith(`workspace:${A.id}`, 7, "never");
    // A project by its folder's name: never the path.
    expect(day!.entries[0]).toMatchObject({ title: "Built the footer", project: "cmd" });
    expect(JSON.stringify(day)).not.toContain("/Users/me");
    expect(await refusal(call(own, "journal.days", { scope: "all" }))).toMatchObject({ code: "permission", permission: 'workspace: ["all"]' });
    const all = adapter({ workspace: ["read", "all"], events: ["agents"] });
    await call(all, "journal.days", { scope: "all", count: 3 });
    expect(days).toHaveBeenLastCalledWith("all", 3, "never");

    const w: JournalWeek = { start: 100, scope: "all", headline: "A week of footers", themes: [{ title: "Footer", summary: "Built it.", entries: [{ day: 1, entry: "e1" }] }], days: [1], writtenBy: "m", writtenAt: 200, format: 1, daysHash: "x" };
    const week = vi.spyOn(core.journal, "week").mockResolvedValue(w);
    expect(await call(own, "journal.week")).toEqual({ start: 100, headline: "A week of footers", themes: [{ title: "Footer", summary: "Built it." }], writtenAt: 200 });
    expect(week).toHaveBeenLastCalledWith(`workspace:${A.id}`, expect.any(Number), "never");
    await call(all, "journal.week", { scope: "all" });
    expect(week).toHaveBeenLastCalledWith("all", expect.any(Number), "never");
    expect(await refusal(call(own, "journal.week", { scope: "all" }))).toMatchObject({ permission: 'workspace: ["all"]' });
    week.mockResolvedValue(null);
    expect(await call(own, "journal.week")).toBeNull();
    // The journal reads agents' work: events: ["agents"], for the week too.
    const blind = adapter({ workspace: ["read"] });
    expect(await refusal(call(blind, "journal.week"))).toMatchObject({ permission: 'events: ["agents"]' });
  });

  it("is live: read again when a day of its scope is written, not another's, and not after unsubscribing", async () => {
    const days = vi.spyOn(core.journal, "days").mockResolvedValue([DAY]);
    const api = adapter({ workspace: ["read", "all"], events: ["agents"] });
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    const mine = watch(api, "journal", { count: 2 });
    await flush();
    expect(mine.got).toEqual([[expect.objectContaining({ headline: "Shipped the footer" })]]);
    expect(days).toHaveBeenCalledTimes(1);
    core.journal.emit("written", `workspace:${B.id}`);
    core.journal.emit("written", "all");
    vi.advanceTimersByTime(5000);
    expect(days).toHaveBeenCalledTimes(1);
    days.mockResolvedValue([{ ...DAY, headline: "And the header" }]);
    core.journal.emit("written", `workspace:${A.id}`);
    core.journal.emit("written", `workspace:${A.id}`);
    vi.advanceTimersByTime(5000);
    await flush();
    expect(days).toHaveBeenCalledTimes(2);
    expect(mine.got.at(-1)).toEqual([expect.objectContaining({ headline: "And the header" })]);
    // Every workspace's journal follows "all"'s writes.
    const all = watch(api, "journal", { scope: "all" });
    core.journal.emit("written", "all");
    vi.advanceTimersByTime(5000);
    expect(days).toHaveBeenLastCalledWith("all", 7, "never");
    mine.stop();
    all.stop();
    expect(core.journal.listenerCount("written")).toBe(0);
    // Without the agents class, the live journal is refused as the verb is.
    expect(await refusal(() => adapter({ workspace: ["read"] }).subscribe("journal", {}, () => {}))).toMatchObject({ permission: 'events: ["agents"]' });
  });

  it("re-reads on writes without spending the widget's calls", async () => {
    vi.spyOn(core.journal, "days").mockResolvedValue([DAY]);
    const api = adapter({ workspace: ["read"], events: ["agents"] });
    for (let i = 0; i < 10; i++) await call(api, "journal.days");
    expect(await refusal(call(api, "journal.days"))).toMatchObject({ code: "failed", message: expect.stringContaining("at most 10 a minute") });
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    const live = adapter({ workspace: ["read"], events: ["agents"] });
    // Its first read is a read as any other (8 + 1); the three after writes aren't.
    for (let i = 0; i < 8; i++) await call(live, "journal.days");
    const w = watch(live, "journal");
    for (let i = 0; i < 3; i++) {
      core.journal.emit("written", `workspace:${A.id}`);
      vi.advanceTimersByTime(5000);
      await flush();
    }
    w.stop();
    expect(await call(live, "journal.days")).toHaveLength(1);
  });
});

describe("API 1.3: workspaces, events, agents", () => {
  it("lists workspaces by id and name only, with workspace: [\"all\"], live", async () => {
    expect(await refusal(call(adapter({ workspace: ["read"] }), "workspaces.list"))).toMatchObject({ code: "permission", permission: 'workspace: ["all"]' });
    const api = adapter({ workspace: ["read", "all"] });
    const list = await call(api, "workspaces.list");
    expect(list).toEqual(core.workspaces.list().map((w) => ({ id: w.id, name: w.name })));
    expect(list.every((w) => Object.keys(w).sort().join() === "id,name")).toBe(true);
    expect(JSON.stringify(list)).not.toContain(A.root);
    const live = watch(api, "workspaces");
    await flush();
    expect(live.got).toHaveLength(1);
    core.workspaces.update(B.id, { name: "Elsewhere" });
    await new Promise((r) => setTimeout(r, 120));
    expect(live.got.at(-1)).toContainEqual({ id: B.id, name: "Elsewhere" });
    live.stop();
    expect(await refusal(() => adapter({ workspace: ["read"] }).subscribe("workspaces", null, () => {}))).toMatchObject({ permission: 'workspace: ["all"]' });
  });

  it("says which window an event is about", async () => {
    core.data.record({ id: "notification:w1", at: Date.now(), type: "notification", source: "cmd", workspaceId: A.id, windowId, text: "Done", data: { source: "widget", title: "Done", body: "", urgent: false } });
    const api = adapter({ workspace: ["read"] });
    const [e] = await call(api, "events.query", { types: ["notification"] });
    expect(e).toMatchObject({ type: "notification", windowId });
  });

  it("selects an agent's terminal (a subagent's host's) and marks that agent seen, within its reach", async () => {
    core.agents.ingestHook(paneA, "claude", "UserPromptSubmit", { session_id: "s-a", prompt: "go" });
    core.agents.ingestHook(paneB, "claude", "UserPromptSubmit", { session_id: "s-b", prompt: "go" });
    const here = core.agents.list().find((a) => a.paneId === paneA)!;
    const there = core.agents.list().find((a) => a.paneId === paneB)!;
    const api = adapter({});
    events.length = 0;
    expect(await call(api, "agents.select", here.id)).toBeNull();
    expect(events).toContainEqual({ type: "window.focus", id: paneA });
    expect(core.agents.get(here.id)!.seenAt).toEqual(expect.any(Number));
    // Another workspace's: only with "all".
    expect(await refusal(call(api, "agents.select", there.id))).toMatchObject({ code: "invalid" });
    expect(await refusal(call(api, "agents.select", "nobody"))).toMatchObject({ code: "invalid" });
    expect(await call(adapter({ workspace: ["read", "all"] }), "agents.select", there.id)).toBeNull();
    expect(events).toContainEqual({ type: "window.focus", id: paneB });
    // A subagent has no terminal: its host's is shown, and the subagent is the one marked seen.
    const sub = { ...here, id: "sub-1", paneId: null, parentId: here.id, depth: 1 } as Agent;
    const get = core.agents.get.bind(core.agents);
    vi.spyOn(core.agents, "get").mockImplementation((id) => (id === "sub-1" ? sub : get(id)));
    const seen = vi.spyOn(core.agents, "markSeen").mockImplementation(() => {});
    events.length = 0;
    await call(api, "agents.select", "sub-1");
    expect(events).toEqual([{ type: "window.focus", id: paneA }]);
    expect(seen).toHaveBeenCalledWith("sub-1");
  });
});

describe("API 1.3: cmd's own use", () => {
  /** A sampler over fake processes: the app's tree holds this core's (it started it); CPU grows 1 s of CPU per call. */
  function sampler() {
    let tick = 0;
    const app = process.ppid;
    const trees = vi.fn(async (pids: number[]) => {
      tick++;
      return pids.map((pid) => ({ pid, mem: pid === app ? 900 * 2 ** 20 : 300 * 2 ** 20, cpu: tick * (pid === app ? 2e9 : 1e9), procs: 3, top: [] }));
    });
    const procs = vi.fn(async (pids: number[]) => pids.map((pid) => ({ pid, mem: 100 * 2 ** 20, cpu: tick * 1e8 })));
    const s = new ProcessSampler(procs, trees);
    return { s, app, trees, procs };
  }

  it("needs events: [\"system\"]; adds up the app without the core it started, and the background", async () => {
    const { s, app } = sampler();
    expect(await refusal(call(adapter({ workspace: ["read"] }, { processes: s }), "app.usage"))).toMatchObject({ code: "permission", permission: 'events: ["system"]' });
    const api = adapter({ events: ["system"] }, { processes: s });
    // No app told cmd its process: the app is unknown, the background isn't.
    const before = await call(api, "app.usage");
    expect(before).toMatchObject({ app: null, background: { memory: 100 * 2 ** 20, cpu: expect.any(Number) }, at: expect.any(Number) });
    s.attach(app);
    // A first sample waits for a second, so CPU is real; the core's tree is taken out of the app's.
    const u = await call(api, "app.usage");
    expect(u.app).toEqual({ memory: 600 * 2 ** 20, cpu: expect.any(Number) });
    expect(u.app!.cpu).toBeGreaterThan(0);
    // With no procinfo, nothing to tell.
    expect(await call(adapter({ events: ["system"] }, { processes: null as never }), "app.usage")).toMatchObject({ app: null, background: null });
  });

  it("is live: sampled every 2 s while subscribed, shared between subscribers, and not after the last leaves", async () => {
    const { s, app, procs } = sampler();
    s.attach(app);
    const own = vi.spyOn(s, "own");
    const api = adapter({ events: ["system"] }, { processes: s });
    const one = watch(api, "appUsage");
    await vi.waitFor(() => expect(one.got).toHaveLength(1), { timeout: 3000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    const two = watch(api, "appUsage");
    const calls = own.mock.calls.length;
    vi.advanceTimersByTime(APP_USAGE_MS + 100);
    await flush();
    expect(own.mock.calls.length).toBeGreaterThan(calls);
    one.stop();
    two.stop();
    const sampled = procs.mock.calls.length;
    vi.advanceTimersByTime(10 * APP_USAGE_MS);
    await flush();
    expect(procs.mock.calls.length).toBe(sampled);
  });
});
