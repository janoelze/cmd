import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AppNotification, type Settings } from "@cmd/protocol";
import { AgentTracker } from "../src/agents/tracker.ts";
import { formatDuration, NotificationCenter } from "../src/notifications.ts";
import { PaneManager } from "../src/panes.ts";
import { fakeFactory, type FakePty } from "./fake-pty.ts";

let panes: PaneManager;
let ptys: FakePty[];
let cfg: Settings;
let sent: AppNotification[];

beforeEach(() => {
  const f = fakeFactory();
  ptys = f.ptys;
  cfg = { ...DEFAULT_SETTINGS };
  panes = new PaneManager(f.factory, { socketPath: "/tmp/test.sock", pollMs: 0, settings: () => cfg });
  const agents = new AgentTracker(panes);
  const center = new NotificationCenter(panes, agents, () => cfg);
  sent = [];
  center.on("notification", (n) => sent.push(n));
});

afterEach(() => vi.useRealTimers());

const setForeground = async (pty: FakePty, name: string) => {
  pty.process = name;
  await panes.pollForeground();
};

describe("bells", () => {
  it("mark the terminal and flash, but only notify when asked to", () => {
    const pane = panes.create();
    ptys[0]!.output("\x07");
    expect(panes.get(pane.id)!.attention).toMatchObject({ kind: "bell", text: "Bell", urgent: true });
    expect(sent).toMatchObject([{ source: "bell", paneId: pane.id, alert: false }]);

    cfg = { ...cfg, "notifications.bell": "notify" };
    vi.useFakeTimers();
    vi.advanceTimersByTime(5000);
    ptys[0]!.output("\x07");
    expect(sent.at(-1)).toMatchObject({ source: "bell", alert: true });
  });

  it("fold a burst into one and can be ignored", () => {
    vi.useFakeTimers();
    panes.create();
    ptys[0]!.output("\x07\x07\x07");
    expect(sent).toHaveLength(1);
    cfg = { ...cfg, "notifications.bell": "ignore" };
    vi.advanceTimersByTime(5000);
    ptys[0]!.output("\x07");
    expect(sent).toHaveLength(1);
  });
});

describe("notifications from programs", () => {
  it("OSC 9 / 777 / 99 from a plain terminal notify and mark it", () => {
    const pane = panes.create();
    ptys[0]!.output("\x1b]9;Build done\x07");
    ptys[0]!.output("\x1b]777;notify;Tests;42 passed\x07");
    ptys[0]!.output("\x1b]99;;Deployed\x1b\\");
    expect(sent.map((n) => [n.title, n.body])).toEqual([
      ["zsh", "Build done"],
      ["Tests", "42 passed"],
      ["zsh", "Deployed"],
    ]);
    expect(panes.get(pane.id)!.attention).toMatchObject({ kind: "notify", text: "Deployed" });
  });

  it("are left to the agent when one runs there, and can be turned off", async () => {
    panes.create();
    await setForeground(ptys[0]!, "claude");
    ptys[0]!.output("\x1b]9;Claude needs you\x07");
    expect(sent.filter((n) => n.source === "terminal")).toHaveLength(0);
    // The tracker turns it into the agent's state, which notifies once.
    expect(sent).toMatchObject([{ source: "agent-input", title: "claude needs you", body: "Claude needs you", urgent: true }]);

    panes.create();
    cfg = { ...cfg, "notifications.terminalSequences": false };
    ptys[1]!.output("\x1b]9;hidden\x07");
    expect(sent.filter((n) => n.source === "terminal")).toHaveLength(0);
  });
});

describe("long commands", () => {
  it("notify when a command that ran long enough finishes, with its process and exit status", async () => {
    vi.useFakeTimers();
    const pane = panes.create();
    ptys[0]!.output("\x1b]133;C\x07");
    await setForeground(ptys[0]!, "make");
    vi.advanceTimersByTime(45_000);
    ptys[0]!.output("\x1b]133;D;2\x07");
    expect(sent).toMatchObject([{ source: "command", title: "make failed (exit 2)", urgent: true, alert: true }]);
    expect(panes.get(pane.id)!.attention).toMatchObject({ kind: "command", text: "make failed (exit 2) · 45s" });
  });

  it("stay quiet for short commands, ⌃C, agents and when off", async () => {
    vi.useFakeTimers();
    panes.create();
    const run = (ms: number, code: number) => {
      ptys[0]!.output("\x1b]133;C\x07");
      vi.advanceTimersByTime(ms);
      ptys[0]!.output(`\x1b]133;D;${code}\x07`);
    };
    run(5_000, 0); // short
    run(60_000, 130); // interrupted
    cfg = { ...cfg, "notifications.longCommand": 0 };
    run(60_000, 0); // off
    expect(sent).toEqual([]);
  });
});

describe("cmd notify and mute", () => {
  it("notifies from a terminal or from anywhere; a muted terminal keeps its marker but doesn't alert", () => {
    const center = new NotificationCenter(panes, new AgentTracker(panes), () => cfg);
    const mine: AppNotification[] = [];
    center.on("notification", (n) => mine.push(n));
    const pane = panes.create();
    center.send(null, undefined, "hello");
    center.setMuted(pane.id, true);
    center.send(pane.id, "Deploy", "done");
    expect(mine).toMatchObject([
      { source: "cli", paneId: null, title: "cmd", body: "hello", alert: true },
      { source: "cli", paneId: pane.id, title: "Deploy", alert: false },
    ]);
    expect(panes.get(pane.id)!.attention).toMatchObject({ text: "done" });
    center.clearAttention(pane.id);
    expect(panes.get(pane.id)!.attention).toBeNull();
  });
});

it("formats durations", () => {
  expect(formatDuration(42_000)).toBe("42s");
  expect(formatDuration(192_000)).toBe("3m 12s");
  expect(formatDuration(3_900_000)).toBe("1h 5m");
});
