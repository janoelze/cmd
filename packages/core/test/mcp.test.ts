// `cmd mcp`, `cmd tools` and `cmd tool` (docs/54, The surfaces) as an agent runs them: the real
// CLI in a child process against a core on a socket. The MCP handshake, the tool list equal to
// the core's registry (with hints from the access table), a call as the pane's agent, and no
// tools outside cmd or with Agent integration off.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pane, Workspace } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { AGENT_TOOLS, INSTRUCTIONS } from "../src/tools/runner.ts";
import { fakeFactory, type FakePty } from "./fake-pty.ts";

const MAIN = path.join(import.meta.dirname, "../../cli/src/main.ts");
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-cli-mcp-")));
const socketPath = path.join(dir, "core.sock");
let core: Core;
let ptys: FakePty[];
let pane: Pane;
let env: Record<string, string>;

beforeAll(async () => {
  const f = fakeFactory();
  ptys = f.ptys;
  core = new Core({ socketPath, dbPath: null, settingsPath: null, terminals: f.factory, pollMs: 0 });
  await core.listen();
  await core.call("settings.set", { key: "agents.integration", value: true });
  const ws = (core.handlers["workspace.open"]({ path: dir }) as { workspace: Workspace }).workspace;
  const w = await core.call("window.open", { kind: "terminal", input: { cwd: dir }, workspaceId: ws.id });
  pane = core.panes.get(w!.id)!;
  env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CMD_SOCKET: socketPath, CMD_PANE_ID: pane.id, CMD_PANE_TOKEN: ptys.at(-1)!.opts.env.CMD_PANE_TOKEN! };
});
afterAll(async () => {
  await core.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A `cmd mcp` session: send requests, get the answers by id. */
function server(e: Record<string, string>) {
  const p = spawn(process.execPath, ["--no-warnings", MAIN, "mcp"], { env: e, stdio: ["pipe", "pipe", "inherit"] });
  const answers = new Map<number, (r: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
  let buf = "";
  p.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      answers.get(m.id)?.(m);
    }
  });
  let id = 0;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>((resolve) => {
      answers.set(++id, resolve);
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method: string) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  const end = () => new Promise<number | null>((resolve) => (p.on("exit", resolve), p.stdin.end()));
  return { request, notify, end };
}

/** `cmd …` in a child (never spawnSync: the core answering it runs in this process). */
const cli = (args: string[], e: Record<string, string>) =>
  new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ["--no-warnings", MAIN, ...args], { env: e, encoding: "utf8" }, (err, stdout, stderr) => resolve({ status: err ? Number(err.code ?? 1) : 0, stdout, stderr }));
  });

describe("cmd mcp", () => {
  it("serves the core's tools to the pane's agent: handshake, list, call", async () => {
    const s = server(env);
    const init = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "cmd" }, capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    s.notify("notifications/initialized");
    const list = (await s.request("tools/list")).result!.tools as { name: string; annotations: Record<string, boolean> }[];
    expect(list.map((t) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.spec.name));
    expect(list.find((t) => t.name === "look")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(list.find((t) => t.name === "type")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const look = (await s.request("tools/call", { name: "look", arguments: { why: "seeing the board" } })).result!;
    expect(look).toMatchObject({ isError: false, content: [{ type: "text", text: expect.stringMatching(/w1 terminal \(you\)/) }] });
    expect((await s.request("ping")).result).toEqual({});
    expect((await s.request("resources/list")).error!.message).toContain("no method");
    expect(await s.end()).toBe(0);
  });

  it("lists no tools outside a cmd pane, or with Agent integration off", async () => {
    const outside = server({ PATH: env.PATH!, HOME: env.HOME!, CMD_SOCKET: socketPath });
    expect((await outside.request("initialize", { protocolVersion: "2025-11-25" })).result).not.toHaveProperty("instructions");
    expect((await outside.request("tools/list")).result!.tools).toEqual([]);
    await outside.end();
    const nocore = server({ PATH: env.PATH!, HOME: env.HOME!, CMD_SOCKET: path.join(dir, "nothing.sock") });
    expect((await nocore.request("tools/list")).result!.tools).toEqual([]);
    expect((await nocore.request("tools/call", { name: "look", arguments: {} })).result).toMatchObject({ isError: true });
    await nocore.end();
    await core.call("settings.set", { key: "agents.integration", value: false });
    try {
      const off = server(env);
      expect((await off.request("tools/list")).result!.tools).toEqual([]);
      await off.end();
    } finally {
      await core.call("settings.set", { key: "agents.integration", value: true });
    }
  });
});

describe("cmd tools and cmd tool", () => {
  it("list the same tools as MCP and run one as the pane's agent", async () => {
    const listed = JSON.parse((await cli(["tools", "--json"], env)).stdout) as { name: string }[];
    expect(listed.map((t) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.spec.name));
    const r = await cli(["tool", "look", "{}"], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/w1 terminal \(you\)/);
    const bad = await cli(["tool", "nope"], env);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("No tool nope");
  });
});
