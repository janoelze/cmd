// Terminals and agents come back after a core restart (restore.ts): in-process
// terminals die with the core, so every pane is resurrected under its old id.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import headless from "@xterm/headless";
import { Core } from "../src/core.ts";
import { fakeFactory, type FakePty } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";
import { until } from "../../../test/system.ts";

let dir: string;
beforeEach(() => void (dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-restore-")))));
afterEach(() => rmTemp(dir));

let n = 0;
/** A core on a database that outlives it, like the real one's. */
function start(db: string): { core: Core; ptys: FakePty[] } {
  const f = fakeFactory();
  const core = new Core({ socketPath: path.join(dir, `c${n++}.sock`), dbPath: db, terminals: f.factory, pollMs: 0, home: dir });
  // Panes default to $SHELL, which isn't zsh everywhere (CI runners use bash); the integration is zsh's.
  core.settings.set("shell.program", "/bin/zsh");
  return { core, ptys: f.ptys };
}

async function text(core: Core, paneId: string): Promise<string> {
  const { data, cols, rows } = await core.panes.snapshot(paneId);
  const t = new headless.Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((r) => t.write(data, r));
  const lines: string[] = [];
  for (let i = 0; i < t.buffer.active.length; i++) lines.push(t.buffer.active.getLine(i)!.translateToString(true));
  return lines.join("\n").trimEnd();
}


describe("restore after a core restart", () => {
  it("brings terminals back under their ids, in their folders, with their screens", async () => {
    const db = path.join(dir, "a.sqlite");
    const a = start(db);
    const pane = a.core.panes.create({ cwd: dir, cols: 60, rows: 10 });
    a.core.panes.setMuted(pane.id, true);
    a.ptys[0]!.output("$ echo hello\r\nhello\r\n$ ");
    await a.core.close();

    const b = start(db);
    b.core.restore();
    const [p] = b.core.panes.list();
    expect(p).toMatchObject({ id: pane.id, cwd: dir, cols: 60, rows: 10, muted: true });
    expect(b.ptys[0]!.opts.cwd).toBe(dir);
    const shown = await text(b.core, pane.id);
    expect(shown).toContain("hello");
    expect(shown).toMatch(/Restored/);
    await b.core.close();
  });

  it("starts a terminal whose folder is gone in its workspace's, and says so", async () => {
    const db = path.join(dir, "gone.sqlite");
    const tree = path.join(dir, "tree");
    fs.mkdirSync(tree);
    const a = start(db);
    const pane = a.core.panes.create({ cwd: tree, cols: 100, rows: 10 });
    await a.core.close();
    fs.rmSync(tree, { recursive: true });

    const b = start(db);
    b.core.restore();
    expect(b.ptys[0]!.opts.cwd).toBe(b.core.workspaces.home().root);
    expect((await text(b.core, pane.id)).replace(/\n/g, "")).toContain(`${tree} is gone, started in`);
    await b.core.close();
  });

  it("offers a command that was running instead of running it", async () => {
    const db = path.join(dir, "b.sqlite");
    const a = start(db);
    const pane = a.core.panes.create({ cwd: dir });
    const token = a.ptys[0]!.opts.env.CMD_PANE_TOKEN;
    // What the zsh integration reports from preexec (only with the pane's token).
    a.ptys[0]!.output(`\x1b]777;cmd;${token};exec;npm run dev\x07`);
    a.ptys[0]!.output(`\x1b]777;cmd;forged;exec;rm -rf ~\x07`);
    expect(a.core.panes.command(pane.id)).toBe("npm run dev");
    await a.core.close();

    const b = start(db);
    b.core.restore();
    expect(b.ptys[0]!.opts.env.CMD_RESTORE_COMMAND).toBe("npm run dev");
    expect(b.ptys[0]!.written).toEqual([]);
    expect(await text(b.core, pane.id)).toContain("was running: npm run dev");
    await b.core.close();
  });

  it("forgets the command once the shell is back at its prompt", async () => {
    const db = path.join(dir, "c.sqlite");
    const a = start(db);
    const pane = a.core.panes.create({ cwd: dir });
    const token = a.ptys[0]!.opts.env.CMD_PANE_TOKEN;
    a.ptys[0]!.output(`\x1b]777;cmd;${token};exec;make\x07`);
    a.ptys[0]!.output("\x1b]133;D;0\x07\x1b]133;A\x07$ ");
    expect(a.core.panes.command(pane.id)).toBeNull();
    await a.core.close();

    const b = start(db);
    b.core.restore();
    expect(b.ptys[0]!.opts.env.CMD_RESTORE_COMMAND).toBeUndefined();
    await b.core.close();
  });

  it("drops terminals that were closed, and those of closed workspaces", async () => {
    const db = path.join(dir, "d.sqlite");
    fs.mkdirSync(path.join(dir, "proj"));
    const a = start(db);
    const closed = a.core.panes.create({ cwd: dir });
    a.ptys[0]!.exit(0);
    const { workspace } = a.core.workspaces.open(path.join(dir, "proj"));
    a.core.panes.create({ cwd: dir, workspaceId: workspace.id });
    await a.core.call("workspace.close", { id: workspace.id });
    await a.core.close();

    const b = start(db);
    b.core.restore();
    expect(b.core.panes.list()).toEqual([]);
    expect(b.core.panes.get(closed.id)).toBeNull();
    await b.core.close();
  });

  it("resumes an agent session in its terminal, keeping the agent's id", async () => {
    const db = path.join(dir, "e.sqlite");
    const transcript = path.join(dir, "session.jsonl");
    fs.writeFileSync(transcript, "{}\n");
    const a = start(db);
    const pane = a.core.panes.create({ cwd: dir });
    const agent = a.core.agents.ingestHook(pane.id, "claude", "SessionStart", { session_id: "abc-123", transcript_path: transcript, cwd: dir })!;
    a.core.agents.markSeen(agent.id);
    const seenAt = a.core.agents.get(agent.id)!.seenAt;
    await a.core.close();

    const b = start(db);
    b.core.restore();
    expect(b.core.panes.get(pane.id)).toMatchObject({ agentId: agent.id });
    expect(b.core.agents.get(agent.id)).toMatchObject({ paneId: pane.id, state: "starting", seenAt, native: { claudeSessionId: "abc-123" } });
    expect(b.ptys[0]!.opts.env.CMD_AGENT_ID).toBe(agent.id);
    // Typed once the shell is ready.
    b.ptys[0]!.output("\x1b]133;A\x07");
    await until("the restored command typed", () => b.ptys[0]!.written.length > 0);
    expect(b.ptys[0]!.written.join("")).toMatch(/--resume 'abc-123'/);
    await b.core.close();
  });

  it("puts the resume command on the command line when agents aren't resumed", async () => {
    const db = path.join(dir, "f.sqlite");
    const transcript = path.join(dir, "session.jsonl");
    fs.writeFileSync(transcript, "{}\n");
    const a = start(db);
    const pane = a.core.panes.create({ cwd: dir });
    a.core.agents.ingestHook(pane.id, "claude", "SessionStart", { session_id: "abc-123", transcript_path: transcript, cwd: dir });
    await a.core.close();

    const b = start(db);
    b.core.settings.set("restore.resumeAgents", false);
    b.core.restore();
    expect(b.ptys[0]!.opts.env.CMD_RESTORE_COMMAND).toMatch(/--resume 'abc-123'/);
    expect(b.core.agents.list()).toEqual([]);
    await b.core.close();
  });

  it("doesn't resume a session that never saved a transcript", async () => {
    const db = path.join(dir, "g.sqlite");
    const a = start(db);
    const pane = a.core.panes.create({ cwd: dir });
    a.core.agents.ingestHook(pane.id, "claude", "SessionStart", { session_id: "abc-123", transcript_path: path.join(dir, "missing.jsonl"), cwd: dir });
    await a.core.close();

    const b = start(db);
    b.core.restore();
    expect(b.core.panes.list()).toHaveLength(1);
    expect(b.core.agents.list()).toEqual([]);
    expect(b.ptys[0]!.opts.env.CMD_RESTORE_COMMAND).toBeUndefined();
    await b.core.close();
  });

  it("keeps nothing with restore.terminals off", async () => {
    const db = path.join(dir, "h.sqlite");
    const a = start(db);
    a.core.panes.create({ cwd: dir });
    await a.core.close();

    const b = start(db);
    b.core.settings.set("restore.terminals", false);
    b.core.restore();
    expect(b.core.panes.list()).toEqual([]);
    expect(b.core.store.panes()).toEqual([]);
    await b.core.close();
  });

  it("leaves the terminals and agents of a copied database to the cmd it came from", async () => {
    const db = path.join(dir, "i.sqlite");
    const transcript = path.join(dir, "session.jsonl");
    fs.writeFileSync(transcript, "{}\n");
    const a = start(db);
    a.core.restore();
    const pane = a.core.panes.create({ cwd: dir });
    a.core.agents.ingestHook(pane.id, "claude", "SessionStart", { session_id: "abc-123", transcript_path: transcript, cwd: dir });
    await a.core.close();

    const copy = path.join(dir, "copy.sqlite");
    fs.copyFileSync(db, copy);
    const b = start(copy);
    b.core.restore();
    expect(b.core.panes.list()).toEqual([]);
    expect(b.core.agents.list()).toEqual([]);
    expect(b.ptys).toEqual([]);
    expect(b.core.store.panes()).toEqual([]);
    // The copy is its own from now on: its next terminals come back as usual.
    const own = b.core.panes.create({ cwd: dir });
    await b.core.close();
    const c = start(copy);
    c.core.restore();
    expect(c.core.panes.list().map((p) => p.id)).toEqual([own.id]);
    await c.core.close();

    // The original still has its session.
    const d = start(db);
    d.core.restore();
    expect(d.core.panes.get(pane.id)).toMatchObject({ agentId: expect.any(String) });
    await d.core.close();
  });
});

describe("UI state of closed windows", () => {
  it("goes with the window", async () => {
    const { core } = start(path.join(dir, "ui.sqlite"));
    const w = core.windows.open("files", { path: dir }, core.workspaces.home());
    core.store.setUiState(`files.expanded.${w.id}`, [dir]);
    core.store.setUiState("sidebar.open", true);
    core.windows.close(w.id);
    expect(core.store.uiState()).toEqual({ "sidebar.open": true });
    await core.close();
  });
});

describe("each terminal's own shell history", () => {
  it("is kept under the pane's id for restoring, and goes when the terminal closes", async () => {
    const db = path.join(dir, "hist.sqlite");
    const f = fakeFactory();
    const core = new Core({ socketPath: path.join(dir, "h.sock"), dbPath: db, terminals: f.factory, pollMs: 0, home: dir, stateDir: dir });
    core.settings.set("shell.program", "/bin/zsh"); // the integration (and so the history) is zsh's; the fake runs nothing
    const pane = core.panes.create({ cwd: dir });
    const file = f.ptys[0]!.opts.env.CMD_PANE_HISTFILE!;
    expect(file).toBe(path.join(dir, "history", `${pane.id}.zsh_history`));
    fs.writeFileSync(file, ": 1:0;echo hi\n");
    f.ptys[0]!.exit(0);
    expect(fs.existsSync(file)).toBe(false);
    await core.close();
  });

  it("is in the shell's own format: bash's for bash, none for fish", async () => {
    const f = fakeFactory();
    const core = new Core({ socketPath: path.join(dir, "h2.sock"), dbPath: null, terminals: f.factory, pollMs: 0, home: dir, stateDir: dir });
    core.settings.set("shell.program", "/usr/local/bin/bash");
    const pane = core.panes.create({ cwd: dir });
    const file = f.ptys[0]!.opts.env.CMD_PANE_HISTFILE!;
    expect(file).toBe(path.join(dir, "history", `${pane.id}.bash_history`));
    fs.writeFileSync(file, "echo hi\n");
    f.ptys[0]!.exit(0);
    expect(fs.existsSync(file)).toBe(false);
    core.settings.set("shell.program", "/usr/local/bin/fish");
    core.panes.create({ cwd: dir });
    expect(f.ptys[1]!.opts.env.CMD_PANE_HISTFILE).toBeUndefined();
    expect(f.ptys[1]!.opts.env.CMD_PANE_TOKEN).toBeTruthy();
    await core.close();
  });
});

describe("records another cmd version saved", () => {
  /** Rows written straight into the database, as an older or broken cmd might have left them. */
  function tamper(db: string, sql: string[]): void {
    const d = new DatabaseSync(db);
    for (const q of sql) d.exec(q);
    d.close();
  }

  it("skips rows it can't read and fills in fields older ones lack", async () => {
    const db = path.join(dir, "old.sqlite");
    const a = start(db);
    const pane = a.core.panes.create({ cwd: dir });
    await a.core.close();
    const old = JSON.stringify({ id: "old-agent", kind: "claude", paneId: pane.id, turn: { agentId: "old-agent", index: 0, prompt: "hi" } });
    tamper(db, [
      `INSERT INTO agents (id, parent_id, root_id, doc, updated_at) VALUES ('broken', NULL, 'broken', 'not json', 0)`,
      `INSERT INTO agents (id, parent_id, root_id, doc, updated_at) VALUES ('old-agent', NULL, 'old-agent', '${old}', 1)`,
      `INSERT INTO panes (id, doc) VALUES ('no-id', '{"cwd": "/"}')`,
      `INSERT INTO windows (id, doc) VALUES ('w', '[1, 2]')`,
      `INSERT INTO workspaces (id, root, doc) VALUES ('s', '/nowhere', '{')`,
      `INSERT INTO ui_state (key, value, updated_at) VALUES ('k', 'nope', 0)`,
    ]);

    const b = start(db);
    expect(b.core.store.agents()).toMatchObject([{ id: "old-agent", rootId: "old-agent", native: {}, turn: { notes: [], followUps: [], files: [] } }]);
    expect(() => b.core.restore()).not.toThrow();
    expect(b.core.panes.list().map((p) => p.id)).toEqual([pane.id]);
    expect(b.core.store.uiState()).not.toHaveProperty("k");
    await b.core.close();
  });

  it("restores the rest when one agent fails", async () => {
    const db = path.join(dir, "fail.sqlite");
    const transcript = path.join(dir, "session.jsonl");
    fs.writeFileSync(transcript, "{}\n");
    const a = start(db);
    const one = a.core.panes.create({ cwd: dir });
    const two = a.core.panes.create({ cwd: dir });
    a.core.agents.ingestHook(one.id, "claude", "SessionStart", { session_id: "s-1", transcript_path: transcript, cwd: dir });
    const kept = a.core.agents.ingestHook(two.id, "claude", "SessionStart", { session_id: "s-2", transcript_path: transcript, cwd: dir })!;
    await a.core.close();

    const b = start(db);
    const restore = b.core.agents.restore.bind(b.core.agents);
    vi.spyOn(b.core.agents, "restore").mockImplementation((stored, live) => {
      if (stored.id !== kept.id) throw new TypeError("this.turn.notes is not iterable");
      return restore(stored, live);
    });
    expect(() => b.core.restore()).not.toThrow();
    expect(b.core.panes.list().map((p) => p.id).sort()).toEqual([one.id, two.id].sort());
    expect(b.core.agents.list().map((x) => x.id)).toEqual([kept.id]);
    await b.core.close();
  });
});

describe("agents in the store", () => {
  it("keep their identity and state, not a copy of their turn; restore takes the turn from the turns view", async () => {
    const { Store } = await import("../src/store.ts");
    const { AgentTracker } = await import("../src/agents/tracker.ts");
    const { PaneManager } = await import("../src/panes.ts");
    const store = new Store(":memory:");
    const panes = new PaneManager(fakeFactory().factory, { socketPath: "/tmp/t.sock", pollMs: 0 });
    const tracker = new AgentTracker(panes, { store });
    const turn = { format: 2, derivedBy: null, agentId: "a1", agentKind: "claude", agentVersion: null, model: null, index: 0, sessionId: "s", turnId: null, startedAt: 1, endedAt: 2, prompt: "hi", auto: false, followUps: [], notes: [], background: [], outcome: "done", ask: null, final: "Done.", error: null, tools: [], commands: [], shellWrites: 0, files: [], subagents: 0, events: 1, inferred: [] } as const;
    tracker.activity.saveTurn({ ...turn, followUps: [], notes: [], background: [], tools: [], commands: [], files: [], inferred: [] }, 1);
    store.saveAgent({ id: "a1", paneId: null, workspaceId: "home", kind: "claude", name: null, cwd: "/w", parentId: null, rootId: "a1", depth: 0, spawn: { source: "detected" }, native: {}, state: "done", stateSince: 2, detail: null, lastMessage: "Done.", lastPrompt: "hi", seenAt: null, createdAt: 1, turn: { ...turn, followUps: [], notes: [], background: [], tools: [], commands: [], files: [], inferred: [] } });
    const raw = JSON.parse((store.db.prepare(`SELECT doc FROM agents WHERE id = 'a1'`).get() as { doc: string }).doc);
    expect(raw).not.toHaveProperty("turn");
    const [row] = store.agents();
    expect(row!.turn ?? null).toBeNull();
    const back = tracker.restore(row!, true);
    expect(back.turn).toMatchObject({ index: 0, prompt: "hi", final: "Done." });
    tracker.close();
    panes.dispose();
    store.close();
  });
});
