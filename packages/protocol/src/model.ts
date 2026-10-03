// Domain model shared by core, CLI and UI. See docs/08-host-agents.md.

export type PaneId = string;
export type AgentId = string;
/** Window id. A terminal window's id is its pane id. */
export type WindowId = string;

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
  /** Something in the terminal wants you (a bell, a notification, a long command finished) until you look at it. */
  attention: Attention | null;
  /** No system notifications from this terminal (its attention marker still shows). */
  muted: boolean;
}

/** Why a terminal wants you; see packages/core/src/notifications.ts. */
export interface Attention {
  kind: "bell" | "notify" | "command";
  /** Short text for the title bar and sidebar ("Bell", the notification, "make finished · 42s"). */
  text: string;
  /** A failed command or a bell: shown as needing you rather than as done. */
  urgent: boolean;
  at: number;
}

/**
 * One notification from any source, decided by the core (what is worth telling)
 * and shown by the UI (whether to, by focus and the notifications.when setting).
 */
export interface AppNotification {
  id: string;
  source: "agent-input" | "agent-done" | "bell" | "terminal" | "command" | "cli";
  /** The terminal it came from, if any (clicking the notification selects it). */
  paneId: PaneId | null;
  title: string;
  body: string;
  /** Show a system notification (false: only the attention marker / visual bell). */
  alert: boolean;
  /** Needs you (plays the sound, may bounce the Dock) rather than merely informs. */
  urgent: boolean;
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

// ── windows ──────────────────────────────────────────────

/**
 * Window kind: a registered window type. Built-ins: "terminal", "browser",
 * "files", "text"; plugins can add more.
 */
export type WindowKind = string;

/**
 * Anything the main pane lays out. Terminal windows are derived from panes
 * (id = pane id); other windows are stored by the core. `state` belongs to the
 * window's type (browser: { url }, files/text: { path }, terminal: { paneId }).
 */
export interface AppWindow {
  id: WindowId;
  kind: WindowKind;
  title: string;
  createdAt: number;
  updatedAt: number;
  state: Record<string, unknown>;
}

/** What a window type can open (see the core's window type registry). */
export interface OpenRuleInfo {
  folders?: boolean;
  extensions?: string[];
  text?: boolean;
  schemes?: string[];
  priority?: number;
}

export interface WindowTypeInfo {
  kind: WindowKind;
  title: string;
  /** SF Symbol name. */
  icon: string;
  opens: OpenRuleInfo;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "dir" | "file" | "link";
  size: number;
  mtime: number;
  hidden: boolean;
}
