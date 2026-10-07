// The built-in widgets' core parts (docs/16-widgets.md): the command log behind
// Commands, the notification log behind Notifications, the Timer's state and
// the alarms that ring it.

import fs from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandRunOf, notificationOf, type AppNotification } from "@cmd/protocol";
import { Core } from "../src/core.ts";
import { durationLabel, timerType, type TimerState } from "../src/windows/builtin.ts";
import { fakeFactory, type FakePty } from "./fake-pty.ts";

let core: Core;
let ptys: FakePty[];

beforeEach(() => {
  const f = fakeFactory();
  ptys = f.ptys;
  core = new Core({ socketPath: "/tmp/cmd-test-widgets.sock", dbPath: null, settingsPath: null, terminals: f.factory, pollMs: 0 });
});

afterEach(async () => {
  vi.useRealTimers();
  await core.close();
});

/** What the Commands and Notifications widgets subscribe to, newest first. */
const runs = (spaceId?: string) => core.data.query({ types: ["command"], spaceId, by: "time", order: "desc", limit: 300 }).map(commandRunOf);
const notifications = () => core.data.query({ types: ["notification"], by: "time", order: "desc", limit: 300 }).map(notificationOf);

describe("command log", () => {
  it("records a command from C, its line from exec, and its status from D", async () => {
    const pane = core.panes.create();
    const pty = ptys[0]!;
    const token = pty.opts.env.CMD_PANE_TOKEN;
    pty.output(`\x1b]133;C\x07\x1b]777;cmd;${token};exec;make test\x07`);
    let [run] = runs();
    expect(run).toMatchObject({ paneId: pane.id, spaceId: pane.spaceId, command: "make test", endedAt: null, exitCode: null });

    pty.output("\x1b]133;D;2\x07\x1b]133;A\x07");
    [run] = runs();
    expect(run).toMatchObject({ command: "make test", exitCode: 2 });
    expect(run!.endedAt).toBeGreaterThanOrEqual(run!.startedAt);
  });

  it("lists newest first, by Space, and ignores forged lines", async () => {
    const pane = core.panes.create();
    const pty = ptys[0]!;
    const token = pty.opts.env.CMD_PANE_TOKEN;
    for (const line of ["ls", "pwd"]) pty.output(`\x1b]133;C\x07\x1b]777;cmd;${token};exec;${line}\x07\x1b]133;D;0\x07`);
    pty.output(`\x1b]133;C\x07\x1b]777;cmd;forged;exec;rm -rf ~\x07\x1b]133;D;0\x07`);
    const list = runs(pane.spaceId);
    expect(list.map((r) => r.command)).toEqual([null, "pwd", "ls"]);
    expect(runs("elsewhere")).toEqual([]);
  });

  it("keeps what a command printed, without escape sequences, as the event's content", async () => {
    core.panes.create();
    const pty = ptys[0]!;
    const token = pty.opts.env.CMD_PANE_TOKEN;
    pty.output(`\x1b]133;C\x07\x1b]777;cmd;${token};exec;pnpm test\x07`);
    pty.output("\x1b[32m✓\x1b[0m 12 passed\r\n");
    pty.output("\x1b]133;D;0\x07\x1b]133;A\x07");
    const [e] = core.data.query({ types: ["command"] });
    expect(e).toMatchObject({ text: "pnpm test", until: expect.any(Number), data: { command: "pnpm test", exitCode: 0, output: { chars: 11, cut: false } } });
    expect(core.data.store.blob(e!.blob!)!.toString()).toBe("✓ 12 passed");
    expect(runs().map((r) => r.command)).toEqual(["pnpm test"]);
  });

  it("ends a run whose shell came back without D, or whose terminal closed", async () => {
    core.panes.create();
    const pty = ptys[0]!;
    pty.output("\x1b]133;C\x07\x1b]133;A\x07");
    expect((runs())[0]).toMatchObject({ exitCode: null });
    expect((runs())[0]!.endedAt).not.toBeNull();
    pty.output("\x1b]133;C\x07");
    pty.exit(0);
    expect((runs())[0]!.endedAt).not.toBeNull();
  });

  it("leaves out terminals cmd started an agent in", async () => {
    const agent = await core.call("agent.spawn", { kind: "claude" });
    expect(agent.paneId).toBeTruthy();
    ptys.at(-1)!.output("\x1b]133;C\x07\x1b]133;D;0\x07");
    expect(runs()).toEqual([]);
  });
});

describe("notification log", () => {
  it("records what was sent with its time, and Clear as a marker that keeps them", async () => {
    core.notifications.info("First", "one");
    core.notifications.info("Second", "two");
    expect(notifications().map((n) => n.title)).toEqual(["Second", "First"]);
    expect(notifications()[0]!.at).toBeGreaterThan(0);
    await core.call("notify.clear", {});
    expect(core.data.query({ types: ["notification.clear"] })).toHaveLength(1);
    expect(notifications()).toHaveLength(2);
  });

  it("keeps the Space of the terminal it is about, even after the terminal is gone", async () => {
    const space = core.spaces.open(fs.realpathSync(os.tmpdir())).space;
    const pane = await core.call("pane.create", { spaceId: space.id });
    core.notifications.send(pane.id, "From a terminal", "hi");
    core.notifications.info("About nothing", "");
    await core.call("pane.kill", { paneId: pane.id });
    expect(notifications().map((n) => [n.title, n.spaceId])).toEqual([["About nothing", null], ["From a terminal", space.id]]);
  });
});

describe("timer", () => {
  const t0 = 1_000_000;
  const create = (duration?: number) => timerType.create(duration === undefined ? {} : { duration });
  const update = (s: TimerState, patch: Record<string, unknown>, now: number) => (timerType.update as (s: TimerState, p: Record<string, unknown>, now: number) => { state: TimerState; title?: string })(s, patch, now);

  it("starts, pauses, resumes and resets", () => {
    let s = create(60).state;
    expect(s).toEqual({ duration: 60, endsAt: null, left: null, rang: null });
    s = update(s, { action: "start" }, t0).state;
    expect(s.endsAt).toBe(t0 + 60_000);
    s = update(s, { action: "pause" }, t0 + 20_000).state;
    expect(s).toMatchObject({ endsAt: null, left: 40 });
    s = update(s, { action: "start" }, t0 + 100_000).state;
    expect(s).toMatchObject({ endsAt: t0 + 140_000, left: null });
    s = update(s, { action: "reset" }, t0 + 101_000).state;
    expect(s).toEqual({ duration: 60, endsAt: null, left: null, rang: null });
  });

  it("rings only when its time is up, and a new duration stops it", () => {
    let s = update(create(60).state, { action: "start" }, t0).state;
    expect(update(s, { action: "ring" }, t0 + 30_000).state.rang).toBeNull();
    s = update(s, { action: "ring" }, t0 + 60_000).state;
    expect(s).toMatchObject({ endsAt: null, rang: t0 + 60_000 });
    const r = update(s, { duration: 300 }, t0);
    expect(r.state).toEqual({ duration: 300, endsAt: null, left: null, rang: null });
    expect(r.title).toBe("Timer · 5 min");
  });

  it("defaults to 25 min and clamps durations", () => {
    expect(create().state.duration).toBe(1500);
    expect(create(0).state.duration).toBe(1);
    expect(create(1e9).state.duration).toBe(86_400);
  });

  it("labels durations", () => {
    expect(durationLabel(45)).toBe("45 s");
    expect(durationLabel(1500)).toBe("25 min");
    expect(durationLabel(5400)).toBe("1 h 30 min");
  });

  it("is rung by the core: the window is marked and a notification goes out", async () => {
    vi.useFakeTimers({ now: t0 });
    const sent: AppNotification[] = [];
    core.notifications.on("notification", (n) => sent.push(n));
    const w = await core.call("window.open", { kind: "timer", input: { duration: 90 } });
    await core.call("window.update", { id: w.id, state: { action: "start" } });
    vi.advanceTimersByTime(89_000);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(sent).toMatchObject([{ source: "timer", windowId: w.id, title: "1 min 30 s timer · done", urgent: true }]);
    expect(core.windows.list().find((x) => x.id === w.id)!.state).toMatchObject({ endsAt: null, rang: t0 + 90_000 });
  });

  it("doesn't ring a timer that was paused or closed", async () => {
    vi.useFakeTimers({ now: t0 });
    const sent: AppNotification[] = [];
    core.notifications.on("notification", (n) => sent.push(n));
    const a = await core.call("window.open", { kind: "timer", input: { duration: 10 } });
    const b = await core.call("window.open", { kind: "timer", input: { duration: 10 } });
    await core.call("window.update", { id: a.id, state: { action: "start" } });
    await core.call("window.update", { id: b.id, state: { action: "start" } });
    await core.call("window.update", { id: a.id, state: { action: "pause" } });
    await core.call("window.close", { id: b.id });
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
  });
});
