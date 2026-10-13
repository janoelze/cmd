// cmd's MCP server in the agents' configs (docs/54, phase 5; agents/mcp-config.ts): in and out of
// Claude Code's .claude.json, Codex's config.toml and Gemini CLI's settings.json, leaving the
// rest of each file byte for byte as it was; and following Agent integration in every home cmd
// knows, from the installed app only, never over another "cmd" server.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Core } from "../src/kernel/core.ts";
import { installMcp, mcpFile, mcpState, removeMcp } from "../src/agents/mcp-config.ts";
import { fakeFactory } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

const CMD = "/Users/x/Library/Application Support/cmd/bin/cmd";

const CLAUDE = JSON.stringify({ numStartups: 3, mcpServers: { github: { type: "http", url: "https://api.github.com/mcp" } }, projects: { "/a": { allowedTools: [] } } }, null, 2);
const GEMINI = JSON.stringify({ security: { auth: { selectedType: "oauth" } }, mcpServers: { fs: { command: "npx", args: ["fs-mcp"] } } }, null, 2) + "\n";
const CODEX = `model = "gpt-5"

[mcp_servers.docs]
command = "docs-mcp"
args = ["--stdio"]

[projects."/Users/x/src/a"]
trust_level = "trusted"
`;

const temp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-mcp-config-")));

describe("cmd's MCP server in an agent's config", () => {
  it("goes in beside the user's servers and comes out leaving the file as it was", () => {
    const dir = temp();
    try {
      for (const [agent, name, before] of [["claude", ".claude.json", CLAUDE], ["gemini", "settings.json", GEMINI], ["codex", "config.toml", CODEX]] as const) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, before);
        expect(mcpState(agent, file, CMD)).toBe("missing");
        installMcp(agent, file, CMD);
        expect(mcpState(agent, file, CMD), agent).toBe("registered");
        installMcp(agent, file, CMD); // twice: once
        const text = fs.readFileSync(file, "utf8");
        expect(text.split('"mcp"').length - 1, agent).toBe(1);
        removeMcp(agent, file);
        expect(fs.readFileSync(file, "utf8"), agent).toBe(before);
        expect(mcpState(agent, file, CMD)).toBe("missing");
      }
    } finally {
      rmTemp(dir);
    }
  });

  it("names the pane's variables where the agent filters the env, and waits long enough for an approval", () => {
    const dir = temp();
    try {
      const codex = path.join(dir, "config.toml");
      fs.writeFileSync(codex, CODEX);
      installMcp("codex", codex, CMD);
      expect(fs.readFileSync(codex, "utf8")).toContain(`[mcp_servers.cmd]\ncommand = "${CMD}"\nargs = ["mcp"]\nenv_vars = ["CMD_PANE_ID", "CMD_SOCKET", "CMD_PANE_TOKEN"]\ntool_timeout_sec = 900\n`);
      const gemini = path.join(dir, "settings.json");
      installMcp("gemini", gemini, CMD); // a file that wasn't there
      expect(JSON.parse(fs.readFileSync(gemini, "utf8")).mcpServers.cmd).toEqual({ command: CMD, args: ["mcp"], env: { CMD_PANE_ID: "$CMD_PANE_ID", CMD_SOCKET: "$CMD_SOCKET", CMD_PANE_TOKEN: "$CMD_PANE_TOKEN" }, timeout: 900_000 });
      const claude = path.join(dir, ".claude.json");
      fs.writeFileSync(claude, "{}");
      installMcp("claude", claude, CMD);
      expect(JSON.parse(fs.readFileSync(claude, "utf8")).mcpServers.cmd).toEqual({ type: "stdio", command: CMD, args: ["mcp"], env: {} });
      // Another "cmd" (another build's): seen as such.
      expect(mcpState("claude", claude, "/elsewhere/bin/cmd")).toBe("other");
      expect(mcpState("codex", codex, "/elsewhere/bin/cmd")).toBe("other");
      // Not JSON: left alone.
      fs.writeFileSync(claude, "{ oops");
      expect(() => installMcp("claude", claude, CMD)).toThrow(/isn't valid JSON/);
      expect(fs.readFileSync(claude, "utf8")).toBe("{ oops");
    } finally {
      rmTemp(dir);
    }
  });

  it("finds Claude's user config: the profile's own, ~/.claude.json for the default home", () => {
    const home = temp();
    try {
      fs.mkdirSync(path.join(home, ".claude"));
      expect(mcpFile({ agent: "claude", dir: path.join(home, ".claude") }, home)).toBe(path.join(home, ".claude.json"));
      expect(mcpFile({ agent: "claude", dir: path.join(home, ".claude-profiles/work") }, home)).toBe(path.join(home, ".claude-profiles/work/.claude.json"));
      expect(mcpFile({ agent: "codex", dir: path.join(home, ".codex") }, home)).toBe(path.join(home, ".codex/config.toml"));
      expect(mcpFile({ agent: "qwen", dir: path.join(home, ".qwen") }, home)).toBeNull();
    } finally {
      rmTemp(home);
    }
  });
});

describe("following Agent integration", () => {
  function makeHome(root: string) {
    const home = path.join(root, "home");
    const put = (rel: string, text: string) => (fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }), fs.writeFileSync(path.join(home, rel), text));
    fs.mkdirSync(path.join(home, ".claude-profiles/work/projects"), { recursive: true });
    put(".claude-profiles/work/.claude.json", CLAUDE);
    fs.mkdirSync(path.join(home, ".claude-profiles/mine/projects"), { recursive: true });
    put(".claude-profiles/mine/.claude.json", JSON.stringify({ mcpServers: { cmd: { command: "my-own-cmd" } } }, null, 2));
    fs.mkdirSync(path.join(home, ".codex/sessions"), { recursive: true });
    put(".codex/config.toml", CODEX);
    put(".gemini/settings.json", GEMINI);
    fs.mkdirSync(path.join(home, ".gemini/tmp"));
    return home;
  }

  async function start(root: string, autoHooks: boolean) {
    const home = makeHome(root);
    const core = new Core({ socketPath: path.join(root, "core.sock"), dbPath: path.join(root, "cmd.sqlite"), settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, statusRoot: path.join(root, "status"), stateDir: path.join(root, "state"), autoHooks, homesContext: () => ({ home, env: {} }) });
    core.start();
    await core.scheduler.idle();
    return { core, home };
  }

  const FILES = [".claude-profiles/work/.claude.json", ".codex/config.toml", ".gemini/settings.json"];

  it("adds cmd's server to every home on, takes it out off, and leaves the user's servers as they were", async () => {
    const root = temp();
    const { core, home } = await start(root, true);
    try {
      const before = Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(path.join(home, f), "utf8")]));
      const mine = fs.readFileSync(path.join(home, ".claude-profiles/mine/.claude.json"), "utf8");
      // Off by default: nothing added.
      for (const f of FILES) expect(fs.readFileSync(path.join(home, f), "utf8")).toBe(before[f]);
      await core.call("settings.set", { key: "agents.integration", value: true });
      for (const f of FILES) expect(fs.readFileSync(path.join(home, f), "utf8"), f).toMatch(/"?mcp"?/);
      const status = await core.call("hooks.status", {});
      const byHome = Object.fromEntries(status.map((t) => [path.relative(home, path.dirname(t.file)), t.mcp]));
      expect(byHome).toEqual({ ".claude-profiles/work": "registered", ".claude-profiles/mine": "other", ".codex": "registered", ".gemini": "registered" });
      // The user's own "cmd" server stays theirs.
      expect(fs.readFileSync(path.join(home, ".claude-profiles/mine/.claude.json"), "utf8")).toBe(mine);
      expect(core.agentSetup.serves("codex")).toBe(true);
      expect(core.agentSetup.serves("claude")).toBe(false); // not in every Claude home
      await core.call("settings.set", { key: "agents.integration", value: false });
      for (const f of FILES) expect(fs.readFileSync(path.join(home, f), "utf8"), f).toBe(before[f]);
      expect(fs.readFileSync(path.join(home, ".claude-profiles/mine/.claude.json"), "utf8")).toBe(mine);
      // The hooks stay: activity is captured either way.
      expect((await core.call("hooks.status", {})).filter((t) => t.state === "installed").length).toBeGreaterThan(0);
    } finally {
      await core.close();
      rmTemp(root);
    }
  });

  it("a development build changes nothing by itself; Install and Remove take the server along", async () => {
    const root = temp();
    const { core, home } = await start(root, false);
    try {
      const codex = path.join(home, ".codex/config.toml");
      await core.call("settings.set", { key: "agents.integration", value: true });
      expect(fs.readFileSync(codex, "utf8")).toBe(CODEX);
      const target = (await core.call("hooks.status", {})).find((t) => t.agent === "codex")!;
      await core.call("hooks.install", { file: target.file });
      expect((await core.call("hooks.status", {})).find((t) => t.agent === "codex")).toMatchObject({ state: "installed", mcp: "registered" });
      await core.call("hooks.remove", { file: target.file });
      expect(fs.readFileSync(codex, "utf8")).toBe(CODEX);
    } finally {
      await core.close();
      rmTemp(root);
    }
  });
});
