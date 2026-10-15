// Package widgets' processes (docs/56, "The runtime: a widget process"; widgets/host/) with a
// fake runtime: one process per window, started when it opens and stopped a while after it
// closes; a crash restarts it, three in the crash window stop it ("crashed"); a stuck event
// loop and a heap over the limit stop it with the reason; a package asking for more than its
// grant waits until widget.grant; the tree reaches the window (and a late view), patches on a
// bad rev ask for the tree again; the window's interactions reach the process; subscriptions
// are pushes, one message per change, and a widget that never subscribes adds no listener.

import { afterEach, describe, expect, it } from "vitest";
import type { AppWindow, CoreEvent, WidgetHostStatus } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { fakeFactory } from "./fake-pty.ts";
import { FakeWidgetRuntime, tmp, until, writePackage, type FakePackage } from "./fake-widget-runtime.ts";
import type { HostTimes } from "../src/widgets/host/host.ts";

const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close();
});

async function setup(pkgs: FakePackage[] = [{}], times: Partial<HostTimes> = {}) {
  const home = tmp("cmd-widgets-home-");
  for (const p of pkgs) writePackage(home, p);
  process.env.CMD_WIDGETS_HOME = home;
  const core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, stateDir: tmp("cmd-state-") });
  delete process.env.CMD_WIDGETS_HOME;
  cores.push(core);
  const rt = new FakeWidgetRuntime(core.widgetTokens);
  core.library.host.configure({ runtime: rt, times: { pingMs: 20, stallMs: 150, stopAfterMs: 100, restartMs: 5, helloMs: 2000, ...times } });
  const events: CoreEvent[] = [];
  core.serve({ access: "local", send: (line) => {
    const m = JSON.parse(line) as { method?: string; params?: CoreEvent };
    if (m.method === "event") events.push(m.params!);
  }, close: () => {} }).receive(JSON.stringify({ id: 1, method: "events.subscribe", params: {} }));
  core.start();
  await core.scheduler.idle();
  const open = async (ref = "pkg:demo/main") => (await core.handlers["widget.add"]({ ref, workspaceId: core.workspaces.home().id })) as AppWindow;
  const trees = (id: string) => events.filter((e): e is Extract<CoreEvent, { type: "widget.tree" }> => e.type === "widget.tree" && e.windowId === id).map((e) => e.message);
  const status = (id: string) => core.library.host.status(id);
  const isStatus = (id: string, state: WidgetHostStatus["state"], reason?: string) => () => status(id)?.state === state && (reason === undefined || status(id)?.reason === reason);
  return { core, rt, events, open, trees, status, isStatus };
}

describe("the widget host", () => {
  it("starts one process per window when it opens, answers hello with ready, and says it runs", async () => {
    const { rt, open, trees, isStatus } = await setup([{ config: [{ key: "repo", title: "Repository", type: "string", default: "cmd" }, { key: "token", title: "Token", type: "string", secret: true, host: "api.github.com" }], permissions: { net: ["api.github.com"] } }]);
    const { core } = { core: cores[0]! };
    core.library.host.grant("demo");
    const a = await open();
    const b = await open();
    await until(isStatus(a.id, "running"), "the first window's process");
    await until(isStatus(b.id, "running"), "the second's");
    expect(rt.procs).toHaveLength(2);
    expect(rt.procs.map((p) => p.spec.name + "/" + p.spec.widget)).toEqual(["demo/main", "demo/main"]);
    const ready = await rt.procs[0]!.next("ready");
    expect(ready.config).toEqual({ repo: "cmd" }); // the default; the secret field never
    // The fake process says it was built for 1.0 (minor 0): a 1.0 package runs unchanged on a 1.2 core, told what it serves.
    expect(ready.env).toMatchObject({ api: { major: 1, minor: 3 }, size: "regular", placement: "board" });
    expect(ready.env.verbs).toContain("agents.list");
    expect(ready.env.verbs).toContain("agents.start");
    expect(trees(a.id).map((m) => m.kind === "status" && m.state)).toEqual(["starting", "running"]);
  });

  it("stops the process a while after its window closes, and keeps it for a window reopened in time", async () => {
    const { core, rt, open, isStatus } = await setup();
    const w = await open();
    await until(isStatus(w.id, "running"), "running");
    const p = rt.last;
    core.windows.close(w.id);
    await new Promise((r) => setTimeout(r, 30));
    expect(p.killed).toBe(false); // not at once: a reopen finds it running
    await until(() => p.killed, "the process stopped after the delay");
    expect(core.library.host.running()).toBe(0);
  });

  it("restarts a process that crashed", async () => {
    const { rt, open, isStatus } = await setup();
    const w = await open();
    await until(isStatus(w.id, "running"), "running");
    rt.last.crash(1, "Uncaught Error: boom");
    await until(() => rt.procs.length === 2, "a new process");
    await until(isStatus(w.id, "running"), "running again");
  });

  it("stops after three crashes within the crash window, says crashed, and Restart starts it again", async () => {
    const { core, rt, open, isStatus } = await setup();
    const w = await open();
    for (let i = 1; i <= 3; i++) {
      await until(() => rt.procs.length === i && rt.last.got("ready").length > 0, `process ${i}`);
      rt.last.crash(1);
    }
    await until(isStatus(w.id, "stopped", "crashed"), "Stopped · crashed");
    await new Promise((r) => setTimeout(r, 50));
    expect(rt.procs).toHaveLength(3);
    core.handlers["widget.restart"]({ windowId: w.id });
    await until(isStatus(w.id, "running"), "running after Restart");
    expect(rt.procs).toHaveLength(4);
  });

  it("kills a process whose event loop is stuck (pings unanswered) with the reason", async () => {
    const { rt, open, isStatus } = await setup();
    const w = await open();
    await until(isStatus(w.id, "running"), "running");
    rt.last.frozen = true;
    await until(isStatus(w.id, "stopped", "stopped responding"), "Stopped · stopped responding");
    expect(rt.last.killed).toBe(true);
    expect(rt.procs).toHaveLength(1); // not restarted: a stall isn't a crash to retry
  });

  it("stops a process over its heap limit with the reason", async () => {
    const { rt, open, isStatus } = await setup();
    const w = await open();
    await until(isStatus(w.id, "running"), "running");
    expect(rt.last.spec.memoryMb).toBeGreaterThan(0);
    rt.last.crash(133, "\n<--- Last few GCs --->\nFatal JavaScript out of memory: Reached heap limit\n");
    await until(isStatus(w.id, "stopped", "used too much memory"), "Stopped · used too much memory");
    expect(rt.procs).toHaveLength(1);
  });

  it("waits for a grant when the package asks for more, and starts on widget.grant with declared ∩ granted", async () => {
    const { core, rt, open, isStatus } = await setup([{ permissions: { net: ["api.github.com"], workspace: ["read"] } }]);
    const w = await open();
    await until(isStatus(w.id, "waiting-grant"), "Waiting for permission");
    expect(rt.procs).toHaveLength(0);
    const g = core.handlers["widget.grant"]({ name: "demo" }) as { permissions: { net: string[] } };
    expect(g.permissions.net).toEqual(["api.github.com"]);
    await until(isStatus(w.id, "running"), "running after the grant");
    expect(rt.last.spec.permissions.workspace).toEqual(["read"]);
  });

  it("refuses a process made for another API major", async () => {
    const { rt, open, isStatus } = await setup();
    rt.boot = (p) => p.connect().hello({ api: 2 });
    const w = await open();
    await until(isStatus(w.id, "stopped", "made for a newer cmd"), "Made for a newer cmd");
    expect(rt.last.got("ready")).toHaveLength(0);
  });

  it("sends the tree and patches to the window, the last whole tree to a view drawn later, and asks again on a bad rev", async () => {
    const { core, rt, open, trees, isStatus } = await setup();
    const w = await open();
    await until(isStatus(w.id, "running"), "running");
    const p = rt.last;
    p.send({ kind: "tree", rev: 1, nodes: [{ id: 2, type: "Text", props: {}, children: [{ id: 1, type: "#text", text: "0 agents" }] }] });
    p.send({ kind: "patch", rev: 2, ops: [{ op: "text", id: 1, text: "2 agents" }, { op: "insert", parent: 0, index: 1, node: { id: 3, type: "Button", props: { onClick: { $handler: 7 } }, children: [] } }] });
    await until(() => trees(w.id).some((m) => m.kind === "patch"), "the patch forwarded");
    // A view opened now gets the whole tree as it stands.
    core.handlers["widget.resync"]({ windowId: w.id });
    await until(() => trees(w.id).filter((m) => m.kind === "tree").length === 2, "the tree again");
    const last = trees(w.id).filter((m) => m.kind === "tree").at(-1)!;
    expect(last).toMatchObject({ rev: 2, nodes: [{ id: 2, children: [{ text: "2 agents" }] }, { id: 3, type: "Button" }] });
    // A patch that skips a rev isn't forwarded: the process is asked for its tree.
    p.send({ kind: "patch", rev: 5, ops: [] });
    await p.next("resync");
    expect(trees(w.id).filter((m) => m.kind === "patch")).toHaveLength(1);
  });

  it("forwards the window's interactions and env (its box rounded) to the process", async () => {
    const { core, rt, open, isStatus, trees } = await setup();
    const w = await open();
    await until(isStatus(w.id, "running"), "running");
    rt.last.send({ kind: "tree", rev: 1, nodes: [{ id: 1, type: "Button", props: { label: "Go", onClick: { $handler: 7 } }, children: [] }] });
    await until(() => trees(w.id).some((m) => m.kind === "tree"), "the tree");
    core.handlers["widget.interact"]({ windowId: w.id, handler: 7, event: "onClick" });
    expect(await rt.last.next("interaction")).toEqual({ kind: "interaction", handler: 7, event: "onClick" });
    core.handlers["widget.env"]({ windowId: w.id, theme: "light", size: "narrow", placement: "sidebar" });
    expect((await rt.last.next("env")).env).toMatchObject({ theme: "light", size: "narrow", box: null, placement: "sidebar", locale: Intl.NumberFormat().resolvedOptions().locale });
    // 1.3: the content's box, rounded down to 8 as the widget gets it; a renderer that sends none keeps the last.
    core.handlers["widget.env"]({ windowId: w.id, theme: "light", size: "narrow", box: { width: 317, height: 203.5 }, placement: "sidebar" });
    expect((await rt.last.next("env", (m) => m.env.box !== null)).env).toMatchObject({ size: "narrow", box: { width: 312, height: 200 } });
    core.handlers["widget.env"]({ windowId: w.id, theme: "dark", size: "narrow", placement: "sidebar" });
    expect((await rt.last.next("env", (m) => m.env.theme === "dark")).env).toMatchObject({ theme: "dark", box: { width: 312, height: 200 } });
    // The app's locale (1.3), canonical; one Intl doesn't know keeps the last.
    core.handlers["widget.env"]({ windowId: w.id, theme: "light", size: "narrow", placement: "sidebar", locale: "de-de" });
    expect((await rt.last.next("env", (m) => m.env.locale === "de-DE")).env).toMatchObject({ theme: "light", locale: "de-DE" });
    core.handlers["widget.env"]({ windowId: w.id, theme: "dark", size: "narrow", placement: "sidebar", locale: "not a locale!" });
    expect((await rt.last.next("env", (m) => m.env.theme === "dark" && m.env.locale !== Intl.NumberFormat().resolvedOptions().locale)).env).toMatchObject({ locale: "de-DE" });
  });

  it("pushes config changes, never a secret", async () => {
    const { core, rt, open, isStatus } = await setup([{ config: [{ key: "repo", title: "Repository", type: "string", default: "" }, { key: "token", title: "Token", type: "string", secret: true, host: "api.github.com" }], permissions: { net: ["api.github.com"] } }]);
    core.library.host.grant("demo");
    const w = await open();
    await until(isStatus(w.id, "running"), "running");
    core.windows.update(w.id, { state: { config: { repo: "cmd", token: "ghp_secret" } } });
    expect((await rt.last.next("config")).config).toEqual({ repo: "cmd" });
  });
});

describe("subscriptions", () => {
  it("push an agent change in one message without a query, stop on unsubscribe, and none without a subscribe", async () => {
    const { core, rt, open, isStatus } = await setup([{ permissions: { workspace: ["read"] } }]);
    core.library.host.grant("demo");
    const before = core.agents.listenerCount("updated");
    const w = await open();
    await until(isStatus(w.id, "running"), "running");
    expect(core.agents.listenerCount("updated")).toBe(before); // never subscribed: nothing listens
    const p = rt.last;
    const callsBefore = p.got("result").length;
    p.send({ kind: "subscribe", id: 10, topic: "agents", query: null });
    expect((await p.next("event", (m) => m.sub === 10)).data).toEqual([]); // the current value, at once
    expect(core.agents.listenerCount("updated")).toBe(before + 1);
    const pane = core.panes.create({ workspaceId: core.workspaces.home().id });
    core.agents.ingestHook(pane.id, "claude", "UserPromptSubmit", { session_id: "s1", prompt: "count the stars" });
    const pushed = await p.next("event", (m) => m.sub === 10 && Array.isArray(m.data) && m.data.length === 1);
    expect(pushed.data).toMatchObject([{ kind: "claude", state: "working", bucket: "rest", light: "working", windowId: pane.id, terminalId: pane.id, depth: 0 }]);
    await new Promise((r) => setTimeout(r, 120));
    const n = p.got("event").filter((m) => m.sub === 10).length;
    expect(n).toBe(2); // one for the current value, one for the change: no polling in between
    expect(p.got("result").length).toBe(callsBefore); // pushed, never asked for
    p.send({ kind: "unsubscribe", id: 10 });
    expect(core.agents.listenerCount("updated")).toBe(before);
    core.agents.ingestHook(pane.id, "claude", "Stop", { session_id: "s1" });
    await new Promise((r) => setTimeout(r, 120));
    expect(p.got("event").filter((m) => m.sub === 10)).toHaveLength(n);
  });

  it("refuses a topic outside the grant, naming the permission, and the process lives on", async () => {
    const { rt, open, isStatus } = await setup();
    const w = await open();
    await until(isStatus(w.id, "running"), "running");
    rt.last.send({ kind: "subscribe", id: 4, topic: "agents", query: null });
    const r = await rt.last.next("result", (m) => m.id === 4);
    expect(r).toMatchObject({ ok: false, error: { code: "permission", permission: 'workspace: ["read"]' } });
    expect(rt.last.got("event")).toHaveLength(0);
    expect(rt.last.killed).toBe(false);
  });

  it("pushes every workspace's events with scope \"all\" and a workspace: [\"all\"] grant, and refuses it without one", async () => {
    const { core, rt, open, isStatus } = await setup([{ permissions: { workspace: ["read"] } }, { name: "wide", permissions: { workspace: ["read", "all"] } }]);
    core.library.host.grant("demo");
    core.library.host.grant("wide");
    const narrow = await open();
    await until(isStatus(narrow.id, "running"), "running");
    rt.last.send({ kind: "subscribe", id: 5, topic: "events", query: { types: ["command"], scope: "all" } });
    expect(await rt.last.next("result", (m) => m.id === 5)).toMatchObject({ ok: false, error: { code: "permission", permission: 'workspace: ["all"]', message: expect.stringMatching(/every workspace/i) } });

    const w = await open("pkg:wide/main");
    await until(isStatus(w.id, "running"), "running");
    const p = rt.last;
    const elsewhere = core.workspaces.open(tmp("cmd-widget-elsewhere-")).workspace;
    p.send({ kind: "subscribe", id: 6, topic: "events", query: { types: ["command"], scope: "all" } });
    expect((await p.next("event", (m) => m.sub === 6)).data).toEqual([]);
    const run = (id: string, workspaceId: string, exitCode: number | null) => core.data.record({ id: `command:${id}`, at: 1000, until: exitCode === null ? null : 2000, type: "command", source: "osc", workspaceId, data: { command: "make", cwd: "/", exitCode } as never });
    run("here", core.workspaces.home().id, null);
    run("there", elsewhere.id, null);
    run("there", elsewhere.id, 2);
    const pushed = await p.next("event", (m) => m.sub === 6 && Array.isArray(m.data) && m.data.length > 0);
    // One burst: both workspaces, the command recorded again once, as it ended.
    expect(pushed.data).toEqual([expect.objectContaining({ key: "command:here", workspaceId: core.workspaces.home().id }), expect.objectContaining({ key: "command:there", workspaceId: elsewhere.id, until: 2000, data: expect.objectContaining({ exitCode: 2 }) })]);
  });

  it("keeps a widget's console to about 50 lines a second, and says how many it dropped", async () => {
    const { rt, events, open, isStatus } = await setup();
    const w = await open();
    await until(isStatus(w.id, "running"), "running");
    for (let i = 0; i < 10_000; i++) rt.last.send({ kind: "log", level: "info", message: `tick ${i}` });
    await until(() => events.some((e) => e.type === "widget.log" && / lines dropped/.test(e.message)), "the line saying what was dropped");
    const logs = events.filter((e): e is Extract<CoreEvent, { type: "widget.log" }> => e.type === "widget.log" && e.windowId === w.id);
    expect(logs.length).toBeLessThan(250); // the burst, a second's worth, the drop line
    expect(logs[0]!.message).toBe("tick 0");
    const dropped = logs.find((e) => / lines dropped/.test(e.message))!;
    const n = Number(/… (\d+) lines dropped/.exec(dropped.message)![1]);
    expect(n + logs.filter((e) => e.message.startsWith("tick ")).length).toBe(10_000);
    expect(dropped.level).toBe("warn");
  });

  // A countdown rings from its own process (packages/widgets/timer): the process runs while its
  // window is open in any workspace, shown or not, and its notify.send reaches the notification center.
  it("keeps a window's process running in a workspace that isn't shown, and its notification reaches the center", async () => {
    const { core, rt, isStatus } = await setup();
    core.library.host.grant("demo");
    const elsewhere = core.workspaces.open(tmp("cmd-widget-elsewhere-")).workspace;
    const w = (await core.handlers["widget.add"]({ ref: "pkg:demo/main", workspaceId: elsewhere.id })) as AppWindow;
    await until(isStatus(w.id, "running"), "its process");
    expect(w.workspaceId).not.toBe(core.workspaces.home().id);
    const notes: { title: string; windowId?: string | null }[] = [];
    core.notifications.on("notification", (n) => notes.push(n));
    rt.last.send({ kind: "call", id: 1, method: "notify.send", params: [{ key: "timer-1", title: "25 min timer · done", body: "Time's up" }] });
    await rt.last.next("result", (m) => m.id === 1);
    expect(notes).toEqual([expect.objectContaining({ title: "25 min timer · done", windowId: w.id })]);
  });
});
