// cmd's MCP server (`cmd mcp`, docs/54) in the agents' own configs, user scope, one entry named
// "cmd" per agent home, while Agent integration is on: Claude Code's .claude.json (the home's, or
// ~/.claude.json for the default home), Codex's config.toml and Gemini CLI's settings.json. The
// entry names no build: it runs the pane's own instance's `cmd` ($CMD_CLI, set in every pane), so
// one entry serves the installed app and every development build, and a dev build's panes reach
// its own code; outside cmd it falls back to the installed app's `cmd` (which lists no tools
// there). Each gets the pane's variables where the agent filters the env: Codex passes a short list plus what `env_vars` names, Gemini drops
// names that look like secrets unless the entry sets them. Only cmd's entry is touched; the
// rest of the file stays as it was (JSON files keep their two-space form and their last newline,
// the TOML table is cut out as it went in).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentHome, AgentKind } from "@cmd/protocol";

/** What MCP server entry cmd's is in a config: this cmd's, none, or another "cmd" (another build's, or the user's own). */
export type McpState = "registered" | "missing" | "other";

/** The server's name in configs: tools show as mcp__cmd__open… */
export const SERVER = "cmd";
/** The pane's variables the server needs (identity, the core, the proof). */
const PANE_ENV = ["CMD_PANE_ID", "CMD_SOCKET", "CMD_PANE_TOKEN", "CMD_CLI"];
/** A call can wait for the person's approval in cmd (tools/runner.ts waits 15 min). */
const TIMEOUT_S = 900;

/** The file an agent home's user-scope MCP servers live in; null for agents cmd doesn't register with. */
export function mcpFile(h: Pick<AgentHome, "agent" | "dir">, home = os.homedir()): string | null {
  if (h.agent === "claude") {
    const own = path.join(h.dir, ".claude.json");
    return fs.existsSync(own) || h.dir !== path.join(home, ".claude") ? own : path.join(home, ".claude.json");
  }
  if (h.agent === "codex") return path.join(h.dir, "config.toml");
  if (h.agent === "gemini") return path.join(h.dir, "settings.json");
  return null;
}

/** The command and its arguments: the pane's instance's `cmd mcp`, else `fallback` (the installed app's `cmd`). */
function command(fallback: string): [string, string[]] {
  if (/["$`\\]/.test(fallback)) throw new Error(`can't name ${fallback} in a shell command`);
  return ["/bin/sh", ["-c", `exec "\${CMD_CLI:-${fallback}}" mcp`]];
}

/** The entry for a JSON config: Claude's and Gemini's. */
function jsonEntry(agent: AgentKind, fallback: string): Record<string, unknown> {
  const [cmd, args] = command(fallback);
  if (agent === "gemini") return { command: cmd, args, env: Object.fromEntries(PANE_ENV.map((k) => [k, `$${k}`])), timeout: TIMEOUT_S * 1000 };
  return { type: "stdio", command: cmd, args, env: {} };
}

// ── JSON (Claude, Gemini) ────────────────────────────────

interface JsonFile {
  cfg: Record<string, unknown>;
  /** The file ended with a newline (Claude writes none, Gemini one). */
  newline: boolean;
}

function readJson(file: string): JsonFile {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { cfg: {}, newline: true };
  }
  try {
    const cfg = JSON.parse(text || "{}");
    if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) return { cfg, newline: text.endsWith("\n") };
  } catch {}
  throw new Error(`${file} isn't valid JSON; not touching it`);
}

const servers = (cfg: Record<string, unknown>) => (cfg.mcpServers && typeof cfg.mcpServers === "object" ? (cfg.mcpServers as Record<string, Record<string, unknown>>) : null);

// ── TOML (Codex) ─────────────────────────────────────────

const HEADER = /^\[mcp_servers\.(?:cmd|"cmd")\]\s*$/;
const NOTE = "# cmd's tools (docs/54 in cmd): written by cmd while Agent integration is on.";

/** The lines of the [mcp_servers.cmd] table, with cmd's note above it and the blank line cmd put before that: [start, end). */
function tomlBlock(lines: string[]): [number, number] | null {
  let start = lines.findIndex((l) => HEADER.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  // What follows the table up to the next one belongs to it only while it is key = value lines.
  while (end > start + 1 && lines[end - 1]!.trim() === "") end--;
  if (lines[start - 1] === NOTE) start--;
  if (start > 0 && lines[start - 1] === "") start--;
  return [start, end];
}

const tomlString = (s: string) => JSON.stringify(s);

function tomlEntry(fallback: string): string[] {
  const [cmd, args] = command(fallback);
  return ["", NOTE, "[mcp_servers.cmd]", `command = ${tomlString(cmd)}`, `args = [${args.map(tomlString).join(", ")}]`, `env_vars = [${PANE_ENV.map(tomlString).join(", ")}]`, `tool_timeout_sec = ${TIMEOUT_S}`];
}

const readText = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

// ── the adapter ──────────────────────────────────────────

/** Whether cmd's server is in `file` for `agent`, as cmd writes it (`fallback`: the installed app's `cmd`). */
export function mcpState(agent: AgentKind, file: string, cmd: string): McpState {
  if (agent === "codex") {
    const lines = readText(file).split("\n");
    const b = tomlBlock(lines);
    if (!b) return "missing";
    const body = lines.slice(b[0], b[1]).filter((l) => l.trim() && l !== NOTE);
    return body.join("\n") === tomlEntry(cmd).filter((l) => l && l !== NOTE).join("\n") ? "registered" : "other";
  }
  let entry: Record<string, unknown> | undefined;
  try {
    entry = servers(readJson(file).cfg)?.[SERVER];
  } catch {
    return "missing";
  }
  if (!entry) return "missing";
  return JSON.stringify(entry) === JSON.stringify(jsonEntry(agent, cmd)) ? "registered" : "other";
}

/** Writes through a symlink (dotfile repos), atomically. */
function writeFile(file: string, text: string): void {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.cmd-${process.pid}`;
  const mode = (() => {
    try {
      return fs.statSync(target).mode & 0o777;
    } catch {
      return 0o600;
    }
  })();
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, target);
}

/** Puts cmd's server into `file` (replacing another "cmd" entry), keeping everything else. */
export function installMcp(agent: AgentKind, file: string, cmd: string): void {
  if (mcpState(agent, file, cmd) === "registered") return;
  if (agent === "codex") {
    const text = readText(file);
    const lines = text.split("\n");
    const b = tomlBlock(lines);
    if (b) lines.splice(b[0], b[1] - b[0]);
    // The entry goes at the end, after a newline the file may lack.
    const body = lines.join("\n");
    const head = body === "" ? [] : body.endsWith("\n") ? [body.slice(0, -1)] : [body];
    writeFile(file, [...head, ...tomlEntry(cmd).slice(head.length ? 0 : 1)].join("\n") + "\n");
    return;
  }
  const { cfg, newline } = readJson(file);
  const all = (servers(cfg) ?? {}) as Record<string, unknown>;
  cfg.mcpServers = { ...all, [SERVER]: jsonEntry(agent, cmd) };
  writeFile(file, JSON.stringify(cfg, null, 2) + (newline ? "\n" : ""));
}

/** Takes cmd's server out of `file`; nothing else changes (an mcpServers cmd made alone goes too). */
export function removeMcp(agent: AgentKind, file: string): void {
  if (!fs.existsSync(file)) return;
  if (agent === "codex") {
    const text = readText(file);
    const lines = text.split("\n");
    const b = tomlBlock(lines);
    if (!b) return;
    lines.splice(b[0], b[1] - b[0]);
    writeFile(file, lines.join("\n"));
    return;
  }
  const { cfg, newline } = readJson(file);
  const all = servers(cfg);
  if (!all || !(SERVER in all)) return;
  delete all[SERVER];
  if (!Object.keys(all).length) delete cfg.mcpServers;
  writeFile(file, JSON.stringify(cfg, null, 2) + (newline ? "\n" : ""));
}
