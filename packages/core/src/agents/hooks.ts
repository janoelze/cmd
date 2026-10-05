// cmd's agent hooks. At startup the core writes a hook script and a `cmd` CLI
// wrapper into its state dir, pointing into this build (so they survive updates
// and moving the app); installing puts the script into a coding agent's config
// (Settings → Agents → Hooks, `cmd hooks install`), replacing the ghostty-agents
// fork's hook and `cmd hook` entries.
//
// The script stores every event as a status file (statusfiles.ts) and links it
// into the pane's spool (activity/spool.ts), where none is overwritten: plain sh,
// fast enough for every tool call. It adds the agent's config dir from its
// environment ($CLAUDE_CONFIG_DIR, …), the one place that knows which profile a
// session runs in. Only SessionStart and prompts, and only while peer briefings
// are on (a flag file next to it), go through hook-main.ts to the core.

import fs from "node:fs";
import path from "node:path";
import type { AgentHome, AgentKind, HookTarget } from "@cmd/protocol";
import { shq } from "../shell.ts";

export interface HookFiles {
  /** The hook script agents run: `<script> <kind>`. */
  script: string;
  /** Present while peer briefings are on (agents.peers). */
  flag: string;
  /** Holds `cmd`, put on PATH in panes; null when this build has no CLI. */
  bin: string | null;
}

/** The repo (or packaged runtime) this core runs from. */
const ROOT = path.resolve(import.meta.dirname, "../../../..");

export function hookFiles(stateDir: string): HookFiles {
  const dir = path.join(stateDir, "hooks");
  const cli = fs.existsSync(path.join(ROOT, "packages/cli/src/main.ts"));
  return { script: path.join(dir, "cmd-hook"), flag: path.join(dir, "briefings"), bin: cli ? path.join(stateDir, "bin") : null };
}

/** A command running `entry` with this core's Node; ELECTRON_RUN_AS_NODE lets the packaged app's Electron be it. */
const node = (entry: string, exec = "") => `ELECTRON_RUN_AS_NODE=1 ${exec}${shq(process.execPath)} --no-warnings ${shq(path.join(ROOT, entry))}`;

function hookScript(f: HookFiles): string {
  return `#!/bin/sh
# cmd's agent hook (written by cmd at startup: packages/core/src/agents/hooks.ts).
# Usage: cmd-hook <claude|codex|gemini>, the hook payload on stdin. Stores the
# event as $TMPDIR/cmd-agents/<pane id>/<event>.json (the latest of each) and
# links it into log/ (every one, until cmd has read it). Never fails or blocks
# the agent; outside cmd it does nothing.

kind=$1
payload=$(cat)
id=\${CMD_PANE_ID:-$GHOSTTY_AGENTS_SURFACE_ID}
quiet() { [ "$kind" = gemini ] && echo '{}'; exit 0; }
case "$id" in "" | *[!0-9A-Fa-f-]*) quiet ;; esac

base=$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null) || base="\${TMPDIR:-/tmp}/"
dir="\${base%/}/cmd-agents/$id"
event=$(printf '%s\\n' "$payload" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\\([A-Za-z]*\\)".*/\\1/p' | head -n 1)
[ -n "$event" ] || quiet

# The agent's config dirs, when set: they say which profile the session runs in.
env=
addenv() {
  [ -n "$2" ] || return 0
  v=$2
  case "$v" in *[\\\\\\"]*) v=$(printf '%s' "$v" | sed -e 's/[\\\\"]/\\\\&/g') ;; esac
  env="$env\${env:+,}\\"$1\\":\\"$v\\""
}
addenv CLAUDE_CONFIG_DIR "$CLAUDE_CONFIG_DIR"
addenv CODEX_HOME "$CODEX_HOME"
addenv GEMINI_CLI_HOME "$GEMINI_CLI_HOME"

mkdir -p "$dir/log" 2>/dev/null || quiet
ts=$(date +%s)
tmp="$dir/.$event.$$"
printf '{"agent":"%s","ts":%s,"env":{%s},"event":%s}\\n' "$kind" "$ts" "$env" "$payload" >"$tmp" 2>/dev/null || quiet
ln "$tmp" "$dir/log/$ts.$$.$event.json" 2>/dev/null
mv -f "$tmp" "$dir/$event.json" 2>/dev/null

# Peer briefings: the core says who else works in this repository.
case "$event" in SessionStart | UserPromptSubmit | BeforeAgent)
  if [ -e ${shq(f.flag)} ] && [ -n "$CMD_SOCKET" ]; then
    printf '%s' "$payload" | ${node("packages/core/src/agents/hook-main.ts")} "$kind" "$event" "$id" spooled
    exit 0
  fi ;;
esac
quiet
`;
}

/** (Re)writes the hook script and the `cmd` wrapper for this build. */
export function writeHookFiles(f: HookFiles): void {
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}`;
    fs.writeFileSync(tmp, text, { mode: 0o755 });
    fs.renameSync(tmp, file);
  };
  write(f.script, hookScript(f));
  if (f.bin) write(path.join(f.bin, "cmd"), `#!/bin/sh\n# cmd's CLI from the build of the core that wrote this (hooks.ts).\n${node("packages/cli/src/main.ts", "exec ")} "$@"\n`);
}

/** Peer briefings on or off: the script checks for the flag file. */
export function setBriefingFlag(f: HookFiles, on: boolean): void {
  if (on) fs.writeFileSync(f.flag, "");
  else fs.rmSync(f.flag, { force: true });
}

// ── agent configs ──────────────────────────────────────────

interface Spec {
  title: string;
  events: string[];
  /** Tool events take a matcher; "*" is every tool. */
  tools: string[];
  /** In the agent's unit: seconds, milliseconds for Gemini. */
  timeout: number;
}

const SPECS: Record<string, Spec> = {
  claude: {
    title: "Claude Code",
    events: ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "PreCompact"],
    tools: ["PreToolUse", "PostToolUse"],
    timeout: 10,
  },
  codex: {
    title: "Codex",
    events: ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SubagentStart", "SubagentStop", "PreCompact"],
    tools: ["PreToolUse", "PostToolUse"],
    timeout: 10,
  },
  gemini: {
    title: "Gemini CLI",
    events: ["SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool", "Notification", "PreCompress"],
    tools: ["BeforeTool", "AfterTool"],
    timeout: 10_000,
  },
};

/** The config file of every agent home cmd knows (homes.ts) whose agent takes hooks. */
export function hookTargets(homes: AgentHome[]): { agent: AgentKind; title: string; file: string }[] {
  return homes.filter((h) => SPECS[h.agent]).map((h) => ({ agent: h.agent, title: SPECS[h.agent]!.title, file: path.join(h.dir, h.agent === "codex" ? "hooks.json" : "settings.json") }));
}

type Handler = { command?: unknown };
type Group = { hooks?: Handler[] };
type Config = { hooks?: Record<string, Group[]> };

const ours = (c: string) => /\/hooks\/cmd-hook\b/.test(c);
/** The fork's hook, and `cmd hook <kind>` from `cmd hooks` before cmd installed its own. */
const legacy = (c: string) => c.includes("ghostty-agents-status.sh") || /(^|\/)cmd\s+hook\s+\w+\s*$/.test(c);

function read(file: string): Config {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    const cfg = JSON.parse(text || "{}");
    if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) return cfg;
  } catch {}
  throw new Error(`${file} isn't valid JSON; not touching it`);
}

const commands = (cfg: Config) =>
  Object.values(cfg.hooks ?? {}).flatMap((groups) => (Array.isArray(groups) ? groups : []).flatMap((g) => (g?.hooks ?? []).map((h) => String(h?.command ?? ""))));

/** The script a cmd hook command runs (`'<script>' <kind>`). */
const scriptOf = (command: string): string | null => command.match(/^'((?:[^']|'\\'')*)'\s+\w+\s*$/)?.[1]?.replaceAll("'\\''", "'") ?? command.match(/^(\S+)\s+\w+\s*$/)?.[1] ?? null;

export function hookState(agent: AgentKind, file: string, script: string): HookTarget["state"] {
  let cmds: string[];
  try {
    cmds = commands(read(file));
  } catch {
    return "missing";
  }
  if (cmds.includes(`${shq(script)} ${agent}`)) return "installed";
  const others = cmds.filter(ours);
  if (others.length) return others.every((c) => !fs.existsSync(scriptOf(c) ?? "")) ? "stale" : "elsewhere";
  return cmds.some(legacy) ? "legacy" : "missing";
}

/** The first time cmd changes an agent's config, a copy of it as it was goes next to it. */
function backupOnce(target: string): void {
  const backup = `${target}.cmd-backup`;
  if (fs.existsSync(target) && !fs.existsSync(backup)) fs.copyFileSync(target, backup);
}

/** Drops cmd's and the fork's hooks from `cfg`, keeping everything else. */
function strip(cfg: Config): void {
  if (!cfg.hooks || typeof cfg.hooks !== "object") return;
  for (const [event, groups] of Object.entries(cfg.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !ours(String(h?.command ?? "")) && !legacy(String(h?.command ?? ""))) } : g))
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (kept.length) cfg.hooks[event] = kept;
    else delete cfg.hooks[event];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
}

/** Writes through a symlink (dotfile repos) instead of replacing it. */
function write(file: string, cfg: Config): void {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true });
  backupOnce(target);
  const tmp = `${target}.cmd-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  fs.renameSync(tmp, target);
}

export function installHooks(agent: AgentKind, file: string, script: string): void {
  const spec = SPECS[agent];
  if (!spec) throw new Error(`no hooks for ${agent}`);
  const cfg = read(file);
  strip(cfg);
  const hooks = (cfg.hooks ??= {});
  const handler = { type: "command", command: `${shq(script)} ${agent}`, timeout: spec.timeout, ...(agent === "gemini" ? { name: "cmd" } : {}) };
  for (const e of spec.events) (hooks[e] ??= []).push({ ...(spec.tools.includes(e) ? { matcher: "*" } : {}), hooks: [handler] });
  write(file, cfg);
}

export function removeHooks(file: string): void {
  const cfg = read(file);
  strip(cfg);
  write(file, cfg);
}
