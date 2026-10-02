// Domain model shared by core, CLI and UI. See docs/08-host-agents.md.

export type PaneId = string;
export type AgentId = string;

/** A terminal session owned by the core. Every session is a pane, agent or not. */
export interface Pane {
  id: PaneId;
  title: string;
  cwd: string;
  shell: string;
  pid: number;
  /** Name of the foreground process (e.g. "zsh", "claude", "ssh"). */
  foreground: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActivityAt: number;
  exitCode: number | null;
  agentId: AgentId | null;
  /** Memory/CPU of the pane's whole process tree; null until first sampled. */
  usage: PaneUsage | null;
}

export interface PaneUsage {
  /** Physical footprint in bytes, summed over the process tree. */
  memory: number;
  /** Percent of one core over the last interval (can exceed 100). */
  cpu: number;
  processes: number;
  /** Largest processes by memory. */
  top: { pid: number; name: string; memory: number }[];
  sampledAt: number;
}

export type AgentKind = "claude" | "codex" | "gemini" | "opencode" | (string & {});

export type AgentState =
  | "starting"
  | "working"
  | "idle"
  | "needs_input"
  | "done"
  | "exited"
  | "failed";

export type SpawnSource =
  | "user"
  | "detected"
  | "host-api"
  | "claude-subagent"
  | "codex-thread-spawn"
  | "restored";

export interface Agent {
  id: AgentId;
  /** null = virtual child without a terminal (e.g. a Claude in-process subagent). */
  paneId: PaneId | null;
  kind: AgentKind;
  name: string | null;
  cwd: string;

  parentId: AgentId | null;
  rootId: AgentId;
  depth: number;
  spawn: { source: SpawnSource; operationId?: string; prompt?: string };

  native: {
    claudeSessionId?: string;
    claudeAgentId?: string;
    codexThreadId?: string;
    transcriptPath?: string;
  };

  state: AgentState;
  stateSince: number;
  /** Second sidebar line: current tool, pending question, … */
  detail: string | null;
  lastMessage: string | null;
  /** Last prompt the user submitted (title fallback). */
  lastPrompt: string | null;
  /** Last time the user looked at this agent; drives "done, unseen". */
  seenAt: number | null;
  createdAt: number;
}
