import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@cmd/protocol";
import { AgentTracker } from "../src/agents/tracker.ts";
import { PaneManager } from "../src/panes.ts";
import { fakeFactory } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

let dir: string, main: string, tree: string, other: string;
let settings = { ...DEFAULT_SETTINGS, "agents.peers": true };
let panes: PaneManager;
let agents: AgentTracker;

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-peers-")));
  main = path.join(dir, "app");
  tree = path.join(dir, "app-topic");
  other = path.join(dir, "elsewhere");
  fs.mkdirSync(path.join(main, "src"), { recursive: true });
  fs.mkdirSync(other);
  git(main, "init", "-q", "-b", "master");
  git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git(main, "worktree", "add", "-q", "-b", "topic", tree);
  settings = { ...DEFAULT_SETTINGS, "agents.peers": true };
  panes = new PaneManager(fakeFactory().factory, { socketPath: "/tmp/test.sock", pollMs: 0 });
  agents = new AgentTracker(panes, { settings: () => settings });
});

afterEach(() => rmTemp(dir));

/** An agent reporting SessionStart from `cwd`; returns its id and briefing. */
const start = (cwd: string, prompt?: string) => {
  const pane = panes.create();
  const a = agents.ingestHook(pane.id, "claude", "SessionStart", { cwd })!;
  if (prompt) agents.ingestHook(pane.id, "claude", "UserPromptSubmit", { cwd, prompt });
  return { id: a.id, pane: pane.id, briefing: agents.peerBriefing(a.id, "SessionStart") };
};

describe("peer briefings", () => {
  it("tells an agent about others in any worktree of its repository, not elsewhere", () => {
    const first = start(main, "fix the canvas\nmore detail");
    expect(first.briefing).toBeNull();
    start(other, "unrelated");
    const second = start(tree);
    expect(second.briefing).toContain(`id ${first.id.slice(0, 8)}`);
    expect(second.briefing).toContain(`${main} on master, working on "fix the canvas"`);
    expect(second.briefing).not.toContain("unrelated");
    expect(second.briefing).toContain("cmd send <id>");
  });

  it("says where each agent works, not where it started", () => {
    const first = start(main, "the topic");
    agents.ingestHook(first.pane, "claude", "PreToolUse", { cwd: main, tool_name: "Write", tool_input: { file_path: path.join(tree, "a.txt"), content: "a" } });
    expect(agents.get(first.id)!.git).toMatchObject({ top: tree, project: main, linked: true, branch: "topic" });
    // Going back to look at the main checkout doesn't move an agent that wrote in its worktree.
    agents.ingestHook(first.pane, "claude", "PreToolUse", { cwd: main, tool_name: "Bash", tool_input: { command: `cd ${main} && git log` } });
    expect(agents.get(first.id)!.git?.top).toBe(tree);
    const second = start(main);
    expect(second.briefing).toContain(`${tree} on topic, working on "the topic"`);
    expect(second.briefing).not.toContain("same checkout as you");
  });

  it("moves an agent that hasn't written anywhere to where it goes", () => {
    const a = start(main);
    expect(agents.get(a.id)!.git).toMatchObject({ top: main, linked: false, branch: "master" });
    agents.ingestHook(a.pane, "claude", "PreToolUse", { cwd: main, tool_name: "Bash", tool_input: { command: `cd ${tree} && ls` } });
    expect(agents.get(a.id)!.git?.top).toBe(tree);
    agents.ingestHook(a.pane, "claude", "PreToolUse", { cwd: main, tool_name: "Bash", tool_input: { command: `cd ${other} && ls` } });
    expect(agents.get(a.id)!.git?.top).toBe(tree);
  });

  it("puts a subagent where it writes, and leaves its host where it was", () => {
    const sub = path.join(main, ".claude", "worktrees", "agent-a1b2c3d4");
    git(main, "worktree", "add", "-q", "-b", "worktree-agent-a1b2c3d4", sub);
    const host = start(main, "plan");
    agents.ingestHook(host.pane, "claude", "SubagentStart", { cwd: main, agent_id: "s1", agent_type: "general-purpose" });
    agents.ingestHook(host.pane, "claude", "PreToolUse", { cwd: sub, agent_id: "s1", tool_name: "Write", tool_input: { file_path: path.join(sub, "y.md"), content: "a" } });
    expect(agents.get(host.id)).toMatchObject({ name: null, git: { top: main, linked: false } });
    const child = agents.list().find((a) => a.parentId === host.id)!;
    expect(child.git).toMatchObject({ top: sub, linked: true, branch: "worktree-agent-a1b2c3d4" });
  });

  it("says so on a prompt only when the peers changed", () => {
    const first = start(main);
    expect(agents.peerBriefing(first.id, "UserPromptSubmit")).toBeNull();
    const second = start(path.join(main, "src"));
    expect(agents.peerBriefing(first.id, "UserPromptSubmit")).toContain(`id ${second.id.slice(0, 8)}`);
    expect(agents.peerBriefing(first.id, "UserPromptSubmit")).toBeNull();
    agents.ingestHook(second.pane, "claude", "SessionEnd", {});
    expect(agents.peerBriefing(first.id, "UserPromptSubmit")).toContain("none are working in parallel");
    expect(agents.peerBriefing(first.id, "PreToolUse")).toBeNull();
  });

  it("is off unless the setting is on", () => {
    settings = { ...DEFAULT_SETTINGS };
    start(main);
    expect(start(tree).briefing).toBeNull();
  });
});
