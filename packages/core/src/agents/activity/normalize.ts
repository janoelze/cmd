// Raw hook payload → ActivityEvent. What is agent-specific lives in tables here
// (event names, tool names); payload keys are the ones Claude, Codex and Gemini
// share. Unknown events and tools pass through as "other" / their raw name, and a
// missing key loses one field, never the event. See docs/18-agent-activity.md.

import type { ActivityEvent, ActivityKind, ActivityTool, AgentKind } from "@cmd/protocol";
import { describeTool, hookEventName } from "../state.ts";

type Payload = Record<string, unknown>;

/** One received payload, before it is stored. */
export interface RawEvent {
  at: number;
  agent: AgentKind | null;
  /** The event name the payload or its file gave. */
  name: string;
  payload: Payload;
  /** Variables from the agent's environment the hook passed on. */
  env?: Record<string, string>;
}

const KINDS: Record<string, ActivityKind> = {
  SessionStart: "session.start",
  SessionEnd: "session.end",
  UserPromptSubmit: "prompt",
  PreToolUse: "tool.start",
  PostToolUse: "tool.end",
  PostToolUseFailure: "tool.end",
  PermissionRequest: "ask",
  Stop: "stop",
  StopFailure: "fail",
  PreCompact: "compact",
  SubagentStart: "subagent.start",
  SubagentStop: "subagent.stop",
};

/** Which env variable names an agent's config dir (the hook passes these on). */
export const HOME_ENV: Record<string, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", gemini: "GEMINI_CLI_HOME" };

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const obj = (v: unknown): Payload | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Payload) : undefined);
const line1 = (s: string) => (s.split(/\r?\n/).find((l) => l.trim()) ?? s).trim();
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function kindOf(agent: string | null, name: string, p: Payload): ActivityKind {
  const n = hookEventName(agent, name);
  if (n === "Notification") return str(p.notification_type) === "idle_prompt" ? "idle" : "ask";
  return KINDS[n] ?? "other";
}

/** Tools that write files, by name; anything else with "edit", "write", "patch", … in its name counts too. */
const WRITERS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch", "write_file", "replace", "edit_file", "create_file"]);
const writes = (tool: string) => WRITERS.has(tool) || /(^|[_\W])(edit|write|patch|create|delete|rename|move)/i.test(tool);

/** Paths in an apply_patch body (Codex). */
function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1]!.trim());
  for (const m of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) out.push(m[1]!.trim());
  return out;
}

function toolOf(p: Payload, end: boolean, failed: boolean): ActivityTool | undefined {
  const name = str(p.tool_name);
  if (!name) return undefined;
  const input = obj(p.tool_input) ?? {};
  const tool: ActivityTool = { name, label: describeTool(name, input) };
  const id = str(p.tool_use_id) ?? str(p.call_id);
  if (id) tool.id = id;
  const command = str(input.command) ?? str(input.cmd) ?? (Array.isArray(input.command) ? input.command.filter((c) => typeof c === "string").join(" ") : undefined);
  if (command) tool.command = cap(line1(command), 200);
  if (writes(name)) {
    const paths = [str(input.file_path), str(input.notebook_path), str(input.path), str(input.absolute_path)].filter((x): x is string => !!x);
    const patch = str(input.patch) ?? str(input.input) ?? (typeof p.tool_input === "string" ? p.tool_input : undefined);
    if (patch) paths.push(...patchPaths(patch));
    if (paths.length) tool.paths = [...new Set(paths)];
  }
  if (end) {
    const r = obj(p.tool_response);
    tool.ok = !(failed || r?.is_error === true || r?.success === false || (r && str(r.error) !== undefined) || r?.interrupted === true);
    const ms = typeof p.duration_ms === "number" ? p.duration_ms : undefined;
    if (ms !== undefined) tool.durationMs = ms;
  }
  return tool;
}

/** The text an event carries, by kind. */
function textOf(kind: ActivityKind, p: Payload): string | undefined {
  switch (kind) {
    case "prompt":
      return str(p.prompt);
    case "stop":
    case "subagent.stop":
      return str(p.last_assistant_message) ?? str(p.prompt_response);
    case "ask":
      return str(p.message) ?? (str(p.tool_name) ? `Allow ${str(p.tool_name)}?` : undefined);
    case "fail":
      return str(p.error) ?? str(p.error_details) ?? str(p.message);
    case "subagent.start":
      return str(p.agent_type);
    default:
      return undefined;
  }
}

export function normalize(r: RawEvent, id = 0): ActivityEvent {
  const p = r.payload;
  const name = str(p.hook_event_name) ?? r.name;
  const kind = kindOf(r.agent, name, p);
  const ev: ActivityEvent = { id, at: r.at, agentId: null, paneId: null, agent: r.agent, source: "hook", name, kind };
  const sessionId = str(p.session_id);
  if (sessionId) ev.sessionId = sessionId;
  const turnId = str(p.turn_id) ?? str(p.prompt_id);
  if (turnId) ev.turnId = turnId;
  const sub = str(p.agent_id);
  if (sub) ev.subagent = sub;
  const text = textOf(kind, p);
  if (text) ev.text = text;
  if (kind === "tool.start" || kind === "tool.end" || kind === "ask") {
    const tool = toolOf(p, kind === "tool.end", hookEventName(r.agent, name) === "PostToolUseFailure");
    if (tool) ev.tool = tool;
  }
  const cwd = str(p.cwd);
  if (cwd) ev.cwd = cwd;
  const tp = str(p.transcript_path);
  if (tp) ev.transcriptPath = tp;
  const home = r.agent ? str(r.env?.[HOME_ENV[r.agent] ?? ""]) : undefined;
  if (home) ev.home = home;
  return ev;
}

/** Longest string kept in a stored payload; tool output can be megabytes. */
export const MAX_STRING = 4000;
const MAX_ITEMS = 200;

/** A payload with long strings cut and long arrays shortened, for storage. */
export function capPayload(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…[+${v.length - MAX_STRING}]` : v;
  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_ITEMS).map((x) => capPayload(x, depth + 1));
    if (v.length > MAX_ITEMS) out.push(`…[+${v.length - MAX_ITEMS} items]`);
    return out;
  }
  if (v && typeof v === "object") {
    if (depth > 12) return "…";
    const out: Payload = {};
    for (const [k, x] of Object.entries(v)) out[k] = capPayload(x, depth + 1);
    return out;
  }
  return v;
}
