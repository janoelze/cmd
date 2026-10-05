// What agents do, as data: every signal the core receives about an agent is kept
// as an ActivityEvent (raw payload plus one vocabulary across agents), and turns
// (prompt → stop) are derived from them. See docs/18-agent-activity.md.

import type { AgentId, AgentKind, PaneId } from "./model.ts";

export type ActivityKind =
  | "session.start"
  | "session.end"
  | "prompt"
  | "tool.start"
  | "tool.end"
  /** Waiting for the user: a permission request or a question. */
  | "ask"
  /** The agent says it is idle at its prompt (Claude's idle_prompt). */
  | "idle"
  | "stop"
  | "fail"
  | "compact"
  | "subagent.start"
  | "subagent.stop"
  /** Inferred by the core: a turn ended without the agent saying so. */
  | "interrupt"
  /** Something in the stream that doesn't add up (see ActivityEvent.text). */
  | "anomaly"
  /** A hook event cmd doesn't map (kept raw). */
  | "other";

export interface ActivityTool {
  /** As the agent names it: "Bash", "Edit", "apply_patch", "mcp__x__y". */
  name: string;
  /** Pairs start and end when the agent says (tool_use_id). */
  id?: string;
  /** "Editing panes.ts", "npm test". */
  label: string | null;
  /** Files the call writes (edit, write, patch). */
  paths?: string[];
  /** Shell command, first line. */
  command?: string;
  /**
   * The shell command looks like it writes files, and how ("sed -i", "script",
   * "redirect", …). Which files is git's or the folder watch's to say: paths in
   * commands are too unreliable to list.
   */
  writes?: string;
  /** tool.end: false when the call failed or was denied. */
  ok?: boolean;
  durationMs?: number;
}

export interface ActivityEvent {
  /** Order of arrival (row id). */
  id: number;
  /** When it happened, ms (the hook's write time, not when the core read it). */
  at: number;
  agentId: AgentId | null;
  paneId: PaneId | null;
  /** The agent that reported it ("claude"), from the hook's argument. */
  agent: AgentKind | null;
  /** hook: the agent's own hooks; core: inferred or checked by cmd. */
  source: "hook" | "core";
  /** The agent's event name as received ("PreToolUse", "AfterAgent"). */
  name: string;
  kind: ActivityKind;
  sessionId?: string;
  /** The agent's own turn id, when it has one (Claude prompt_id, Codex turn_id). */
  turnId?: string;
  /** Fired inside a subagent: its id. */
  subagent?: string;
  /** Prompt, final message, question, error or anomaly, by kind. */
  text?: string;
  /** prompt: sent by the agent itself, not typed (a finished background task reporting back). */
  auto?: boolean;
  /** stop: work the agent left running in the background (subagents, shells), by description. */
  background?: string[];
  tool?: ActivityTool;
  cwd?: string;
  transcriptPath?: string;
  /** The agent's config dir, from its environment ($CLAUDE_CONFIG_DIR, …), when set. */
  home?: string;
  /** The payload as received; long strings are cut. Only with `raw: true`. */
  raw?: Record<string, unknown>;
}

export type TurnOutcome = "working" | "waiting" | "done" | "failed" | "interrupted";

export interface TurnFile {
  path: string;
  /** git's letter (A, M, D, R, ?) or "M" for a file a tool wrote outside a repository. */
  change: string;
  /**
   * git: the work tree changed during the turn; fs: the folder (not a repository)
   * changed during it; tool: one of the agent's file tools wrote it.
   */
  via: ("git" | "fs" | "tool")[];
}

/** One prompt and everything up to the agent's answer (or failure, or interruption). */
export interface AgentTurn {
  agentId: AgentId;
  /** 0, 1, … per agent. */
  index: number;
  sessionId: string | null;
  turnId: string | null;
  startedAt: number;
  endedAt: number | null;
  /** null: the turn began before cmd saw it (e.g. the core started mid-turn). */
  prompt: string | null;
  /** The prompt came from the agent itself (a background task finished), not the user. */
  auto: boolean;
  /** At its end, work still running in the background (a later auto turn picks it up). */
  background: string[];
  outcome: TurnOutcome;
  /** What the agent wants from the user, while waiting (the last ask of the turn otherwise). */
  ask: { message: string; tool?: string; input?: string } | null;
  /** The agent's own last message. */
  final: string | null;
  error: string | null;
  tools: { name: string; count: number; failed: number }[];
  /** Last few shell commands, first lines. */
  commands: string[];
  /** Shell commands that looked like they write files (ActivityTool.writes). */
  shellWrites: number;
  files: TurnFile[];
  subagents: number;
  /** Events that make up the turn. */
  events: number;
  /** Rules that decided something the agent didn't say ("interrupted: quiet for 30 s"). */
  inferred: string[];
}

/** Where an agent keeps its config, sessions and hooks. */
export interface AgentHome {
  agent: AgentKind;
  dir: string;
  /** How cmd found it, first way first. */
  via: ("default" | "env" | "hook" | "transcript" | "scan" | "setting")[];
  /** Env a process needs to use this home (null for the default one). */
  env: Record<string, string> | null;
  firstSeen: number;
  lastSeen: number;
}

/** What one agent's events actually carried recently: computed, not claimed. */
export interface AgentCoverage {
  agent: AgentKind;
  events: number;
  sessions: number;
  /** Events per kind. */
  kinds: Partial<Record<ActivityKind, number>>;
  /** Share (0–1) of events of a kind that carried a field, e.g. "stop.text". */
  fields: Record<string, number>;
  /** Hook event names cmd doesn't map. */
  unmapped: string[];
  anomalies: number;
  lastAt: number | null;
}
