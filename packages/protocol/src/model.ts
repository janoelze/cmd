// Domain model shared by core, CLI and UI. See docs/08-host-agents.md.

export type PaneId = string;
export type AgentId = string;
/** Window id. A terminal window's id is its pane id. */
export type WindowId = string;
export type SpaceId = string;

/**
 * A directory you work in, with everything opened for it (docs/11-spaces.md).
 * Panes, agents and windows each belong to exactly one Space.
 */
export interface Space {
  id: SpaceId;
  name: string;
  /** Canonical path (realpath, on-disk case); unique among Spaces. Home: the home folder. */
  root: string;
  home: boolean;
  hue: number;
  /** Position in the switcher (⌘1–9); user-chosen, never reshuffled by recency. */
  order: number;
  /** null = open; otherwise closed and kept as a recent Space. */
  closedAt: number | null;
  createdAt: number;
  lastActiveAt: number;
  /** Layout and selection, owned by the UI, opaque to the core (like AppWindow.state). */
  view: Record<string, unknown>;
}

/** A terminal session owned by the core. Every session is a pane, agent or not. */
export interface Pane {
  id: PaneId;
  spaceId: SpaceId;
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
  /** Its pane's Space; virtual children have their parent's. */
  spaceId: SpaceId;
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
  spaceId: SpaceId;
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

/** How git sees a path in a file window (git.status). */
export type GitFileState = "modified" | "added" | "deleted" | "renamed" | "untracked" | "ignored" | "conflict";

export interface GitFile {
  state: GitFileState;
  /** All of its changes are staged (nothing left in the work tree). */
  staged: boolean;
}

/** The repository a folder is in, and what changed under that folder. */
export interface GitStatus {
  /** Work tree root. */
  root: string;
  /** Git dir of this work tree (index, HEAD, logs/HEAD change on stage, commit, checkout). */
  gitDir: string;
  /** Branch name; null when detached or before the first commit's branch exists. */
  branch: string | null;
  /** Short commit id; null before the first commit. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /**
   * Changed paths under the folder asked about, spelled from that folder (absolute).
   * An untracked or ignored folder is one entry and covers everything inside it.
   */
  files: Record<string, GitFile>;
  /** More changes than were listed. */
  truncated: boolean;
}
