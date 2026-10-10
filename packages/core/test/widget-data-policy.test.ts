// The widget data policy (data/policy.ts, docs/28 §4): over the widgets socket a
// widget reads only its workspace, only the classes it may, output without what
// it printed, and nothing it passes in the query widens that.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "@cmd/protocol/node";
import type { DataEvent, NewDataEvent } from "@cmd/protocol";
import { Core, widgetsSocketPath } from "../src/core.ts";
import { POLICY, clampQuery } from "../src/data/policy.ts";
import { widgetQuery } from "../src/data/widgets.ts";
import { fakeFactory } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-wpolicy-"));
const socketPath = path.join(dir, "core.sock");
let core: Core;

const note = (id: string, workspaceId: string | null): NewDataEvent => ({ id, at: 10, type: "note", source: "cmd", workspaceId, text: id, data: { by: "user", agentSession: null } });

beforeAll(async () => {
  core = new Core({ socketPath, dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0 });
  await core.listen();
  core.data.recordAll([
    note("a-note", "A"),
    note("b-note", "B"),
    note("no-workspace-note", null),
    { id: "a-commit", at: 11, type: "git.commit", source: "git", workspaceId: "A", text: "fix", data: { hash: "h", subject: "fix", branch: "main", worktree: null, repo: "/r" } },
    { id: "a-hook", at: 12, type: "agent.hook", source: "hook:claude", workspaceId: "A", text: "prompt", data: { name: "UserPromptSubmit", agent: "claude", payload: { prompt: "the secret plan" } } },
    { id: "a-transcript", at: 13, type: "transcript.message", source: "claude", workspaceId: "A", text: "hello", data: { role: "user", text: "the secret plan" } },
    { id: "a-ai", at: 14, type: "ai.call", source: "cmd", workspaceId: "A", text: "journal", data: { purpose: "journal", provider: "p", model: "m", tier: "t", ms: 1, tokens: { in: 1, out: 1 }, ok: true } },
    { id: "a-command", at: 15, type: "command", source: "osc", workspaceId: "A", text: "cat .env", data: { command: "cat .env", exitCode: 0, cwd: "/r", git: null, output: { chars: 15, cut: false } }, content: "API_KEY=hunter2", body: "cat .env API_KEY=hunter2" },
    { id: "a-remote", at: 16, type: "remote.audit", source: "cmd", workspaceId: "A", text: "paired", data: { kind: "pair", detail: null } },
  ]);
});
afterAll(async () => {
  await core.close();
  rmTemp(dir);
});

/** A widget connection that said hello with a token for this identity. */
async function widget(workspaceId: string | null, events: string[] = []) {
  const w = await connect(widgetsSocketPath(socketPath));
  await w.client.call("widget.hello", { token: core.widgetTokens.issue({ widgetId: "w", workspaceId, events }) });
  return { query: (query: Record<string, unknown>) => w.client.call("data.query", { query }) as Promise<DataEvent[]>, close: () => w.close() };
}
const ids = (rows: DataEvent[]) => rows.map((e) => e.id).sort();

describe("the widget data policy", () => {
  it("reads only the token's workspace, whatever workspaceId the query passes", async () => {
    const w = await widget("A");
    expect(ids(await w.query({ types: ["note"] }))).toEqual(["a-note"]);
    expect(ids(await w.query({ types: ["note"], workspaceId: "B" }))).toEqual(["a-note"]);
    expect(ids(await w.query({ types: ["note"], workspaceId: "" }))).toEqual(["a-note"]);
    // No types: everything A's default classes hold, and nothing else.
    expect(ids(await w.query({}))).toEqual(["a-command", "a-commit", "a-note"]);
    w.close();
  });

  it("refuses a run without a workspace instead of reading all of them", async () => {
    const w = await widget(null);
    await expect(w.query({ types: ["note"] })).rejects.toThrow(/no workspace/);
    w.close();
  });

  it("denies transcripts, agents and ai unless declared, and says how to declare them", async () => {
    const w = await widget("A");
    await expect(w.query({ types: ["transcript."] })).rejects.toThrow(/add "transcripts" to permissions\.events in manifest\.json/);
    await expect(w.query({ types: ["agent.hook"] })).rejects.toThrow(/add "agents" to permissions\.events/);
    await expect(w.query({ types: ["agent."] })).rejects.toThrow(/add "agents"/);
    await expect(w.query({ types: ["ai."] })).rejects.toThrow(/add "ai"/);
    await expect(w.query({ types: ["note", "transcript.message"] })).rejects.toThrow(/transcripts/);
    // A prefix that starts below a class can't sneak past it either.
    await expect(w.query({ types: ["transcript.mess"] })).rejects.toThrow(/transcripts/);
    // Never, even declared.
    await expect(w.query({ types: ["remote."] })).rejects.toThrow(/widgets can't read/);
    w.close();

    const d = await widget("A", ["transcripts", "agents", "ai"]);
    expect(ids(await d.query({ types: ["transcript."] }))).toEqual(["a-transcript"]);
    expect(ids(await d.query({ types: ["agent.hook"] }))).toEqual(["a-hook"]);
    expect(ids(await d.query({ types: ["ai."] }))).toEqual(["a-ai"]);
    expect(ids(await d.query({ types: ["transcript."], workspaceId: "B" }))).toEqual(["a-transcript"]);
    expect(ids(await d.query({}))).not.toContain("a-remote");
    d.close();
  });

  it("gives output without what it printed unless declared", async () => {
    const w = await widget("A");
    const [c] = await w.query({ types: ["command"] });
    expect(c!.blob).toBeNull();
    expect(c!.data).toEqual({ command: "cat .env", exitCode: 0, cwd: "/r", git: null, output: { chars: 15, cut: false } });
    // Full text reaches the body (what it printed): not without the declaration.
    await expect(w.query({ types: ["command"], text: "hunter2" })).rejects.toThrow(/add "output"/);
    expect(ids(await w.query({ text: "hunter2" }))).toEqual([]);
    expect(ids(await w.query({ text: "fix" }))).toEqual(["a-commit"]);
    w.close();

    const d = await widget("A", ["output"]);
    const [full] = await d.query({ types: ["command"] });
    expect(full!.blob).toBeTruthy();
    expect(ids(await d.query({ types: ["command"], text: "hunter2" }))).toEqual(["a-command"]);
    d.close();
  });

  it("cuts output rows to the table's fields even when a declared prefix reaches them", async () => {
    core.data.record({ id: "a-agent-output", at: 20, type: "agent.output", source: "pty", workspaceId: "A", text: "turn 0", data: { turn: 0, chars: 5, cut: false }, content: "token" });
    const d = await widget("A", ["agents"]);
    const out = (await d.query({ types: ["agent."] })).find((e) => e.id === "a-agent-output")!;
    expect(out.blob).toBeNull();
    expect(Object.keys(out.data).every((k) => (POLICY.widget.output as { fields: string[] }).fields.includes(k))).toBe(true);
    d.close();
  });

  it("keeps unreadable rows out even when a prefix reaches no class clampQuery knows", async () => {
    // A type cmd doesn't classify (a future kind): classOf calls it system, which widgets must declare.
    core.data.record({ id: "a-unclassified", at: 30, type: "zz.thing" as never, source: "cmd", workspaceId: "A", text: "zz", data: {} as never });
    const secret = ["a-transcript", "a-hook", "a-ai", "a-remote", "a-unclassified"];
    const w = await widget("A");
    for (const types of [["."], ["zz."], ["zz.thing"], ["zz.", "."]]) {
      const rows = await w.query({ types });
      expect(ids(rows).filter((id) => secret.includes(id)), JSON.stringify(types)).toEqual([]);
    }
    // Proof the rows were in reach of the store: declared, the same prefix returns it.
    const d = await widget("A", ["system"]);
    expect(ids(await d.query({ types: ["zz."] }))).toEqual(["a-unclassified"]);
    d.close();
    w.close();
  });

  it("clamps the query itself: workspace and limit from the policy, types to readable classes", () => {
    const q = widgetQuery({ widgetId: "w", workspaceId: "A", events: [] }, { workspaceId: "B", limit: 1e9 });
    expect(q.workspaceId).toBe("A");
    expect(q.limit).toBe(1000);
    expect(q.types).toContain("git.");
    expect(q.types).not.toContain("transcript.");
    expect(q.types).not.toContain("agent.");
    expect(clampQuery({ kind: "widget", workspaceId: "A", declared: [] }, { limit: -5 }, { fallback: 200, max: 1000 }).limit).toBe(1);
  });
});
