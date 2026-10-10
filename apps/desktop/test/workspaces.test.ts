import { describe, expect, it } from "vitest";
import type { Agent, AppWindow, Pane, Workspace } from "@cmd/protocol";
import { buildRows, byActivity, inWorkspace, workspaceAttention, under } from "../src/renderer/src/model.ts";
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

  it("lists workspaces by last activity, the shown one last", () => {
    const sp = (id: string, order: number, lastActiveAt: number) => ({ id, order, lastActiveAt }) as Workspace;
    const st = {
      workspaces: new Map([sp("home", 0, 50), sp("proj", 1, 40), sp("other", 2, 30), sp("idle", 3, 0), sp("quiet", 4, 0)].map((w) => [w.id, w])),
      // An agent in "other" finished last; a bell in "proj" came after home was shown.
      agents: new Map([agent("a1", "other", { state: "done", stateSince: 90 })].map((a) => [a.id, a])),
      panes: new Map([pane("p1", "proj", { attention: { kind: "bell", text: "Bell", urgent: false, at: 60 } })].map((p) => [p.id, p])),
      windows: new Map(),
    };
    expect(byActivity(st).map((w) => w.id)).toEqual(["other", "proj", "home", "idle", "quiet"]);
    expect(byActivity(st, "other").map((w) => w.id)).toEqual(["proj", "home", "idle", "quiet", "other"]);
  });

  it("compares folders by whole segments", () => {
    expect(under("/a/proj", "/a/proj/src")).toBe(true);
    expect(under("/a/proj", "/a/proj")).toBe(true);
    expect(under("/a/proj", "/a/proj-old")).toBe(false);
  });
});
