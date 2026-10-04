import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@cmd/protocol";
import { checkoutOf } from "../src/agents/peers.ts";
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

describe("checkoutOf", () => {
  it("gives worktrees of one repository the same repo and their own root and branch", () => {
    const a = checkoutOf(path.join(main, "src"))!;
    const b = checkoutOf(tree)!;
    expect(a).toMatchObject({ root: main, branch: "master" });
    expect(b).toMatchObject({ root: tree, branch: "topic" });
    expect(a.repo).toBe(b.repo);
    expect(checkoutOf(other)).toBeNull();
  });
});

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
