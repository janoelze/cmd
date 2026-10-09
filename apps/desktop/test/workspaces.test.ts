import { describe, expect, it } from "vitest";
import type { Agent, AppWindow, Pane } from "@cmd/protocol";
import { buildRows, inWorkspace, workspaceAttention, under } from "../src/renderer/src/model.ts";
import type { State } from "../src/renderer/src/store.ts";

// Workspaces in the UI: an app window sees only its workspace; the switcher sees what waits everywhere.

const pane = (id: string, workspaceId: string, p: Partial<Pane> = {}): Pane =>
  ({ id, workspaceId, title: "", cwd: "/", foreground: "zsh", agentId: null, lastActivityAt: 0, createdAt: 0, attention: null, ...p }) as Pane;
const agent = (id: string, workspaceId: string, a: Partial<Agent> = {}): Agent =>
  ({ id, workspaceId, kind: "claude", state: "working", stateSince: 10, seenAt: null, parentId: null, paneId: null, cwd: "/", name: null, spawn: {}, native: {}, ...a }) as Agent;
const win = (id: string, workspaceId: string): AppWindow => ({ id, workspaceId, kind: "browser", title: "Docs", createdAt: 0, updatedAt: 0, state: {} });

const s = {
  workspaceId: "proj",
  panes: new Map([pane("p1", "proj", { agentId: "a1" }), pane("p2", "home"), pane("p3", "other", { attention: { kind: "bell", text: "Bell", urgent: false, at: 0 } })].map((p) => [p.id, p])),
  agents: new Map([agent("a1", "proj", { paneId: "p1" }), agent("a2", "home", { state: "needs_input" }), agent("a3", "proj", { state: "done", stateSince: 5 })].map((a) => [a.id, a])),
  windows: new Map([win("w1", "proj"), win("w2", "home")].map((w) => [w.id, w])),
} as State;

describe("Workspaces in the UI", () => {
  it("shows an app window only its workspace's terminals, agents and windows", () => {
    const mine = inWorkspace(s);
    expect([...mine.panes.keys()]).toEqual(["p1"]);
    expect([...mine.agents.keys()]).toEqual(["a1", "a3"]);
    expect([...mine.windows.keys()]).toEqual(["w1"]);
    expect(buildRows(inWorkspace(s, "home")).map((r) => r.key)).toEqual(["a2", "p2", "w2"]);
  });

  it("marks each workspace by its most urgent waiting thing", () => {
    expect(Object.fromEntries(workspaceAttention(s))).toEqual({ home: "needs", proj: "unseen", other: "unseen" });
  });

  it("compares folders by whole segments", () => {
    expect(under("/a/proj", "/a/proj/src")).toBe(true);
    expect(under("/a/proj", "/a/proj")).toBe(true);
    expect(under("/a/proj", "/a/proj-old")).toBe(false);
  });
});
