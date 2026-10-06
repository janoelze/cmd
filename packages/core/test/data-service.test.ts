import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { DATA_FLAGS, DEFAULT_SETTINGS, HOOK_FORMAT, type Settings } from "@cmd/protocol";
import { DataService } from "../src/data/service.ts";

const service = (over: Partial<Settings> = {}, now = () => 1_800_000_000_000) => new DataService({ file: null, recordedBy: "test", settings: () => ({ ...DEFAULT_SETTINGS, ...over }), now });

describe("DataService", () => {
  it("records with redaction, marks what it changed, notes the entities", () => {
    const d = service();
    const e = d.record({ id: "c1", at: 1, type: "command", source: "osc", paneId: "p1", spaceId: "s1", text: "export TOKEN=abcdefghijklmnop", data: { command: "export TOKEN=abcdefghijklmnop", exitCode: 0, cwd: "/w", output: null } })!;
    expect(e.text).toBe("export TOKEN=[redacted]");
    expect((e.data as { command: string }).command).toContain("[redacted]");
    expect(e.flags & DATA_FLAGS.redacted).toBeTruthy();
    expect(d.store.entities("pane").map((x) => x.id)).toEqual(["p1"]);
    expect(d.store.entities("space").map((x) => x.id)).toEqual(["s1"]);
    const clean = d.record({ id: "c2", at: 2, type: "command", source: "osc", text: "ls", data: { command: "ls", exitCode: 0, cwd: "/w", output: null } })!;
    expect(clean.flags & DATA_FLAGS.redacted).toBeFalsy();
  });

  it("cuts content at the class's cap and says so", () => {
    const d = service();
    const e = d.record({ id: "c1", at: 1, type: "command", source: "osc", data: { command: "yes", exitCode: 0, cwd: "/", output: { chars: 300_000, cut: false } }, content: "y\n".repeat(150_000) })!;
    expect(e.flags & DATA_FLAGS.cut).toBeTruthy();
    expect(d.store.blob(e.blob!)!.length).toBe(256_000);
  });

  it("records nothing of a class that's switched off", () => {
    const d = service({ "data.record.output": false, "data.record.actions": false } as Partial<Settings>);
    expect(d.record({ id: "c", at: 1, type: "command", source: "osc", data: { command: "ls", exitCode: 0, cwd: "/", output: null } })).toBeNull();
    expect(d.record({ id: "u", at: 1, type: "user.look", source: "user", data: { agentId: "a" } })).toBeNull();
    expect(d.record({ id: "g", at: 1, type: "git.tag", source: "git", data: { tag: "v1", hash: "h", repo: "/r" } })).not.toBeNull();
    expect(d.explain().find((c) => c.class === "output")!.enabled).toBe(false);
  });

  it("prunes by class: output after 90 days, git never, the rest after data.keepDays", () => {
    const now = 1_800_000_000_000;
    const day = 86400_000;
    const d = service({ "data.keepDays": 10 } as Partial<Settings>, () => now);
    d.record({ id: "old-cmd", at: now - 91 * day, type: "command", source: "osc", data: { command: "ls", exitCode: 0, cwd: "/", output: null } });
    d.record({ id: "new-cmd", at: now - 89 * day, type: "command", source: "osc", data: { command: "ls", exitCode: 0, cwd: "/", output: null } });
    d.record({ id: "old-git", at: now - 400 * day, type: "git.tag", source: "git", data: { tag: "v1", hash: "h", repo: "/r" } });
    d.record({ id: "old-look", at: now - 11 * day, type: "user.look", source: "user", data: { agentId: "a" } });
    d.record({ id: "new-look", at: now - 9 * day, type: "user.look", source: "user", data: { agentId: "a" } });
    const r = d.prune();
    expect(r.events).toBe(2);
    expect(d.query({}).map((e) => e.id).sort()).toEqual(["data:prune:1800000000000", "new-cmd", "new-look", "old-git"]);
  });

  it("imports what an older cmd kept, once", () => {
    const legacy = new DatabaseSync(":memory:");
    // The activity log's tables as cmd ≤ 0.15 made them.
    legacy.exec(`CREATE TABLE agent_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL, pane_id TEXT, agent_id TEXT, agent TEXT, source TEXT NOT NULL, name TEXT NOT NULL, doc TEXT NOT NULL, env TEXT, schema INTEGER, cmd TEXT, hook INTEGER, agent_version TEXT, session_id TEXT);
                 CREATE TABLE agent_turns (agent_id TEXT NOT NULL, idx INTEGER NOT NULL, started_at REAL NOT NULL, last_event INTEGER NOT NULL DEFAULT 0, doc TEXT NOT NULL, PRIMARY KEY (agent_id, idx));`);
    const ins = legacy.prepare(`INSERT INTO agent_events (at, pane_id, agent_id, agent, source, name, doc, schema, cmd, hook, session_id) VALUES (?, 'p', 'a', 'claude', 'hook', ?, ?, 1, '0.14.4', ?, 's')`);
    ins.run(1000, "UserPromptSubmit", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "fix the flaky test", cwd: "/w" }), HOOK_FORMAT);
    ins.run(2000, "PreToolUse", JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "pnpm test" } }), HOOK_FORMAT);
    ins.run(3000, "PostToolUse", JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", tool_use_id: "t1", tool_response: "ok" }), HOOK_FORMAT);
    // The journal's own table as cmd ≤ 0.15 made it: live kinds come along, derived ones (agent.*) are views now.
    legacy.exec(`CREATE TABLE journal_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, until INTEGER, kind TEXT NOT NULL, key TEXT NOT NULL UNIQUE, space_id TEXT, repo TEXT, cwd TEXT, thread TEXT, text TEXT NOT NULL, data TEXT NOT NULL, source TEXT NOT NULL, schema INTEGER NOT NULL, cmd TEXT)`);
    const jins = legacy.prepare(`INSERT INTO journal_events (at, until, kind, key, cwd, thread, text, data, source, schema, cmd) VALUES (?, ?, ?, ?, '/w', ?, ?, ?, 'live', 1, '0.15.0')`);
    jins.run(4000, 4100, "command", "command:x", "pane:p", "pnpm test", JSON.stringify({ kind: "command", command: "pnpm test", exitCode: 0, paneId: "p" }));
    jins.run(5000, null, "agent.session", "session:s", "session:s", "derived", JSON.stringify({ kind: "agent.session", agent: "claude", sessionId: "s", title: null, firstPrompt: null, branch: null }));
    const d = service();
    expect(d.importLegacy(legacy)).toEqual({ hooks: 3, journal: 1 });
    expect(d.importLegacy(legacy)).toBeNull();
    const hooks = d.query({ types: ["agent.hook"] });
    expect(hooks.length).toBe(3);
    expect(hooks[0]!.text).toBe("fix the flaky test");
    expect(hooks[0]!.sessionId).toBe("claude:s");
    expect(hooks[2]!.parentId).toBe(hooks[1]!.id);
    expect(hooks.every((e) => e.flags & DATA_FLAGS.imported)).toBe(true);
    expect(d.query({ types: ["command"] })[0]!.text).toBe("pnpm test");
    expect(d.query({ text: "flaky" }).length).toBe(1);
    expect(d.query({ types: ["data.op"] }).length).toBe(1);
  });
});

describe("entities", () => {
  it("are described once per change, with links kept once, and a project knows its folder", async () => {
    const os = await import("node:os");
    const d = service();
    d.describe("agent", "a1", { kind: "claude", cwd: "/w" }, 10);
    d.describe("agent", "a1", { kind: "claude", cwd: "/w" }, 20); // the same: not written
    expect(d.store.entityOf("agent", "a1")).toMatchObject({ created: 10, seen: 10, attrs: { kind: "claude", cwd: "/w" } });
    d.describe("agent", "a1", { kind: "claude", cwd: "/w", model: "m" }, 30);
    expect(d.store.entityOf("agent", "a1")).toMatchObject({ seen: 30, attrs: { model: "m" } });
    d.link(["agent", "a1"], ["session", "claude:s"], "runs", 10);
    d.link(["agent", "a1"], ["session", "claude:s"], "runs", 50);
    d.store.link(["agent", "a1"], ["session", "claude:s"], "runs", 5); // straight to the store: still one row, earliest time
    expect(d.store.linksOf("session", "claude:s")).toEqual([{ from: ["agent", "a1"], to: ["session", "claude:s"], kind: "runs", at: 5, until: null }]);
    d.record({ id: "c", at: 1, type: "command", source: "osc", projectId: `dir:${os.tmpdir()}`, data: { command: "ls", exitCode: 0, cwd: os.tmpdir(), output: null } });
    expect(d.store.entityOf("project", `dir:${os.tmpdir()}`)?.attrs).toMatchObject({ path: os.tmpdir(), git: false });
  });
});

describe("retention in batches", () => {
  it("deletes at most a batch per call, oldest first, and says when more are due", () => {
    const now = 1_800_000_000_000;
    const d = service({ "data.keepDays": 1 } as Partial<Settings>, () => now);
    d.recordAll(Array.from({ length: 12 }, (_, i) => ({ id: `u${i}`, at: now - 10 * 86400_000 + i, type: "user.look" as const, source: "user", data: { agentId: "a" } })));
    expect(d.prune(5)).toMatchObject({ events: 5, more: true });
    expect(d.prune(5)).toMatchObject({ events: 5, more: true });
    expect(d.prune(5)).toMatchObject({ events: 2, more: false });
    expect(d.query({ types: ["user.look"] })).toEqual([]);
  });
});
