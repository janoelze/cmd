// Domain model shared by core, CLI and UI. See docs/08-host-agents.md.

import type { AgentTurn } from "./activity.ts";

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
  /** SF Symbol name; null: the default (spaceIcon). */
  icon: string | null;
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
  /**
   * A remote device sized this terminal to its screen (its name), for as long as
   * it shows it; the desktop then draws it at that size. null: the desktop's size.
   */
  sizedBy: string | null;
  /** A progress bar the program in it reports (OSC 9;4); null when there is none. */
  progress: Progress | null;
}

/** OSC 9;4 progress: a value (0–100) unless indeterminate; error and paused bars are coloured. */
export interface Progress {
  state: "normal" | "error" | "indeterminate" | "paused";
  value: number;
}

/**
 * Why a window wants you, kept until you look (see packages/core/src/notifications.ts):
 * a terminal's in Pane.attention, another window's (a widget's notification) in
 * AppWindow.state.attention.
 */
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
  source: "agent-input" | "agent-done" | "bell" | "terminal" | "command" | "cli" | "widget" | "summary";
  /** The terminal it came from, if any (clicking the notification selects it). */
  paneId: PaneId | null;
  /** The window it came from, when not a terminal (a widget). */
  windowId?: WindowId | null;
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

/** One process's own usage (not its children's); see the Task Manager. */
export interface ProcessStat {
  pid: number;
  /** Physical footprint in bytes. */
  memory: number;
  /** Percent of one core since the previous sample. */
  cpu: number;
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
  /** The current or last turn, from the agent's events (activity.ts). */
  turn?: AgentTurn | null;
  /** What set the current state: "hook Stop", "inferred: …". */
  stateCause?: string | null;
  /** The agent's own version (from its executable), when known. */
  version?: string | null;
  /** The model it said it uses. */
  model?: string | null;
}

/** An agent config file cmd's hook can be installed into (Settings → Agents → Hooks). */
export interface HookTarget {
  agent: AgentKind;
  /** "Claude Code", … */
  title: string;
  file: string;
  /**
   * elsewhere: another cmd's hook (a dev build); stale: a cmd hook whose script is
   * gone (a deleted worktree's); legacy: the ghostty-agents fork's or `cmd hook`.
   */
  state: "installed" | "missing" | "legacy" | "elsewhere" | "stale";
  /** The user took cmd's hook out of this file: automatic installs leave it alone. */
  declined?: boolean;
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
  /** "window": where you work (File menu); "widget": shows something at a glance (the Widget Library). docs/16-widgets.md. */
  role: "window" | "widget";
  /** One line for the Widget Library. */
  description?: string;
}

/** A widget in the Widget Library (docs/16-widgets.md): a built-in widget type, or one made with Magic. */
export interface WidgetEntry {
  /** "magic:<widget id>" for widgets made with Magic, "type:<kind>" for built-in widgets. */
  ref: string;
  source: "builtin" | "yours";
  /** The window kind that shows it. */
  kind: WindowKind;
  title: string;
  description?: string;
  /** SF Symbol name. */
  icon: string;
  /** What was first asked for; widgets made with Magic. */
  request?: string;
  /** A screenshot (file path); widgets made with Magic. */
  shot?: string;
  /** Its folder; widgets made with Magic. */
  dir?: string;
  createdAt?: number;
  usedAt?: number;
  /** Windows showing it now. */
  windows: WindowId[];
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

/**
 * Remote access (docs/13-remote-access.md). view: watch terminals, read files,
 * see agents and Spaces. control: also type, write files, open and close windows.
 */
export type RemoteScope = "view" | "control";

/** A browser paired with this Mac. */
export interface RemoteDevice {
  id: string;
  /** What the browser called itself at pairing, e.g. "Safari on iPhone". */
  name: string;
  scope: RemoteScope;
  pairedAt: number;
  lastSeenAt: number;
  /** Unpaired when unseen until then (remote.deviceExpiryDays). */
  expiresAt: number;
  connected: boolean;
}

/** A device connected right now (a device can have several, e.g. two tabs). */
export interface RemoteSession {
  id: string;
  deviceId: string;
  /** The device's name, for showing who is in. */
  name: string;
  scope: RemoteScope;
  since: number;
  /** As the relay reports it; informational only. */
  ip: string;
  /** The windows it is looking at (window.follow). */
  watching: WindowId[];
}

export interface RemoteStatus {
  enabled: boolean;
  /** off: disabled; connecting: to the relay; online: devices can reach this Mac; error: see `error`. */
  state: "off" | "connecting" | "online" | "error";
  error: string | null;
  relay: string;
  devices: RemoteDevice[];
  sessions: RemoteSession[];
  /** Pairing requests waiting for an answer (an app that opens later still asks). */
  requests: RemotePairRequest[];
}

/** An entry of the remote access audit log (Settings → Remote Access → Recent activity, `cmd remote log`). */
export interface RemoteLogEntry {
  at: number;
  /** enabled, disabled, pair-link, paired, pair-denied, session, session-end, denied, handshake-failed, revoked, scope, expired */
  kind: string;
  deviceId: string | null;
  /** The device's name when it is still paired. */
  device: string | null;
  detail: string | null;
}

/** A browser asked to pair; the person on the Mac allows or denies it (remote.approve). */
export interface RemotePairRequest {
  requestId: string;
  name: string;
  /** Shown on the Mac and on the phone; they must match. */
  words: string[];
  /** Proposed by `remote.pair`; the person may change it when allowing. */
  scope: RemoteScope;
  expiresAt: number;
}
