import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classify } from "../src/agents/procinfo.ts";
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

// Hook events as cmd's hook spools them (agents/hooks.ts): <root>/<pane>/log/<ts>.<pid>.<Event>.json.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-status-"));
let seq = 0;
function writeEvent(paneId: string, name: string, payload: Record<string, unknown>, at: number) {
  const dir = path.join(root, paneId, "log");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${at}.${++seq}.${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ agent: "claude", ts: Math.floor(at / 1000), env: {}, event: { hook_event_name: name, ...payload } }));
  fs.utimesSync(file, at / 1000, at / 1000);
}

describe("tracker + the hook spool", () => {
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

describe("another agent kind in front of the pane's agent", () => {
  it("leaves the pane's agent as it is (codex run from Claude's shell)", async () => {
    const f = fakeFactory();
    let fg = { pid: 10, startedAt: 1, path: "/Users/me/.local/share/claude/versions/2.1.300", argv: ["2.1.300"] };
    const panes = new PaneManager(f.factory, { socketPath: "/tmp/t.sock", pollMs: 0, inspector: async () => fg });
    const agents = new AgentTracker(panes);
    const pane = panes.create();
    await panes.pollForeground();
    const a = agents.list()[0]!;
    expect(a).toMatchObject({ kind: "claude", version: "2.1.300", paneId: pane.id });
    const changed: unknown[] = [];
    agents.on("updated", (u) => changed.push(u));
    fg = { pid: 11, startedAt: 2, path: "/opt/homebrew/lib/node_modules/@openai/codex-0.144.5/bin/codex", argv: ["codex", "exec", "fix it"] };
    f.ptys[0]!.output("x");
    await panes.pollForeground();
    expect(panes.foreground(pane.id)).toMatchObject({ class: { kind: "agent", agent: "codex" }, version: "0.144.5" });
    expect(agents.list()).toEqual([a]);
    expect(changed).toEqual([]);
    // Back to Claude: still the same agent, never exited.
    fg = { pid: 10, startedAt: 1, path: "/Users/me/.local/share/claude/versions/2.1.300", argv: ["2.1.300"] };
    f.ptys[0]!.output("x");
    await panes.pollForeground();
    expect(agents.list()).toEqual([a]);
    agents.close();
    panes.dispose();
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

describe("headless scrollback", () => {
  it("keeps only what is read back (a UI's snapshot, the saved screen), within terminal.scrollback", async () => {
    const { LocalBackend } = await import("../src/terminals/local.ts");
    const { DEFAULT_SETTINGS } = await import("@cmd/protocol");
    const kept = (s: Partial<typeof DEFAULT_SETTINGS>) => {
      let asked = -1;
      const backend = new LocalBackend(fakeFactory().factory);
      const spawn = backend.spawn.bind(backend);
      backend.spawn = (o) => ((asked = o.scrollback), spawn(o));
      const panes = new PaneManager(backend, { socketPath: "/tmp/t.sock", pollMs: 0, settings: () => ({ ...DEFAULT_SETTINGS, ...s }) });
      panes.create();
      panes.dispose();
      return asked;
    };
    expect(kept({ "terminal.scrollback": 10000, "restore.scrollback": 2000 })).toBe(5000);
    expect(kept({ "terminal.scrollback": 1000 })).toBe(1000);
    expect(kept({ "terminal.scrollback": 50000, "restore.scrollback": 8000 })).toBe(8000);
  });
});
