import { describe, expect, it } from "vitest";
import type { Agent, AppWindow, Pane } from "@cmd/protocol";
import { buildRows, filterRows, sectionOf } from "../src/renderer/src/model.ts";
import type { State } from "../src/renderer/src/store.ts";

// Sidebar sections: Needs you, then agents, then plain windows; search filters open rows.

const pane = (id: string, p: Partial<Pane> = {}): Pane =>
  ({ id, title: "", cwd: "/Users/someone/src/cmd", foreground: "zsh", agentId: null, lastActivityAt: 0, createdAt: 0, attention: null, ...p }) as Pane;
const agent = (id: string, a: Partial<Agent> = {}): Agent =>
  ({ id, kind: "claude", state: "working", stateSince: 0, seenAt: null, parentId: null, paneId: null, cwd: "/Users/someone/src/cmd", name: null, spawn: {}, native: {}, ...a }) as Agent;
const win = (id: string, w: Partial<AppWindow> = {}): AppWindow => ({ id, spaceId: "home", kind: "browser", title: "Docs", createdAt: 0, updatedAt: 0, state: {}, ...w });

function state(panes: Pane[], agents: Agent[], windows: AppWindow[] = []): State {
  return {
    panes: new Map(panes.map((p) => [p.id, p])),
    agents: new Map(agents.map((a) => [a.id, a])),
    windows: new Map(windows.map((w) => [w.id, w])),
  } as State;
}

describe("sidebar sections", () => {
  const s = state(
    [
      pane("shell", { lastActivityAt: 900 }),
      pane("busy", { agentId: "a-busy", foreground: "claude" }),
      pane("asking", { agentId: "a-asking", foreground: "claude" }),
    ],
    [agent("a-busy", { paneId: "busy", name: "refactor search", stateSince: 100 }), agent("a-asking", { paneId: "asking", state: "needs_input", stateSince: 50 })],
    [win("w1", { updatedAt: 500 })],
  );

  it("orders needs you, agents, then windows by recency", () => {
    const rows = buildRows(s);
    expect(rows.map((r) => r.key)).toEqual(["a-asking", "a-busy", "shell", "w1"]);
    expect(rows.map(sectionOf)).toEqual(["needs", "agents", "windows", "windows"]);
  });

  it("puts widgets in their own section, after windows", () => {
    const t = state([pane("shell")], [], [win("w1", { updatedAt: 500 }), win("m1", { kind: "magic", updatedAt: 900 })]);
    const rows = buildRows(t);
    expect(rows.map((r) => r.key)).toEqual(["w1", "shell", "m1"]);
    expect(rows.map(sectionOf)).toEqual(["windows", "windows", "widgets"]);
  });

  it("puts a host into needs you when one of its workers waits", () => {
    const t = state([pane("host", { agentId: "h" })], [agent("h", { paneId: "host" }), agent("w", { parentId: "h", state: "needs_input" })]);
    expect(sectionOf(buildRows(t)[0]!)).toBe("needs");
  });

  it("filters open rows (children too) on every term", () => {
    const rows = buildRows(s);
    expect(filterRows(rows, "refactor").map((r) => r.key)).toEqual(["a-busy"]);
    expect(filterRows(rows, "src/cmd zsh").map((r) => r.key)).toEqual(["shell"]);
    expect(filterRows(rows, "  ")).toEqual([]);
  });
});
