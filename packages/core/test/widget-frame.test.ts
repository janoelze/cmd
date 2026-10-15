// Frame widgets in the core (docs/56, "The frame surface"; widgets/host/frame.ts): a frame
// widget's process runs as a tree widget's does (it fills the title bar); widget.frameSource
// gives its window the package folder and its grant's hosts, nothing before the grant;
// widget.frame serves every verb of the API through the window's own API (the process's
// adapter: its grant, scope and limits), refusing what the grant lacks as the process is
// refused; a verb that needs a press takes the frame's own (the app's gesture rule, at most one
// a second), one act or window per press; widget.frameSubscribe is the process's live topic,
// pushed to the connection that asked until it unsubscribes, closes, or the widget stops. A
// tree's Frame elements (1.2) reach the same API; a page a Frame names that isn't in the package
// is one line in the widget's log.

import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { API, API_VERBS, API_TOPICS, needsPress, type ApiVerb, type AppWindow, type CoreEvent, type TreeNode, type WidgetFrameResult, type WidgetPermissions } from "@cmd/protocol";
import type { Connection } from "../src/kernel/connection.ts";
import { Core } from "../src/kernel/core.ts";
import { fakeFactory } from "./fake-pty.ts";
import { FakeWidgetRuntime, tmp, until, writePackage, type FakePackage } from "./fake-widget-runtime.ts";

const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close();
});

async function setup(pkgs: FakePackage[], o: { runtime?: boolean } = {}) {
  const home = tmp("cmd-widgets-home-");
  for (const p of pkgs) writePackage(home, p);
  process.env.CMD_WIDGETS_HOME = home;
  const core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, stateDir: tmp("cmd-state-") });
  delete process.env.CMD_WIDGETS_HOME;
  cores.push(core);
  const rt = new FakeWidgetRuntime(core.widgetTokens);
  core.library.host.configure({ runtime: o.runtime === false ? null : rt, times: { pingMs: 20, stallMs: 1000, stopAfterMs: 100, restartMs: 5, helloMs: 2000 } });
  core.library.host.fetchImpl = (async () => new Response("hi", { status: 200 })) as unknown as typeof fetch;
  core.start();
  await core.scheduler.idle();
  const open = async (ref = "pkg:radio/main") => (await core.handlers["widget.add"]({ ref, workspaceId: core.workspaces.home().id })) as AppWindow;
  /** The app's connection: the events it gets. */
  const events: CoreEvent[] = [];
  const conn: Connection = { access: "local", send: (line) => {
    const m = JSON.parse(line) as { method?: string; params?: CoreEvent };
    if (m.method === "event" && m.params) events.push(m.params);
  }, close: () => {} };
  const served = core.serve(conn);
  const ctx = { conn };
  const call = (windowId: string, verb: string, params: unknown[] = [], pressed = false, frame = "f1") => core.handlers["widget.frame"]({ windowId, frame, verb, params, pressed }, ctx) as Promise<WidgetFrameResult>;
  const frameEvents = (windowId: string, sub: number) => events.filter((e): e is Extract<CoreEvent, { type: "widget.frameEvent" }> => e.type === "widget.frameEvent" && e.windowId === windowId && e.sub === sub);
  return { core, rt, home, open, call, conn, served, ctx, events, frameEvents };
}

/** Every permission there is, for a frame widget that may do everything. */
const FULL: Partial<WidgetPermissions> = { workspace: ["read", "all"], events: ["agents"], net: ["example.com"], ai: ["complete"], run: ["ps"], act: ["agents", "terminals", "actions", "windows"], media: ["read", "control"] };

/** Arguments that answer at once for each verb (an id that isn't there, a query of a class to declare). */
const ARGS: { [V in ApiVerb]: unknown[] } = {
  "workspace.get": [], "workspace.windows": [], "workspace.selected": [], "agents.list": [], "agents.get": ["a-none"],
  "terminals.list": [], "terminals.read": ["p-none"], "terminals.waitFor": ["p-none", "x"], "windows.list": [], "windows.open": ["https://example.com/"],
  "windows.select": ["w-none"], "events.query": [{ types: ["agent.hook"] }], "events.stats": [{ types: ["agent.hook"] }], "git.status": [], "git.diff": [], "git.worktrees": [],
  "actions.list": [], "notify.send": [{ key: "k", title: "Hi" }], "state.get": ["k"], "state.set": ["k", 1], "state.history": ["k", 1], "net.fetch": ["https://example.com/"],
  "ai.complete": [{ prompt: "hi" }], "agents.start": [{ kind: "claude" }], "agents.send": ["a-none", "hi"], "agents.stop": ["a-none"], "terminals.type": ["p-none", "ls"],
  "terminals.open": [{}], "actions.run": ["none"], "windows.close": ["w-none"], "run.exec": ["ps", "not a list"],
  "actions.stop": ["none"], "events.classes": [], "terminals.usage": [], "stats.query": [{ stat: "agents.turns" }], "journal.days": [{ count: 1 }], "media.get": [], "media.control": ["toggle"], "clipboard.write": ["hi"],
  "storage.get": ["package", "k"], "storage.set": ["package", "k", 1], "storage.delete": ["package", "k"], "storage.keys": ["package"], "storage.history": ["package", "k", 1],
};

describe("frame widgets", () => {
  it("run their process, and their window gets the package folder and the grant's hosts once granted", async () => {
    const { core, rt, home, open } = await setup([{ name: "radio", surface: "frame", permissions: { net: ["stream.example.com"] } }]);
    expect((await core.handlers["widget.list"]({})).find((e) => e.kind === "pkg:radio/main")?.surface).toBe("frame");
    const w = await open();
    expect(core.library.host.status(w.id)?.state).toBe("waiting-grant");
    expect(await core.handlers["widget.frameSource"]({ windowId: w.id })).toBeNull(); // nothing before the grant
    core.library.host.grant("radio");
    await until(() => core.library.host.status(w.id)?.state === "running", "the frame widget's process");
    expect(rt.procs).toHaveLength(1);
    expect(await core.handlers["widget.frameSource"]({ windowId: w.id })).toEqual({ dir: fs.realpathSync(`${home}/radio`), media: ["stream.example.com"] });
  });

  it("serves state.set into the window's state, without Deno too, and nothing for a tree widget's window", async () => {
    const { core, open, call } = await setup([{ name: "radio", surface: "frame" }, { name: "tree" }], { runtime: false });
    const w = await open();
    expect(core.library.host.status(w.id)?.state).toBe("stopped"); // can't run here: the page still has its API
    expect(await call(w.id, "state.set", ["volume", 0.4])).toEqual({ ok: true, value: null });
    expect(core.windows.others().find((x) => x.id === w.id)?.state.kv).toEqual({ volume: 0.4 });
    expect(await call(w.id, "state.get", ["volume"])).toEqual({ ok: true, value: 0.4 });
    const t = await open("pkg:tree/main");
    expect(await core.handlers["widget.frameSource"]({ windowId: t.id })).toBeNull();
    await expect(call(t.id, "state.set", ["x", 1])).rejects.toThrow(/not a frame widget/);
  });

  it("reaches every verb of the API with its grant, and is refused each one the grant lacks, as the process is", async () => {
    const { core, open, call } = await setup([{ name: "full", surface: "frame", permissions: FULL }, { name: "bare", surface: "frame" }]);
    core.library.host.grant("full");
    const full = await open("pkg:full/main");
    const bare = await open("pkg:bare/main");
    for (const v of API_VERBS) {
      const row = API[v];
      const got = await call(full.id, v, ARGS[v]);
      // With the grant, nothing is refused for a permission: it answers, or says what's wrong with the call, or wants a press.
      if (!got.ok) expect(got.error.code, `${v} with its grant: ${got.error.message}`).not.toBe("permission");
      if (needsPress(v)) expect(got.ok ? "" : got.error.message, v).toMatch(/right after the person presses/);
      const without = await call(bare.id, v, ARGS[v]);
      if (row.needs === null) expect(without.ok || without.error.code !== "permission", `${v} needs nothing`).toBe(true);
      else if (needsPress(v) && row.needs === "act") expect(without).toMatchObject({ ok: false, error: { code: "permission", permission: `act: ["${v.split(".")[0]}"]` } });
      else expect(without, `${v} without ${row.needs}`).toMatchObject({ ok: false, error: { code: "permission" } });
    }
    // An unknown verb is refused as the process's is.
    expect(await call(full.id, "files.write", ["/etc/hosts", "x"])).toMatchObject({ ok: false, error: { code: "unknown" } });
  });

  it("shares the process's limits: a frame and its process count against one budget", async () => {
    const { core, open, call } = await setup([{ name: "radio", surface: "frame", permissions: { net: ["example.com"] } }]);
    core.library.host.grant("radio");
    const w = await open();
    await until(() => core.library.host.status(w.id)?.state === "running", "the process");
    const api = core.library.host.api(w.id)!;
    for (let i = 0; i < 30; i++) await api.call("net.fetch", ["https://example.com/"]); // the process's half
    for (let i = 0; i < 30; i++) expect((await call(w.id, "net.fetch", ["https://example.com/"])).ok).toBe(true);
    expect(await call(w.id, "net.fetch", ["https://example.com/"])).toMatchObject({ ok: false, error: { message: expect.stringMatching(/at most 60 a minute/) } });
  });

  it("opens a window only with a press the app saw, one per press and at most one a second; the process's press isn't the frame's", async () => {
    const { core, open, call } = await setup([{ name: "radio", surface: "frame", permissions: { workspace: ["read"] } }]);
    core.library.host.grant("radio");
    const w = await open();
    const count = () => core.windows.others().length;
    const before = count();
    expect(await call(w.id, "windows.open", ["https://example.com/"])).toMatchObject({ ok: false, error: { message: expect.stringMatching(/right after the person presses/) } });
    expect(count()).toBe(before);
    const r = await call(w.id, "windows.open", ["https://example.com/"], true);
    expect(r.ok).toBe(true);
    expect(core.windows.others().find((x) => x.id === (r as unknown as { value: { id: string } }).value.id)?.kind).toBe("browser");
    // A second press within the second: none.
    expect((await call(w.id, "windows.open", ["https://example.com/"], true)).ok).toBe(false);
    expect(count()).toBe(before + 1);
    // Another frame of the window has presses of its own.
    expect((await call(w.id, "windows.open", ["https://example.com/b"], true, "f2")).ok).toBe(true);
    // A press marked on a read doesn't arm anything.
    expect((await call(w.id, "windows.list", [], true, "f3")).ok).toBe(true);
    expect((await call(w.id, "windows.open", ["https://example.com/c"], false, "f3")).ok).toBe(false);
    expect(count()).toBe(before + 2);
  });

  it("asks for an act after a press, once per press, and refuses one without", async () => {
    const { core, open, call, events, served } = await setup([{ name: "radio", surface: "frame", permissions: { workspace: ["read"], act: ["terminals"] } }]);
    served.receive(JSON.stringify({ id: 1, method: "events.subscribe", params: {} }));
    core.library.host.grant("radio");
    const w = await open();
    const terminals = () => core.panes.list().length;
    const before = terminals();
    expect(await call(w.id, "terminals.open", [{ command: "ls" }])).toMatchObject({ ok: false, error: { code: "invalid", message: expect.stringMatching(/right after the person presses/) } });
    const pending = call(w.id, "terminals.open", [{ command: "ls" }], true);
    const waiting = () => events.find((e): e is Extract<CoreEvent, { type: "tool.acting" }> => e.type === "tool.acting" && e.call.state === "waiting");
    await until(waiting, "the ask");
    const asked = waiting()!;
    expect(asked.call.approval?.widget).toBeTruthy();
    await core.call("approvals.answer", { workspaceId: asked.call.workspaceId, itemId: asked.call.id, allow: true });
    expect((await pending).ok).toBe(true);
    expect(terminals()).toBe(before + 1);
    await new Promise((r) => setTimeout(r, 1050));
    // The press went with that act: the next call needs a press of its own.
    expect((await call(w.id, "terminals.open", [{ command: "ls" }])).ok).toBe(false);
    expect(terminals()).toBe(before + 1);
  });

  it("pushes a live topic to the connection that asked, until it unsubscribes, the window closes or the connection does", async () => {
    const { core, open, ctx, conn, served, frameEvents } = await setup([{ name: "radio", surface: "frame", permissions: { workspace: ["read"] } }, { name: "bare", surface: "frame" }]);
    core.library.host.grant("radio");
    const w = await open();
    const sub = (windowId: string, s: number, topic: string, query?: unknown) => core.handlers["widget.frameSubscribe"]({ windowId, frame: "f1", sub: s, topic, query }, ctx);
    expect(await sub(w.id, 1, "windows")).toEqual({ ok: true, value: null });
    await until(() => frameEvents(w.id, 1).length === 1, "the first value");
    expect((frameEvents(w.id, 1)[0]!.data as { id: string }[]).some((x) => x.id === w.id)).toBe(true);
    // A change is pushed.
    const other = await core.handlers["window.open"]({ kind: "browser", input: { url: "https://example.com/" }, workspaceId: core.workspaces.home().id });
    await until(() => frameEvents(w.id, 1).some((e) => (e.data as { id: string }[] | undefined)?.some((x) => x.id === (other as AppWindow).id)), "the new window");
    // Unsubscribed: nothing more.
    await core.handlers["widget.frameUnsubscribe"]({ windowId: w.id, frame: "f1", sub: 1 }, ctx);
    const n = frameEvents(w.id, 1).length;
    await core.handlers["window.open"]({ kind: "browser", input: { url: "https://example.com/2" }, workspaceId: core.workspaces.home().id });
    await new Promise((r) => setTimeout(r, 150));
    expect(frameEvents(w.id, 1).length).toBe(n);
    expect(core.library.host.frames.count()).toBe(0);

    // Refused as the process is: a topic the grant doesn't reach, every workspace without "all".
    const bare = await open("pkg:bare/main");
    expect(await sub(bare.id, 2, "agents")).toMatchObject({ ok: false, error: { code: "permission", permission: 'workspace: ["read"]' } });
    expect(await sub(w.id, 3, "agents", { scope: "all" })).toMatchObject({ ok: false, error: { code: "permission", permission: 'workspace: ["all"]' } });
    expect(await sub(w.id, 4, "pages")).toMatchObject({ ok: false, error: { code: "unknown" } });
    for (const t of API_TOPICS.filter((t) => t !== "events")) expect((await sub(w.id, 10, t, t === "storage" ? { scope: "package", key: "k" } : undefined)).ok, t).toBe(true);
    expect(core.library.host.frames.count()).toBe(1); // one sub id, each replaced

    // The frame goes: every one of its subscriptions with it.
    await sub(w.id, 11, "agents");
    await core.handlers["widget.frameUnsubscribe"]({ windowId: w.id, frame: "f1" }, ctx);
    expect(core.library.host.frames.count()).toBe(0);

    // The window closes: its frames are told, and their subscriptions end.
    await sub(w.id, 5, "terminals");
    await core.handlers["window.close"]({ id: w.id });
    await until(() => frameEvents(w.id, 5).some((e) => e.end), "the end");
    expect(core.library.host.frames.count()).toBe(0);

    // The connection closes: its subscriptions go.
    const w2 = await open();
    await sub(w2.id, 6, "agents");
    expect(core.library.host.frames.count()).toBe(1);
    served.closed();
    expect(core.library.host.frames.count()).toBe(0);
    void conn;
  });

  it("ends a frame's subscriptions when the widget's process stops or its grant changes", async () => {
    const { core, open, ctx, frameEvents } = await setup([{ name: "radio", surface: "frame", permissions: { workspace: ["read"] } }]);
    core.library.host.grant("radio");
    const w = await open();
    await until(() => core.library.host.status(w.id)?.state === "running", "the process");
    await core.handlers["widget.frameSubscribe"]({ windowId: w.id, frame: "f1", sub: 1, topic: "agents" }, ctx);
    core.library.host.restart(w.id);
    await until(() => frameEvents(w.id, 1).some((e) => e.end), "the end on a restart");
    expect(core.library.host.frames.count()).toBe(0);
    // The window's new API takes the same subscription again (the app asks at once, frame-api.ts).
    expect(await core.handlers["widget.frameSubscribe"]({ windowId: w.id, frame: "f1", sub: 1, topic: "agents" }, ctx)).toEqual({ ok: true, value: null });
    expect(frameEvents(w.id, 1).at(-1)?.data).toEqual([]);
  });

  it("gives a frame with no process to run a new API on Restart, which its subscriptions are asked for again on", async () => {
    const { core, open, ctx, frameEvents } = await setup([{ name: "radio", surface: "frame", permissions: { workspace: ["read"] } }], { runtime: false });
    core.library.host.grant("radio");
    const w = await open();
    const before = core.library.host.api(w.id);
    await core.handlers["widget.frameSubscribe"]({ windowId: w.id, frame: "f1", sub: 1, topic: "windows" }, ctx);
    core.library.host.restart(w.id);
    expect(frameEvents(w.id, 1).at(-1)?.end?.message).toMatch(/stopped/);
    expect(core.library.host.api(w.id)).not.toBe(before);
    expect(await core.handlers["widget.frameSubscribe"]({ windowId: w.id, frame: "f1", sub: 1, topic: "windows" }, ctx)).toEqual({ ok: true, value: null });
    await core.handlers["window.open"]({ kind: "browser", input: { url: "https://example.com/" }, workspaceId: core.workspaces.home().id });
    await until(() => (frameEvents(w.id, 1).at(-1)?.data as unknown[] | undefined)?.length === 2, "the new window, through the new API");
  });

  it("serves a tree widget's Frame elements: its pages reach the window's API, and what a page posts is the process's onMessage, never a press", async () => {
    const { core, rt, home, open, call } = await setup([{ name: "chart", permissions: { workspace: ["read"], act: ["terminals"] } }]);
    core.library.host.grant("chart");
    // The process draws a Frame (its onMessage handler 1) and a button (handler 2).
    rt.boot = (p) =>
      void p.connect().hello().send({ kind: "tree", rev: 1, nodes: [{ id: 1, type: "View", props: {}, children: [{ id: 2, type: "Frame", props: { src: "chart.html", label: "Chart", data: { values: [1, 2] }, onMessage: { $handler: 1 } }, children: [] }, { id: 3, type: "Button", props: { label: "Go", onClick: { $handler: 2 } }, children: [] }] }] });
    const w = await open("pkg:chart/main");
    await until(() => core.library.host.status(w.id)?.state === "running", "the process");
    await until(() => core.library.host.frames.source(w.id), "the tree with its Frame");
    expect(core.library.host.frames.source(w.id)).toEqual({ dir: fs.realpathSync(`${home}/chart`), media: [] });
    expect((await call(w.id, "agents.list")).ok).toBe(true);
    // The page posts: the process gets onMessage with the value; it is no press, so an act after it is refused.
    core.library.host.interact(w.id, 1, "onMessage", { picked: 1 });
    const got = await rt.last.next("interaction", (m) => m.event === "onMessage");
    expect(got).toMatchObject({ handler: 1, value: { picked: 1 } });
    rt.last.send({ kind: "call", id: 9, method: "terminals.open", params: [{}] });
    expect(await rt.last.next("result", (m) => m.id === 9)).toMatchObject({ ok: false, error: { code: "invalid", message: expect.stringMatching(/right after the person presses/) } });
    // A tree without a Frame: no frames for that window.
    rt.last.send({ kind: "tree", rev: 2, nodes: [{ id: 5, type: "View", props: {}, children: [] }] });
    await until(() => !core.library.host.frames.source(w.id), "no Frame any more");
    await expect(call(w.id, "agents.list")).rejects.toThrow(/not a frame widget/);
  });

  it("tells the widget's log once when a tree's Frame names a page that isn't in the package", async () => {
    const { rt, home, open, served, events } = await setup([{ name: "chart" }]);
    fs.writeFileSync(`${home}/chart/chart.html`, "<canvas></canvas>");
    served.receive(JSON.stringify({ id: 1, method: "events.subscribe", params: {} }));
    const frame = (id: number, src: string): TreeNode => ({ id, type: "Frame", props: { src, label: src }, children: [] });
    rt.boot = (p) => void p.connect().hello().send({ kind: "tree", rev: 1, nodes: [{ id: 1, type: "View", props: {}, children: [frame(2, "chart.html"), frame(3, "meter.html")] }] });
    const w = await open("pkg:chart/main");
    const lines = () => events.filter((e): e is Extract<CoreEvent, { type: "widget.log" }> => e.type === "widget.log" && e.windowId === w.id).map((e) => e.message);
    await until(() => lines().length, "the line");
    // A patch that keeps the tree as it is says nothing again.
    rt.last.send({ kind: "patch", rev: 2, ops: [{ op: "props", id: 2, set: { label: "Chart" }, unset: [] }] });
    await new Promise((r) => setTimeout(r, 50));
    expect(lines()).toEqual(["Frame: meter.html isn't in this package"]);
  });
});
