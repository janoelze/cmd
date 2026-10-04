import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classify } from "../src/agents/procinfo.ts";
import { deriveStatus, readStatus } from "../src/agents/statusfiles.ts";
import { AgentTracker } from "../src/agents/tracker.ts";
import { PaneManager } from "../src/panes.ts";
import { fakeFactory, type FakePty } from "./fake-pty.ts";

describe("classify (port of AgentProcess.classify)", () => {
  it("sees agents through wrappers", () => {
    expect(classify({ path: "/bin/bash", argv: ["bash", "/opt/safehouse/bin/safehouse", "--", "/Users/me/.local/bin/claude", "--resume", "x"] })).toEqual({ kind: "agent", agent: "claude" });
    expect(classify({ path: "/usr/bin/sandbox-exec", argv: ["sandbox-exec", "-f", "p.sb", "claude"] })).toEqual({ kind: "agent", agent: "claude" });
    expect(classify({ path: "/opt/homebrew/bin/node", argv: ["node", "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex"] })).toEqual({ kind: "agent", agent: "codex" });
    expect(classify({ path: "/Users/me/.local/share/claude/versions/2.1.300", argv: ["2.1.300", "--dangerously-skip-permissions"] })).toEqual({ kind: "agent", agent: "claude" });
  });

  it("tells shells from other programs", () => {
    expect(classify({ path: "/bin/zsh", argv: ["-zsh"] })).toEqual({ kind: "shell" });
    expect(classify({ path: "/usr/bin/vim", argv: ["vim", "notes.md"] })).toEqual({ kind: "other", name: "vim" });
  });
});

// Hook status files written by ~/.claude/hooks/ghostty-agents-status.sh
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-status-"));
function writeEvent(paneId: string, name: string, payload: Record<string, unknown>, at: number) {
  const dir = path.join(root, paneId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ agent: "claude", ts: Math.floor(at / 1000), event: { hook_event_name: name, ...payload } }));
  fs.utimesSync(file, at / 1000, at / 1000);
}

describe("status files (port of AgentStatusStore)", () => {
  const t0 = Date.now() - 60_000;

  it("derives state, prompt and current activity", () => {
    writeEvent("p1", "SessionStart", { session_id: "s1", cwd: "/repo" }, t0);
    writeEvent("p1", "UserPromptSubmit", { session_id: "s1", prompt: "fix the tests\nplease" }, t0 + 1000);
    writeEvent("p1", "PreToolUse", { session_id: "s1", tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } }, t0 + 2000);
    expect(readStatus("p1", 0, root)).toMatchObject({
      state: "working",
      sessionId: "s1",
      lastPrompt: "fix the tests",
      activity: "Editing a.ts",
      cwd: "/repo",
    });
    writeEvent("p1", "Notification", { session_id: "s1", notification_type: "permission_prompt", message: "Allow Bash?" }, t0 + 3000);
    expect(readStatus("p1", 0, root)).toMatchObject({ state: "needs_input", message: "Allow Bash?" });
    writeEvent("p1", "Stop", { session_id: "s1" }, t0 + 4000);
    writeEvent("p1", "Notification", { session_id: "s1", notification_type: "idle_prompt" }, t0 + 5000);
    expect(readStatus("p1", 0, root)!.state).toBe("done");
  });

  it("only counts the newest session and ignores status older than the process", () => {
    writeEvent("p2", "Stop", { session_id: "old" }, t0);
    writeEvent("p2", "UserPromptSubmit", { session_id: "new", prompt: "hi" }, t0 + 1000);
    expect(readStatus("p2", 0, root)).toMatchObject({ state: "working", sessionId: "new" });
    expect(readStatus("p2", t0 + 5000, root)).toBeNull();
  });

  it("drops a tool call that belongs to the previous prompt", () => {
    const evs = [
      { name: "PreToolUse", agent: "claude", date: 1, payload: { tool_name: "Read", tool_input: { file_path: "/x" } } },
      { name: "UserPromptSubmit", agent: "claude", date: 2, payload: { prompt: "next" } },
    ];
    expect(deriveStatus(evs)).toMatchObject({ state: "working", activity: null });
  });
});

describe("tracker + status files", () => {
  let panes: PaneManager;
  let agents: AgentTracker;
  let ptys: FakePty[];
  beforeEach(() => {
    const f = fakeFactory();
    ptys = f.ptys;
    panes = new PaneManager(f.factory, { socketPath: "/tmp/t.sock", pollMs: 0 });
    agents = new AgentTracker(panes, { statusRoot: root });
  });
  afterEach(() => agents.close());

  it("applies hook status to the detected agent of that pane", async () => {
    const pane = panes.create();
    ptys[0]!.process = "claude";
    await panes.pollForeground();
    writeEvent(pane.id, "UserPromptSubmit", { session_id: "abc", prompt: "write docs", transcript_path: "/t.jsonl" }, Date.now());
    writeEvent(pane.id, "PreToolUse", { session_id: "abc", tool_name: "Write", tool_input: { file_path: "/r/README.md" } }, Date.now() + 10);
    agents.applyStatus(pane.id);
    expect(agents.list()[0]).toMatchObject({
      kind: "claude",
      state: "working",
      detail: "Writing README.md",
      lastPrompt: "write docs",
      native: { claudeSessionId: "abc", transcriptPath: "/t.jsonl" },
    });
  });

  it("doesn't re-emit status that hasn't changed (the 2 s backstop re-reads it)", async () => {
    const pane = panes.create();
    ptys[0]!.process = "claude";
    await panes.pollForeground();
    writeEvent(pane.id, "UserPromptSubmit", { session_id: "abc", prompt: "write docs", transcript_path: "/t.jsonl" }, Date.now());
    agents.applyStatus(pane.id);
    let updates = 0;
    agents.on("updated", () => updates++);
    agents.applyStatus(pane.id);
    agents.applyStatus(pane.id);
    expect(updates).toBe(0);
    writeEvent(pane.id, "Stop", { session_id: "abc" }, Date.now() + 10);
    agents.applyStatus(pane.id);
    expect(updates).toBe(1);
  });

  it("picks up changes through the file watcher", async () => {
    const pane = panes.create();
    ptys[0]!.process = "claude";
    await panes.pollForeground();
    const updated = new Promise((r) => agents.on("updated", (a) => a.state === "needs_input" && r(a)));
    writeEvent(pane.id, "Notification", { session_id: "w", notification_type: "permission_prompt", message: "OK?" }, Date.now());
    await updated;
    expect(agents.list()[0]).toMatchObject({ state: "needs_input", detail: "OK?" });
  });

  it("ignores status for a pane that is back at the shell", async () => {
    const pane = panes.create();
    writeEvent(pane.id, "Stop", { session_id: "z" }, Date.now());
    agents.applyStatus(pane.id);
    expect(agents.list()).toEqual([]);
  });
});

describe("foreground polling", () => {
  it("checks quiet terminals only now and then, and right after output", async () => {
    const f = fakeFactory();
    let asked = 0;
    const panes = new PaneManager(f.factory, { socketPath: "/tmp/t.sock", pollMs: 0, inspector: async () => (asked++, null) });
    panes.create();
    await panes.pollForeground();
    await panes.pollForeground();
    expect(asked).toBe(1);
    f.ptys[0]!.output("x");
    await panes.pollForeground();
    expect(asked).toBe(2);
    panes.dispose();
  });
});
