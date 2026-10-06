// cmd's agent hooks. At startup the core writes a hook script and a `cmd` CLI
// wrapper into its state dir, pointing into this build; installing puts the hook
// into a coding agent's config (Settings → Agents → Hooks, `cmd hooks install`),
// replacing older `cmd hook` entries.
//
// The config's command carries the script's body itself (`sh -c '<body>'
// '<script>' <kind>`), behind a check for a cmd pane: outside cmd nothing runs,
// and a sandboxed agent (Agent Safehouse, sandbox-exec) that can't read our state
// dir still reports from inside cmd. The file stays as the hook's name and the
// sign that its cmd is still there (`stale` when it's gone).
//
// The script stores every event as a status file (statusfiles.ts) and links it
// into the pane's spool (activity/spool.ts), where none is overwritten: plain sh,
// fast enough for every tool call. It adds the agent's config dir from its
// environment ($CLAUDE_CONFIG_DIR, …), the one place that knows which profile a
// session runs in. Only SessionStart and prompts, and only while peer briefings
// are on (a flag file next to it), go through hook-main.ts to the core.

import fs from "node:fs";
import path from "node:path";
import { HOOK_FORMAT, type AgentHome, type AgentKind, type HookTarget } from "@cmd/protocol";
import { shq } from "../shell.ts";

export interface HookFiles {
  /** The hook script, `<script> <kind>`; agent configs carry its code and name it (hookCommand). */
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

/** The hook's shell code: `$1` is the agent, the payload on stdin. No comments: it is inlined into agent configs. */
function hookBody(script: string): string {
  const flag = path.join(path.dirname(script), "briefings");
  return `kind=$1
payload=$(cat)
id=$CMD_PANE_ID
quiet() { [ "$kind" = gemini ] && echo '{}'; exit 0; }
case "$id" in "" | *[!0-9A-Fa-f-]*) quiet ;; esac
case "$kind:$CLAUDE_CODE_ENTRYPOINT" in claude:sdk*) quiet ;; esac
base=$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null) || base="\${TMPDIR:-/tmp}/"
dir="\${base%/}/cmd-agents/$id"
event=$(printf '%s\\n' "$payload" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\\([A-Za-z]*\\)".*/\\1/p' | head -n 1)
[ -n "$event" ] || quiet
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
printf '{"v":${HOOK_FORMAT},"agent":"%s","ts":%s,"env":{%s},"event":%s}\\n' "$kind" "$ts" "$env" "$payload" >"$tmp" 2>/dev/null || quiet
ln "$tmp" "$dir/log/$ts.$$.$event.json" 2>/dev/null
mv -f "$tmp" "$dir/$event.json" 2>/dev/null
case "$event" in SessionStart | UserPromptSubmit | BeforeAgent)
  if [ -e ${shq(flag)} ] && [ -n "$CMD_SOCKET" ]; then
    printf '%s' "$payload" | ${node("packages/core/src/agents/hook-main.ts")} "$kind" "$event" "$id" spooled
    exit 0
  fi ;;
esac
quiet
`;
}

function hookScript(script: string): string {
  return `#!/bin/sh
# cmd's agent hook (written by cmd at startup: packages/core/src/agents/hooks.ts).
# Usage: cmd-hook <claude|codex|gemini>, the hook payload on stdin. Stores the
# event as $TMPDIR/cmd-agents/<pane id>/<event>.json (the latest of each) and
# links it into log/ (every one, until cmd has read it), with the agent's config
# dirs ($CLAUDE_CONFIG_DIR, …: which profile the session runs in). Asks the core
# for a peer briefing while the briefings flag is there. Never fails or blocks
# the agent; outside cmd it does nothing. Nor for a headless Claude (claude -p,
# the Agent SDK): it inherits the pane of whatever started it, often the pane's
# own agent, and its events would pass for that agent's. Agent configs carry
# this code inline.
${hookBody(script)}`;
}

/**
 * The command an agent config runs: the script's code, only in a cmd pane.
 * Gemini wants JSON on stdout either way.
 */
export function hookCommand(agent: AgentKind, script: string): string {
  const inCmd = `[ -z "$CMD_PANE_ID" ]`;
  const run = `exec /bin/sh -c ${shq(hookBody(script))} ${shq(script)} ${agent}`;
  return agent === "gemini" ? `${inCmd} && echo '{}' || ${run}` : `${inCmd} || ${run}`;
}

/** (Re)writes the hook script and the `cmd` wrapper for this build. */
export function writeHookFiles(f: HookFiles): void {
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}`;
    fs.writeFileSync(tmp, text, { mode: 0o755 });
    fs.renameSync(tmp, file);
  };
  write(f.script, hookScript(f.script));
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
/** `cmd hook <kind>` from `cmd hooks` before cmd installed its own. */
const legacy = (c: string) => /(^|\/)cmd\s+hook\s+\w+\s*$/.test(c);

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

/** The script a cmd hook command names, the quoted word before `<kind>`: `… sh -c '<body>' '<script>' <kind>`, or `'<script>' <kind>` before the code went inline. */
const scriptOf = (command: string): string | null => command.match(/'((?:[^']|'\\'')*)'\s+\w+\s*$/)?.[1]?.replaceAll("'\\''", "'") ?? command.match(/^(\S+)\s+\w+\s*$/)?.[1] ?? null;

export function hookState(agent: AgentKind, file: string, script: string): HookTarget["state"] {
  let cmds: string[];
  try {
    cmds = commands(read(file));
  } catch {
    return "missing";
  }
  if (cmds.includes(hookCommand(agent, script))) return "installed";
  // This cmd's, but older (another build, the script run as a file): replaced.
  if (cmds.some((c) => ours(c) && scriptOf(c) === script)) return "legacy";
  const others = cmds.filter(ours);
  if (others.length) return others.every((c) => !fs.existsSync(scriptOf(c) ?? "")) ? "stale" : "elsewhere";
  return cmds.some(legacy) ? "legacy" : "missing";
}

/** The first time cmd changes an agent's config, a copy of it as it was goes next to it. */
function backupOnce(target: string): void {
  const backup = `${target}.cmd-backup`;
  if (fs.existsSync(target) && !fs.existsSync(backup)) fs.copyFileSync(target, backup);
}

/** Drops cmd's hooks from `cfg`, keeping everything else. */
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
  const handler = { type: "command", command: hookCommand(agent, script), timeout: spec.timeout, ...(agent === "gemini" ? { name: "cmd" } : {}) };
  for (const e of spec.events) (hooks[e] ??= []).push({ ...(spec.tools.includes(e) ? { matcher: "*" } : {}), hooks: [handler] });
  write(file, cfg);
}

export function removeHooks(file: string): void {
  const cfg = read(file);
  strip(cfg);
  write(file, cfg);
}
