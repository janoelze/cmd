// Domain model shared by core, CLI and UI. See docs/08-host-agents.md.

import type { AgentTurn } from "./activity.ts";
import type { NameSource } from "./names.ts";

export type PaneId = string;
export type AgentId = string;
/** Window id. A terminal window's id is its pane id. */
export type WindowId = string;
export type WorkspaceId = string;

/**
 * A directory you work in, with everything opened for it (docs/11-workspaces.md).
 * Panes, agents and windows each belong to exactly one workspace.
 */
export interface Workspace {
  id: WorkspaceId;
  name: string;
  /** Canonical path (realpath, on-disk case); unique among workspaces. Home: the home folder. */
  root: string;
  /** The checkout its root is in, read when it opens; null for Home and outside a repository. */
  git?: Omit<GitPlace, "branch"> | null;
  /** Its folder is gone (a removed worktree, a deleted folder); checked every little while. */
  gone?: boolean;
  home: boolean;
  /** SF Symbol name; null: the default (workspaceIcon). */
  icon: string | null;
  /** Position in the switcher (⌘1–9); user-chosen, never reshuffled by recency. */
  order: number;
  /** null = open; otherwise closed and kept as a recent workspace. */
  closedAt: number | null;
  createdAt: number;
  lastActiveAt: number;
  /** Layout and selection, owned by the UI, opaque to the core (like AppWindow.state). */
  view: Record<string, unknown>;
}

/**
 * The git checkout something is in (docs/35-checkouts.md): what the UI compares
 * with its workspace's to say where it is only when that differs.
 */
export interface GitPlace {
  /** The project: the repository's main worktree (the same for all its worktrees). */
  project: string;
  /** The worktree's top level (the project itself for the main checkout). */
  top: string;
  /** A linked worktree, not the main checkout. */
  linked: boolean;
  /** The checked-out branch; null when HEAD is detached. */
  branch: string | null;
}

/** A terminal session owned by the core. Every session is a pane, agent or not. */
export interface Pane {
  id: PaneId;
  workspaceId: WorkspaceId;
  title: string;
  cwd: string;
  /** The checkout its cwd is in, branch included; null outside a repository. */
  git?: GitPlace | null;
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
  source: "agent-input" | "agent-done" | "bell" | "terminal" | "command" | "cli" | "widget" | "summary" | "timer";
  /** The terminal it came from, if any (clicking the notification selects it). */
  paneId: PaneId | null;
  /** The window it came from, when not a terminal (a widget). */
  windowId?: WindowId | null;
  /** The workspace of that terminal or window when it was sent; null: about nothing in particular (every workspace). */
  workspaceId?: WorkspaceId | null;
  title: string;
  body: string;
  /** Show a system notification (false: only the attention marker / visual bell). */
  alert: boolean;
  /** Needs you (plays the sound, may bounce the Dock) rather than merely informs. */
  urgent: boolean;
  /** An agent finished a turn: its name or project. The UI sums up several that finish close together. */
  done?: string;
  /** When it was sent. */
  at: number;
}

/**
 * A command a terminal's shell ran, from the shell integration's OSC 133 marks
 * (C: it starts, D: it ended with an exit status). The Commands widget's rows.
 */
export interface CommandRun {
  id: string;
  paneId: PaneId;
  workspaceId: WorkspaceId;
  /** The command line; null if the shell didn't report one (bash without a preexec hook). */
  command: string | null;
  cwd: string;
  /** The checkout it ran in (docs/35); absent in runs recorded before cmd kept it. */
  git?: GitPlace | null;
  startedAt: number;
  /** null while it runs. */
  endedAt: number | null;
  /** null while it runs, or when the shell didn't say. */
  exitCode: number | null;
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
  /** Its pane's workspace; virtual children have their parent's. */
  workspaceId: WorkspaceId;
  kind: AgentKind;
  /** What cmd calls it (docs/32-session-names.md): 1–3 nouns, or null for its kind. */
  name: string | null;
  /** Who named it; a person's name is never replaced by cmd's. */
  nameBy?: NameSource | null;
  /** Its name before the last rename, and when that was: it still answers to it for a while. */
  nameWas?: string | null;
  namedAt?: number | null;
  cwd: string;
  /**
   * The checkout it works in: where it writes files (or goes, before it has
   * written anywhere), which is often not its cwd (agents start in the main
   * checkout and move to a worktree). null outside a repository.
   */
  git?: GitPlace | null;

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
   * gone (a deleted worktree's); legacy: `cmd hook`, or this cmd's
   * in an older form (another build's code, or before the code went inline).
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
  workspaceId: WorkspaceId;
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
  /** What kind of widget: "developer" (shown with the widgets.developer setting). */
  tags?: string[];
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
  /** Built-in widgets' tags ("developer"). */
  tags?: string[];
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
 * see agents and workspaces. control: also type, write files, open and close windows.
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
  /** How phones reach this Mac (remote.access): relay, tailscale, url. */
  access: string;
  /** Where phones open cmd: the web client's origin; null until it's known. */
  address: string | null;
  devices: RemoteDevice[];
  sessions: RemoteSession[];
  /** Pairing requests waiting for an answer (an app that opens later still asks). */
  requests: RemotePairRequest[];
}

/** A step of an access mode's setup (Settings → Remote Access, `cmd remote setup`). */
export interface RemoteAccessCheck {
  id: string;
  title: string;
  state: "ok" | "todo" | "error";
  /** What's there, or what to do. */
  detail?: string;
  /** A page that helps (a download, an admin console). */
  link?: string;
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
