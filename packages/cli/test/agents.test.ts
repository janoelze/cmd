// `cmd agents events|turns|record` against a real core: they read the log
// (data.query) and the turns view (data.view), and find agents that are gone by
// id prefix among the log's entities.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connect, type Connection } from "@cmd/protocol/node";
import { Core } from "../../core/src/core.ts";
import { fakeFactory } from "../../core/test/fake-pty.ts";
import { agentsCommand } from "../src/agents.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-cli-agents-"));
const socketPath = path.join(dir, "core.sock");
const AGENT = "0d3f5a9c-1111-4222-8333-944455556666";
let core: Core;
let conn: Connection;

/** What `cmd agents …` prints. */
async function run(...pos: string[]): Promise<string[]> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((s: string) => void lines.push(s));
  try {
    await agentsCommand(conn.client, new Promise(() => {}), pos, {});
  } finally {
    log.mockRestore();
  }
  return lines;
}

beforeAll(async () => {
  core = new Core({ socketPath, dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0 });
  await core.listen();
  conn = await connect(socketPath);
  const hook = (n: number, name: string, payload: Record<string, unknown>) =>
    core.data.record({ id: `hook:${n}`, at: 1_000 + n, type: "agent.hook", source: "hook", agentId: AGENT, data: { name, agent: "claude", payload: { hook_event_name: name, session_id: "s1", ...payload } } });
  hook(1, "UserPromptSubmit", { prompt: "fix the tests" });
  hook(2, "Stop", {});
  core.agents.activity.saveTurn({ format: 2, derivedBy: null, agentId: AGENT, agentKind: "claude", agentVersion: null, model: null, index: 0, sessionId: "s1", turnId: null, startedAt: 1_001, endedAt: 1_002, prompt: "fix the tests", auto: false, followUps: [], notes: [], background: [], outcome: "done", ask: null, final: null, error: null, tools: [], commands: [], shellWrites: 0, files: [], subagents: 0, events: 2, inferred: [] }, 2, "/w");
});
afterAll(async () => {
  conn.close();
  await core.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("cmd agents", () => {
  it("lists a gone agent's events by id prefix, oldest first", async () => {
    const lines = await run("events", AGENT.slice(0, 6));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/prompt .*fix the tests/);
    expect(lines[1]).toMatch(/stop/);
  });

  it("lists its turns from the turns view", async () => {
    expect((await run("turns", AGENT.slice(0, 6)))[0]).toMatch(/^#0 .* done .*fix the tests/);
  });

  it("says so for an id nothing has", async () => {
    await expect(run("events", "ffffffff")).rejects.toThrow("no agent or terminal: ffffffff");
  });
});
