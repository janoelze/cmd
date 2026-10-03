import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, HOME_SPACE_ID } from "@cmd/protocol";
import { AgentTracker } from "../src/agents/tracker.ts";
import { PaneManager } from "../src/panes.ts";
import { fakeFactory, type FakePty } from "./fake-pty.ts";

let panes: PaneManager;
let agents: AgentTracker;
let ptys: FakePty[];

beforeEach(() => {
  const f = fakeFactory();
  ptys = f.ptys;
  panes = new PaneManager(f.factory, { socketPath: "/tmp/test.sock", pollMs: 0 });
  agents = new AgentTracker(panes);
});

afterEach(() => vi.useRealTimers());

/** Simulates zsh printing its prompt, then going quiet. */
const shellReady = (pty: FakePty) => {
  pty.output("~ $ ");
  vi.advanceTimersByTime(300);
};

const setForeground = async (pty: FakePty, name: string) => {
  pty.process = name;
  await panes.pollForeground();
};

describe("detection", () => {
  it("creates an agent when an agent process takes the foreground and removes it on return to shell", async () => {
    const pane = panes.create();
    await setForeground(ptys[0]!, "claude");
    const [a] = agents.list();
    expect(a).toMatchObject({ kind: "claude", paneId: pane.id, spawn: { source: "detected" } });
    expect(panes.get(pane.id)!.agentId).toBe(a!.id);

    await setForeground(ptys[0]!, "zsh");
    expect(agents.list()).toEqual([]);
    expect(panes.get(pane.id)!.agentId).toBeNull();
  });

  it("injects pane id and socket into the environment", async () => {
    const pane = panes.create();
    expect(ptys[0]!.opts.env).toMatchObject({
      CMD_PANE_ID: pane.id,
      CMD_SOCKET: "/tmp/test.sock",
      GHOSTTY_AGENTS_SURFACE_ID: pane.id,
    });
  });

  it("uses OSC notifications only while no hooks report", async () => {
    const pane = panes.create();
    await setForeground(ptys[0]!, "codex");
    ptys[0]!.output("\x1b]9;Approve command?\x07");
    expect(agents.list()[0]).toMatchObject({ state: "needs_input", detail: "Approve command?" });

    agents.ingestHook(pane.id, "codex", "UserPromptSubmit", {});
    ptys[0]!.output("\x1b]9;ignored\x07");
    expect(agents.list()[0]).toMatchObject({ state: "working", detail: null });
  });
});

describe("hooks", () => {
  it("creates the agent from the first hook and tracks state + native ids", async () => {
    const pane = panes.create();
    agents.ingestHook(pane.id, "claude", "SessionStart", { session_id: "s1", transcript_path: "/t.jsonl" });
    agents.ingestHook(pane.id, "claude", "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
    expect(agents.list()[0]).toMatchObject({
      state: "working",
      detail: "ls",
      native: { claudeSessionId: "s1", transcriptPath: "/t.jsonl" },
    });
  });

  it("models Claude subagents as virtual children", async () => {
    const pane = panes.create();
    const host = agents.ingestHook(pane.id, "claude", "UserPromptSubmit", {})!;
    agents.ingestHook(pane.id, "claude", "SubagentStart", { agent_id: "sub1", agent_type: "Explore" });
    const child = agents.list().find((a) => a.parentId === host.id)!;
    expect(child).toMatchObject({ paneId: null, name: "Explore", depth: 1, rootId: host.id, state: "working" });

    agents.ingestHook(pane.id, "claude", "SubagentStop", { agent_id: "sub1", last_assistant_message: "found it" });
    expect(agents.get(child.id)).toMatchObject({ state: "done", lastMessage: "found it" });

    agents.ingestHook(pane.id, "claude", "SessionEnd", {});
    expect(agents.list()).toEqual([]);
  });
});

describe("host API", () => {
  it("spawns children in their own panes, linked to the host", async () => {
    vi.useFakeTimers();
    const hostPane = panes.create();
    const host = agents.ingestHook(hostPane.id, "claude", "UserPromptSubmit", {})!;
    const child = agents.spawn({ kind: "codex", prompt: "write tests", parentId: host.id, name: "tests" });

    expect(child).toMatchObject({ parentId: host.id, rootId: host.id, depth: 1, state: "starting", name: "tests" });
    const pty = ptys[1]!;
    expect(pty.opts.env).toMatchObject({ CMD_AGENT_ID: child.id, CMD_PARENT_ID: host.id });
    shellReady(pty);
    expect(pty.written[0]).toBe("codex 'write tests'\r");

    // still at the shell prompt before the agent starts: must not count as exited
    await panes.pollForeground();
    expect(agents.get(child.id)!.state).toBe("starting");
    await setForeground(pty, "codex");
    expect(agents.get(child.id)!.state).toBe("idle");
  });

  it("launches claude with a known session id", async () => {
    vi.useFakeTimers();
    const a = agents.spawn({ kind: "claude", prompt: "it's fine" });
    shellReady(ptys[0]!);
    expect(ptys[0]!.written[0]).toBe(`claude --session-id ${a.native.claudeSessionId} 'it'\\''s fine'\r`);
  });

  it("wait resolves when children reach the target state", async () => {
    const c1 = agents.spawn({ kind: "codex" });
    const c2 = agents.spawn({ kind: "codex" });
    const any = agents.wait([c1.id, c2.id], ["done"], "any", 1000);
    const all = agents.wait([c1.id, c2.id], ["done"], "all", 1000);
    agents.ingestHook(c1.paneId!, "codex", "Stop", {});
    expect((await any).timedOut).toBe(false);
    agents.ingestHook(c2.paneId!, "codex", "Stop", {});
    expect((await all).agents.map((a) => a.state)).toEqual(["done", "done"]);
  });

  it("wait times out", async () => {
    const c = agents.spawn({ kind: "codex" });
    expect(await agents.wait([c.id], ["done"], "all", 20)).toMatchObject({ timedOut: true });
  });

  it("kill --tree closes all descendants", async () => {
    const host = agents.spawn({ kind: "claude" });
    const child = agents.spawn({ kind: "codex", parentId: host.id });
    const grandchild = agents.spawn({ kind: "codex", parentId: child.id });
    expect(grandchild.depth).toBe(2);
    const killed = agents.kill(host.id, true);
    expect(killed).toEqual([grandchild.id, child.id, host.id]);
    expect(agents.list()).toEqual([]);
    expect(panes.list()).toEqual([]);
  });

  it("keeps an exited host visible while it still has live workers", async () => {
    const host = agents.spawn({ kind: "claude" });
    const child = agents.spawn({ kind: "codex", parentId: host.id });
    ptys[0]!.exit(0);
    expect(agents.get(host.id)).toMatchObject({ state: "exited", paneId: null });
    expect(agents.get(child.id)!.parentId).toBe(host.id);
  });
});

describe("launch commands", () => {
  it("waits for shell startup output to settle before typing", async () => {
    vi.useFakeTimers();
    panes.create({ command: "echo hi" });
    const pty = ptys[0]!;
    pty.output("Last login: today\r\n");
    vi.advanceTimersByTime(100);
    pty.output("~ $ ");
    vi.advanceTimersByTime(200);
    expect(pty.written).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(pty.written).toEqual(["echo hi\r"]);
  });

  it("types immediately on an OSC 133;B prompt mark", async () => {
    vi.useFakeTimers();
    panes.create({ command: "ls" });
    ptys[0]!.output("\x1b]133;A\x07~ $ \x1b]133;B\x07");
    expect(ptys[0]!.written).toEqual(["ls\r"]);
  });

  it("falls back to a deadline for a silent shell", async () => {
    vi.useFakeTimers();
    panes.create({ command: "ls" });
    vi.advanceTimersByTime(4000);
    expect(ptys[0]!.written).toEqual(["ls\r"]);
  });
});

describe("launch failures", () => {
  it("drops a launched agent whose process never appears", async () => {
    vi.useFakeTimers();
    const f = fakeFactory();
    const p = new PaneManager(f.factory, { socketPath: "/tmp/t.sock", pollMs: 0 });
    const t = new AgentTracker(p, { startTimeoutMs: 1000 });
    const a = t.spawn({ kind: "claude", prompt: "hi" });
    await p.pollForeground(); // still the shell
    vi.advanceTimersByTime(1500);
    expect(t.get(a.id)).toBeNull();
    expect(p.get(a.paneId!)!.agentId).toBeNull();
  });
});

describe("resume command", () => {
  it("is built by the core: cd, the profile's env from the transcript folder, the configured command", () => {
    const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-profile-")));
    fs.mkdirSync(path.join(profile, "projects", "-p"), { recursive: true });
    const t = new AgentTracker(panes, { settings: () => ({ ...DEFAULT_SETTINGS, "agents.claude.command": "claude --model opus" }) });
    const pane = panes.create();
    expect(t.resumeCommand(t.ingestHook(pane.id, "claude", "UserPromptSubmit", { cwd: "/tmp" })!.id)).toBeNull(); // no session yet
    const a = t.ingestHook(pane.id, "claude", "SessionStart", {
      session_id: "abc",
      cwd: "/tmp/it's",
      transcript_path: path.join(profile, "projects", "-p", "abc.jsonl"),
    })!;
    expect(t.resumeCommand(a.id)).toBe(`cd '/tmp/it'\\''s' && CLAUDE_CONFIG_DIR='${profile}' claude --model opus --resume 'abc'`);
    const r = t.resume({ agent: "codex", sessionId: "t1", cwd: null, spaceId: HOME_SPACE_ID });
    expect(t.resumeCommand(r.id)).toBe(`cd '${os.homedir()}' && codex resume 't1'`);
    fs.rmSync(profile, { recursive: true, force: true });
  });
});
