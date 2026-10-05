import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Connection } from "@cmd/protocol/node";
import { Core } from "../src/core.ts";
import { hookFiles, hookState, hookTargets, installHooks, removeHooks } from "../src/agents/hooks.ts";
import { readStatus, statusRoot } from "../src/agents/statusfiles.ts";
import { drainSpool } from "../src/agents/activity/spool.ts";
import { AgentHomes } from "../src/agents/homes.ts";
import { fakeFactory, type FakePty } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-hooks-")));
const files = hookFiles(path.join(dir, "state"));
const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

/** Runs the hook script as an agent would. */
function hook(kind: string, payload: object, env: Record<string, string> = {}) {
  const r = spawnSync(files.script, [kind], { input: JSON.stringify(payload), env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ...env }, encoding: "utf8" });
  return { code: r.status, out: r.stdout };
}

/** The same without blocking: for when the core under test has to answer. */
function hookAsync(kind: string, payload: object, env: Record<string, string>): Promise<string> {
  const p = spawn(files.script, [kind], { env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ...env } });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stdin.end(JSON.stringify(payload));
  return new Promise((resolve) => p.on("close", () => resolve(out)));
}

describe.skipIf(process.platform === "win32")("cmd's agent hook", () => {
  let core: Core;
  let conn: Connection;
  let ptys: FakePty[];
  const socketPath = path.join(dir, "core.sock");

  beforeAll(async () => {
    const fake = fakeFactory();
    ptys = fake.ptys;
    core = new Core({ socketPath, dbPath: null, terminals: fake.factory, pollMs: 0, statusRoot: path.join(dir, "status"), stateDir: path.join(dir, "state") });
    await core.listen();
    conn = await connect(socketPath);
  });

  afterAll(async () => {
    // The script writes where the agent's real hook would ($TMPDIR, not the core's statusRoot).
    for (const p of core?.panes.list() ?? []) fs.rmSync(path.join(statusRoot(), p.id), { recursive: true, force: true });
    conn?.close();
    await core?.close();
    rmTemp(dir);
  });

  it("is written at startup, with a cmd CLI for panes", () => {
    expect(fs.statSync(files.script).mode & 0o111).toBeTruthy();
    expect(execFileSync(path.join(files.bin!, "cmd"), ["help"], { encoding: "utf8" })).toContain("cmd —");
    // …first on PATH in shells.
    core.panes.create();
    expect(ptys.at(-1)!.opts.env.PATH?.split(path.delimiter)[0]).toBe(files.bin);
  });

  it("stores events as status files and spools every one, silently", () => {
    const id = randomUUID();
    const env = { CMD_PANE_ID: id, CLAUDE_CONFIG_DIR: '/Users/x/my "profile"' };
    try {
      expect(hook("claude", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, env)).toEqual({ code: 0, out: "" });
      expect(readStatus(id, 0, statusRoot())).toMatchObject({ state: "working", agent: "claude" });
      expect(hook("gemini", { hook_event_name: "BeforeAgent", prompt: "hi" }, env)).toEqual({ code: 0, out: "{}\n" });
      expect(hook("claude", { hook_event_name: "SessionEnd" }, env).code).toBe(0);
      const { events } = drainSpool(statusRoot(), id);
      expect(events.map((e) => e.name)).toEqual(["PreToolUse", "BeforeAgent", "SessionEnd"]);
      expect(events[0]).toMatchObject({ agent: "claude", env: { CLAUDE_CONFIG_DIR: '/Users/x/my "profile"' }, payload: { tool_name: "Bash" } });
      expect(fs.readdirSync(path.join(statusRoot(), id, "log"))).toEqual([]);
      // Outside cmd: nothing.
      expect(hook("claude", { hook_event_name: "Stop" })).toEqual({ code: 0, out: "" });
    } finally {
      fs.rmSync(path.join(statusRoot(), id), { recursive: true, force: true });
    }
  });

  it("asks the core for a peer briefing while agents.peers is on", async () => {
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    const [a, b] = [core.panes.create(), core.panes.create()];
    const start = (paneId: string) => hookAsync("claude", { hook_event_name: "SessionStart", cwd: repo }, { CMD_PANE_ID: paneId, CMD_SOCKET: socketPath });

    expect(await start(a.id)).toBe(""); // off: no flag, no core round trip
    await conn.client.call("settings.set", { key: "agents.peers", value: true });
    expect(fs.existsSync(files.flag)).toBe(true);
    await conn.client.call("hook.ingest", { paneId: a.id, agent: "claude", event: "SessionStart", payload: { cwd: repo } });
    const out = JSON.parse(await start(b.id));
    const peer = core.agents.list().find((x) => x.paneId === a.id)!;
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "SessionStart" });
    expect(out.hookSpecificOutput.additionalContext).toContain(`id ${peer.id.slice(0, 8)}`);

    await conn.client.call("settings.set", { key: "agents.peers", value: false });
    expect(fs.existsSync(files.flag)).toBe(false);
  });
});

describe("installing into agent configs", () => {
  const script = "/Users/me/Library/Application Support/cmd/hooks/cmd-hook";
  const ours = `'${script}' claude`;
  const commands = (cfg: { hooks?: Record<string, { hooks: { command: string }[] }[]> }) =>
    Object.fromEntries(Object.entries(cfg.hooks ?? {}).map(([e, gs]) => [e, gs.flatMap((g) => g.hooks.map((h) => h.command))]));

  it("replaces the old hooks, keeps everything else, and removes cleanly", () => {
    const file = path.join(dir, "claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        model: "opus",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "/Users/me/.claude/hooks/ghostty-agents-status.sh" }, { type: "command", command: "say done" }] }],
          PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "/src/cmd/packages/cli/bin/cmd hook claude" }] }],
        },
      }),
    );
    expect(hookState("claude", file, script)).toBe("legacy");

    installHooks("claude", file, script);
    const cfg = read(file);
    expect(cfg.model).toBe("opus");
    expect(commands(cfg).Stop).toEqual(["say done", ours]);
    expect(commands(cfg).PreToolUse).toEqual([ours]);
    expect(cfg.hooks.PreToolUse.at(-1)).toMatchObject({ matcher: "*", hooks: [{ type: "command", timeout: 10 }] });
    expect(Object.keys(cfg.hooks)).toContain("SessionStart");
    expect(hookState("claude", file, script)).toBe("installed");
    expect(hookState("claude", file, "/elsewhere/hooks/cmd-hook")).toBe("elsewhere");

    installHooks("claude", file, script); // again: no duplicates
    expect(commands(read(file)).Stop).toEqual(["say done", ours]);

    removeHooks(file);
    expect(read(file)).toEqual({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } });
    expect(hookState("claude", file, script)).toBe("missing");
  });

  it("writes Gemini's event names and units, and through a symlink", () => {
    const real = path.join(dir, "dotfiles", "gemini.json");
    const link = path.join(dir, "gemini", "settings.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(real, "{}");
    fs.symlinkSync(real, link);
    installHooks("gemini", link, script);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    const cfg = read(real);
    expect(Object.keys(cfg.hooks)).toEqual(expect.arrayContaining(["BeforeAgent", "AfterAgent", "BeforeTool"]));
    expect(cfg.hooks.BeforeTool[0]).toMatchObject({ matcher: "*", hooks: [{ name: "cmd", timeout: 10_000, command: `'${script}' gemini` }] });
  });

  it("leaves a file it can't parse alone", () => {
    const file = path.join(dir, "broken.json");
    fs.writeFileSync(file, "{ not json");
    expect(() => installHooks("claude", file, script)).toThrow(/isn't valid JSON/);
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("finds the configs of the agents installed here, one per Claude profile", () => {
    const home = path.join(dir, "home");
    for (const d of [".claude", ".claude-profiles/work/projects", ".codex", ".gemini"]) fs.mkdirSync(path.join(home, d), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude-profiles/work/.claude.json"), "{}");
    const homes = new AgentHomes(null, () => ({ home, env: {} }));
    homes.discover();
    const targets = hookTargets(homes.all());
    expect(targets.map((t) => [t.agent, path.relative(home, t.file)])).toEqual([
      ["claude", ".claude/settings.json"],
      ["claude", ".claude-profiles/work/settings.json"],
      ["codex", ".codex/hooks.json"],
      ["gemini", ".gemini/settings.json"],
    ]);
  });
});

it("reads Gemini's events as the ones Claude and Codex share", () => {
  const id = randomUUID();
  const d = path.join(dir, "gem", id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "BeforeTool.json"), JSON.stringify({ agent: "gemini", ts: 1, event: { hook_event_name: "BeforeTool", tool_name: "run_shell_command" } }));
  expect(readStatus(id, 0, path.join(dir, "gem"))).toMatchObject({ state: "working", agent: "gemini" });
});
