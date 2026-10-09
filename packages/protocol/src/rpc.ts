// Core API. Transport: newline-delimited JSON-RPC 2.0 over a Unix socket.
// Every method is reachable from the UI, the `cmd` CLI and (later) MCP.

import type { Agent, AgentId, AgentKind, AgentState, AppNotification, AppWindow, CommandRun, FileEntry, GitStatus, HookTarget, Pane, PaneId, ProcessStat, RemoteAccessCheck, RemoteDevice, RemoteLogEntry, RemotePairRequest, RemoteScope, RemoteStatus, Workspace, WorkspaceId, WidgetEntry, WindowId, WindowTypeInfo } from "./model.ts";
import type { DataClassInfo, DataEvent, DataQuery, DataStats, NewDataEvent, SessionInfo, TurnRow, ViewQuery } from "./events.ts";
import type { SettingKey, Settings } from "./settings.ts";
import type { AiModel, AiStatus } from "./ai.ts";
import type { MagicPreviewRequest, MagicPreviewShot, MagicProgress, MagicRuntime, MagicWidgetInfo } from "./magic.ts";
import type { SecretsStatus } from "./secrets.ts";
import type { ActivityEvent, ActivityExportHeader, AgentCoverage, AgentHome, AgentTurn } from "./activity.ts";
import type { JournalDay, JournalEvent, JournalEventKind, JournalThread, JournalWeek } from "./journal.ts";
import type { SqliteQuery, SqliteResult, SqliteRowsQuery, SqliteSchema } from "./sqlite.ts";
import type { ActionsList } from "./actions.ts";

export interface CoreInfo {
  pid: number;
  build: string;
  /** Folder the core runs from (the repo, or the app's runtime copy). */
  root: string;
  node: string;
  /** Epoch ms. */
  startedAt: number;
  rssBytes: number;
  heapBytes: number;
  /** CPU time used since start, user + system. */
  cpuSeconds: number;
  panes: number;
  connections: number;
  socket: string;
  dbPath: string | null;
  settingsPath: string | null;
  /** Where terminals run: the PTY host process, or null for in the core (it couldn't start). */
  ptyHost: { pid: number; startedAt: number; root: string } | null;
  /** What the core is still doing after it began answering (view rebuilds, the first transcript read). */
  startup: StartupStatus;
  /** The last times the core's thread was blocked for a while, newest last (core/src/scheduler.ts). */
  stalls: Stall[];
}

/** Startup work runs after the socket answers; `tasks` are the jobs still running, in order. */
export interface StartupStatus {
  phase: "starting" | "ready";
  /** Epoch ms the core started. */
  since: number;
  tasks: { id: string; label: string }[];
}

/** The event loop was blocked for `ms` from `at`, while `in` ran (a request's method, a job). */
export interface Stall {
  at: number;
  ms: number;
  in: string;
}

export interface SettingsSnapshot {
  settings: Settings;
  /** Keys set explicitly in the user's file. */
  overrides: SettingKey[];
  /** Validation problems in the user's file (those entries are ignored). */
  errors: string[];
  path: string;
}

/**
 * Where something new goes (docs/11-workspaces.md). Resolved in order: `workspaceId`,
 * the calling pane's workspace (`callerPaneId`, the CLI's CMD_PANE_ID), the parent
 * agent's, the open workspace whose root most deeply contains the cwd or path, Home.
 */
export interface Placement {
  workspaceId?: WorkspaceId;
  callerPaneId?: PaneId;
}

export interface Methods {
  /**
   * stateDir: the core's $CMD_HOME, so an app can tell its own core from another instance's (older cores omit it).
   * root: the code folder it runs from, so an app restarts a core of another checkout even when the code is the same.
   */
  "core.hello": { params: {}; result: { version: string; pid: number; socket: string; build: string; stateDir?: string; root?: string } };
  /** Diagnostics for the Settings window's Updates & About page. */
  "core.info": { params: {}; result: CoreInfo };
  /** The core's and PTY host's own usage (Task Manager); CPU% is since the previous call. Null where unknown. */
  "core.processes": { params: {}; result: { core: ProcessStat | null; ptyHost: ProcessStat | null } };

  /** The app started (usage stats, core/usage.ts). */
  "usage.launch": { params: {}; result: null };

  /** cwd defaults to the workspace's root. */
  "pane.create": {
    params: Placement & { cwd?: string; command?: string; cols?: number; rows?: number; env?: Record<string, string> };
    result: Pane;
  };
  "pane.list": { params: {}; result: Pane[] };
  "pane.write": { params: { paneId: PaneId; data: string }; result: null };
  "pane.resize": { params: { paneId: PaneId; cols: number; rows: number }; result: null };
  /**
   * A remote device sizes the terminal it shows to its screen, until it releases
   * it, leaves or disconnects, or someone types at the Mac (Pane.sizedBy).
   */
  "pane.fitOverride": { params: { paneId: PaneId; cols: number; rows: number } | { paneId: PaneId; release: true }; result: null };
  /** The Mac takes a terminal back from the device sizing it. */
  "pane.reclaim": { params: { paneId: PaneId }; result: null };
  "pane.kill": { params: { paneId: PaneId }; result: null };
  /** Notifications (packages/core/src/notifications.ts). */
  "pane.setMuted": { params: { paneId: PaneId; muted: boolean }; result: null };
  "pane.clearAttention": { params: { paneId: PaneId }; result: null };
  /** Looking at a window that isn't a terminal clears its attention marker (state.attention). */
  "window.clearAttention": { params: { id: WindowId }; result: null };
  /** `cmd notify`: from a terminal (paneId) or from anywhere. */
  "notify.send": { params: { paneId?: PaneId | null; title?: string; body: string }; result: null };
  /** Clear the Notifications widget (records notification.clear; the events stay in the log). */
  "notify.clear": { params: {}; result: null };
  /** Terminal state, for re-attaching a view after a UI reload; replay it into a terminal of `cols` x `rows`. */
  "pane.snapshot": { params: { paneId: PaneId }; result: { data: string; cols: number; rows: number } };
  /** Clear stuck terminal state (modes a crashed program left on). */
  "pane.reset": { params: { paneId: PaneId }; result: null };
  /** Plain-text tail of the pane, as displayed. */
  "pane.read": { params: { paneId: PaneId; lines?: number }; result: { text: string } };

  "agent.list": { params: {}; result: Agent[] };
  "agent.spawn": {
    params: Placement & {
      kind: AgentKind;
      prompt?: string;
      cwd?: string;
      name?: string;
      /** Defaults to the caller's agent when called from inside a pane. */
      parentId?: AgentId | null;
      operationId?: string;
    };
    result: Agent;
  };
  "agent.send": { params: { agentId: AgentId; text: string; submit?: boolean }; result: null };
  "agent.wait": {
    params: {
      agentIds: AgentId[];
      until: AgentState[];
      mode?: "any" | "all";
      timeoutMs?: number;
    };
    result: { agents: Agent[]; timedOut: boolean };
  };
  /** Names an agent (docs/32-session-names.md); null hands naming back to cmd. */
  "agent.rename": { params: { agentId: AgentId; name: string | null }; result: Agent };
  "agent.kill": { params: { agentId: AgentId; tree?: boolean }; result: { killed: AgentId[] } };
  "agent.markSeen": { params: { agentId: AgentId }; result: null };

  /**
   * Summarise the agent's current session into a Markdown file (docs/20-session-summaries.md).
   * Returns once the file exists and (unless open: false) a window shows it; the answer
   * streams into the file after that. wait: return when it's written, with its Markdown.
   */
  "agent.summarize": { params: { agentId: AgentId; open?: boolean; wait?: boolean }; result: { path: string; windowId: WindowId | null; markdown: string | null } };
  /**
   * Everything recorded over the last `days` (default 14), in pages: the header and
   * turns come with the first page (no afterId), events in id order; next: the
   * afterId of the next page, null at the end. anonymize: home folders become "~".
   */
  "agents.export": {
    params: { days?: number; anonymize?: boolean; afterId?: number; limit?: number };
    result: { header: ActivityExportHeader; turns: AgentTurn[]; events: ActivityEvent[]; next: number | null };
  };
  /** What each agent's events actually carried over the last `days` (default 7). */
  "agents.coverage": { params: { days?: number }; result: AgentCoverage[] };
  /**
   * The journal (docs/23-journal.md). A scope is a workspace (workspaceId), "repo:<path>" or "all" (the default).
   * `write`: "stale" writes days whose events changed (the default), "never" only reads, "force" writes again.
   */
  "journal.days": { params: { workspaceId?: WorkspaceId; scope?: string; count?: number; write?: "never" | "stale" | "force" }; result: JournalDay[] };
  /** One work day by its local midnight (a work day runs 04:00 to 04:00); null when nothing happened. */
  "journal.day": { params: { workspaceId?: WorkspaceId; scope?: string; date: number; write?: "never" | "stale" | "force" }; result: JournalDay | null };
  /** The week a date falls in, rolled up from its days (written if they need to be, by `write`); null when nothing happened. */
  "journal.week": { params: { workspaceId?: WorkspaceId; scope?: string; date: number; write?: "never" | "stale" | "force" }; result: JournalWeek | null };
  /** A day as each earlier version wrote it, newest first (kept when a day is written again): for comparing revisions. */
  "journal.history": { params: { workspaceId?: WorkspaceId; scope?: string; date: number }; result: JournalDay[] };
  /** The recorded events, oldest first. */
  "journal.events": { params: { since?: number; until?: number; workspaceId?: WorkspaceId; repo?: string; kinds?: JournalEventKind[]; limit?: number }; result: JournalEvent[] };
  /** A day's threads and the digest a model would get: how the journal sees it, before any model. */
  "journal.threads": { params: { workspaceId?: WorkspaceId; scope?: string; date: number }; result: { threads: JournalThread[]; digest: string } };
  /** Writes something down: from an agent's terminal (paneId), it joins that agent's session. */
  "journal.note": { params: { text: string; paneId?: PaneId; workspaceId?: WorkspaceId }; result: { id: number } };
  /** Reads new turns, sessions and git now (it does every few minutes). */
  "journal.sync": { params: {}; result: null };
  /** The event log (docs/28): events and views by one query shape. Prefix types end in a dot ("git."). */
  "data.query": { params: { query: DataQuery }; result: DataEvent[] };
  /** Size and counts of the events file. */
  "data.stats": { params: {}; result: DataStats };
  /** Every class of recorded data: what it is, how long it's kept, its switch, whether it leaves the Mac. */
  "data.explain": { params: {}; result: (DataClassInfo & { enabled: boolean; events: number })[] };
  /** Record something from a client: a note, an action the renderer saw (user.*). Other types are the core's to record. */
  "data.record": { params: { event: NewDataEvent }; result: { seq: number } | null };
  /** Events from a `cmd data export` file; returns how many were kept. */
  "data.import": { params: { events: NewDataEvent[] }; result: { imported: number } };
  /**
   * The query's events now, and from then on a `data.changed` for every event
   * recorded or updated that answers it, until unsubscribed or the connection closes.
   */
  "data.subscribe": { params: { query: DataQuery }; result: { id: string; events: DataEvent[] } };
  /** On the widgets socket: which widget this connection is (a token issued for its data.ts run); then data.query is allowed. */
  "widget.hello": { params: { token: string }; result: { widgetId: string; workspaceId: string | null } };
  "data.unsubscribe": { params: { id: string }; result: null };
  /** A view's rows now (turns or sessions), newest first for sessions. */
  "data.view": { params: { query: ViewQuery }; result: (TurnRow | SessionInfo)[] };
  /** A view's rows now (turns or sessions), and from then on a `view.changed` for every row that changes and matches. Unsubscribe with data.unsubscribe. */
  "data.subscribeView": { params: { query: ViewQuery }; result: { id: string; rows: (TurnRow | SessionInfo)[] } };
  /** Deletes a session's, a project's, a time range's or some types' events (all given must match); a forgotten session or project is never recorded again. */
  "data.forget": { params: { sessionId?: string; projectId?: string; before?: number; types?: string[] }; result: { events: number } };
  /** What the log knows about an entity (agent, session, project, pane, window, workspace), or the newest of a kind, with links. */
  "data.entities": { params: { kind: string; id?: string; limit?: number }; result: { kind: string; id: string; created: number; seen: number; attrs: Record<string, unknown>; links: { from: [string, string]; to: [string, string]; kind: string; at: number; until: number | null }[] }[] };
  /** Rebuilds a view from the log with the current rules (turns: the reducer and its timing rules; sessions: the transcripts). */
  "data.rebuild": { params: { view: "turns" | "sessions" }; result: { rows: number } };
  /** Applies the exclusion rules (data.exclude) to what's already kept. */
  "data.applyRules": { params: {}; result: { events: number } };
  /** Where agents keep their config (discovered); rescan: look again first. */
  "agents.homes": { params: { rescan?: boolean }; result: AgentHome[] };

  /** Called from inside agent hooks: by cmd's hook (spooled: the event is in the spool already) and the old `cmd hook`. */
  "hook.ingest": {
    params: { paneId: PaneId; agent: AgentKind; event: string; payload: Record<string, unknown>; spooled?: boolean };
    /** context: text for the hook to hand the agent (peer briefings, `agents.peers`). */
    result: { agentId: AgentId | null; context?: string };
  };
  /** Agent configs cmd's hook can go into, and whether it is there (agents/hooks.ts). */
  "hooks.status": { params: {}; result: HookTarget[] };
  /** file: one of hooks.status's. */
  "hooks.install": { params: { file: string }; result: HookTarget[] };
  "hooks.remove": { params: { file: string }; result: HookTarget[] };
  "identify": { params: { paneId: PaneId }; result: { pane: Pane | null; agent: Agent | null } };

  "settings.get": { params: {}; result: SettingsSnapshot };
  "settings.set": { params: { key: string; value: unknown }; result: SettingsSnapshot };
  "settings.reset": { params: { key: string }; result: SettingsSnapshot };
  /** Which secrets (API keys) are set, never their values (secrets.ts). */
  "secrets.status": { params: {}; result: SecretsStatus };
  /** Store a secret, or remove it with null. */
  "secrets.set": { params: { key: string; value: string | null }; result: SecretsStatus };

  /** AI providers (docs/17-ai.md): which have keys, whether they work, what each tier resolves to. */
  "ai.status": { params: {}; result: AiStatus };
  /**
   * Check a provider's key and store it. A key the provider refuses is not
   * stored (the error says why); one that can't be checked now (offline) is
   * stored unchecked. null removes the key.
   */
  "ai.connect": { params: { provider: string; key: string | null }; result: AiStatus };
  /** The models a provider offers to the user's stored key, newest first (fails without a key); refresh: ask again. */
  "ai.models": { params: { provider: string; refresh?: boolean }; result: AiModel[] };

  /**
   * Open a window of a registered type. `input` is the type's create input:
   * terminal { cwd?, command? }, browser { url? }, files { path? }, text { path }.
   */
  "window.open": { params: Placement & { kind: string; input?: Record<string, unknown> }; result: AppWindow };
  /** Windows report navigation (state patches, applied by their type) and titles here. */
  /** `kind` switches the window to another type in place (state re-created from the current one). */
  "window.update": {
    params: { id: WindowId; title?: string; state?: Record<string, unknown>; kind?: string };
    result: AppWindow;
  };
  /** Registered window types (built-in and plugins). */
  "window.types": { params: {}; result: WindowTypeInfo[] };
  "window.close": { params: { id: WindowId }; result: null };
  /**
   * Open a path or URL in the window type that handles it (registry rules +
   * the open.handlers setting). null = no type handles it (use the default app).
   */
  "window.openTarget": { params: Placement & { target: string }; result: AppWindow | null };
  /** Move a window to another workspace; a terminal takes its agent tree (and their terminals) along. */
  "window.move": { params: { id: WindowId; workspaceId: WorkspaceId }; result: AppWindow };

  /** Open workspaces in switcher order; closed: also the closed (recent) ones. */
  "workspace.list": { params: { closed?: boolean }; result: Workspace[] };
  /**
   * Attach-or-create by root: the workspace whose root is this path (canonicalized),
   * reopened if it was closed, else a new one. Relative paths resolve against
   * `cwd`. gitRoot: use the enclosing repository's root (a worktree's own root).
   * show: ask the UI to show it (workspace.show event; newWindow: in a new app window).
   */
  "workspace.open": {
    params: { path: string; cwd?: string; gitRoot?: boolean; show?: boolean; newWindow?: boolean };
    result: { workspace: Workspace; created: boolean };
  };
  /** The workspace a path belongs to (longest open root containing it, else Home), without creating one. */
  "workspace.match": { params: { path: string; cwd?: string }; result: Workspace };
  /** view: keys merged into the workspace's view (null deletes a key). active: it was just shown (recency for the picker). icon: an SF Symbol name, null for the default. */
  "workspace.update": { params: { id: WorkspaceId; name?: string; icon?: string | null; order?: number; view?: Record<string, unknown>; active?: boolean }; result: Workspace };
  /** Kill its terminals and agents, remove its windows; the workspace stays as a recent one. Home can't be closed. */
  "workspace.close": { params: { id: WorkspaceId }; result: null };
  /** Delete a closed workspace's record. */
  "workspace.forget": { params: { id: WorkspaceId }; result: null };
  /** All windows, terminals included. */
  "window.list": { params: {}; result: AppWindow[] };

  /**
   * Make a Magic widget's content from a request (docs/12-magic-widgets.md), or
   * refine what it shows. Returns at once; progress arrives as magic.stream
   * events and the result in the window's state.
   */
  "magic.run": { params: { id: WindowId; prompt: string }; result: null };
  /** Stop a run in progress. */
  "magic.cancel": { params: { id: WindowId }; result: null };
  /** Run the widget's data source now (then on its interval again). */
  "magic.refresh": { params: { id: WindowId }; result: null };
  /** Set how often the widget's data source runs, in seconds (0 = only on Refresh Now); kept across refinements. */
  "magic.setRefresh": { params: { id: WindowId; seconds: number }; result: null };
  /** Allow (or decline) the media origins the widget asks for (MagicState.media); the frame's CSP opens only allowed ones. */
  "magic.media": { params: { id: WindowId; allow: boolean }; result: null };
  /** A Magic widget, for the edit view: folder, files, revisions, manifest, which secrets are set. */
  "magic.widget": { params: { id: WindowId }; result: MagicWidgetInfo | null };
  /** Bring back a revision of the widget (as a new revision). */
  "magic.restore": { params: { id: WindowId; revision: number }; result: null };
  /** Set the widget's config values (its manifest's config fields; secrets go through magic.secret); the data runs again. */
  "magic.config": { params: { id: WindowId; values: Record<string, unknown> }; result: null };
  /** Store or clear a secret config field's value (kept by the core, only data.ts gets it). */
  "magic.secret": { params: { id: WindowId; key: string; value: string | null }; result: null };
  /** The widget's cmd.state.set (value null removes the key). */
  "magic.state": { params: { id: WindowId; key: string; value: unknown }; result: null };
  /** Ask the agent to fix what is wrong (the data's last error, the checks' problems). */
  "magic.fix": { params: { id: WindowId }; result: null };
  /**
   * Jam's AI: the new code for a request about the code playing now. `sounds`: what the
   * window has loaded; `history`: the code before each earlier change, newest first (for "undo
   * that"); `failed`: the last attempt and why it didn't play (the window retries).
   */
  "jam.change": {
    params: { code: string; request: string; sounds?: string[]; history?: { code: string; request: string; summary: string }[]; failed?: { code: string; error: string } };
    result: { code: string; summary: string };
  };
  /** Mute a widget: its notifications only mark the window, without a system notification or sound. */
  "magic.mute": { params: { id: WindowId; muted: boolean }; result: null };
  /** What widgets run on: Deno, the sandbox, the previewer. */
  "magic.runtime": { params: {}; result: MagicRuntime };
  /** Download the pinned Deno into cmd's state folder (also the yes to a build's "Download Deno?"). */
  "magic.installRuntime": { params: {}; result: MagicRuntime };
  /** "Not now" to a build's "Download Deno?": it goes on without it. */
  "magic.skipRuntime": { params: {}; result: null };
  /** This connection renders widget previews (the app): it gets magic.previewRequest events. */
  "magic.previewer": { params: {}; result: null };
  /** The previewer's answer to a magic.previewRequest. */
  "magic.previewResult": { params: { reqId: string; shots?: MagicPreviewShot[]; error?: string }; result: null };

  /** The Widget Library (docs/16-widgets.md): built-in widgets, then yours by last use. */
  "widget.list": { params: {}; result: WidgetEntry[] };
  /** Put a widget from the library in a workspace (another window showing it, if one already does). */
  /** `cwd`: the folder a built-in widget is about (Live Diff's repository), e.g. the selected terminal's. */
  "widget.add": { params: Placement & { ref: string; cwd?: string }; result: AppWindow };
  /** Name a widget made with Magic; the name sticks across changes. */
  "widget.rename": { params: { ref: string; title: string }; result: null };
  /** A copy of a widget made with Magic, to change on its own (files, revisions, secrets). */
  "widget.duplicate": { params: { ref: string }; result: WidgetEntry };
  /** Delete a widget made with Magic: its folder, revisions and secrets. Refused while a window shows it. */
  "widget.delete": { params: { ref: string }; result: null };

  /** Directory listing for file windows (dirs first, then by name). */
  "fs.list": { params: { path: string }; result: { path: string; parent: string | null; entries: FileEntry[] } };
  /** Which of these paths exist, resolved against `cwd` (~ expanded): the absolute path, or null. For terminal links. */
  "fs.resolve": { params: { paths: string[]; cwd: string }; result: (string | null)[] };
  /** Read a text file (first 5 MB). */
  "fs.read": {
    params: { path: string };
    result: { text: string; size: number; mtime: number; truncated: boolean; binary: boolean };
  };
  /** Get fs.changed events for a file or folder (released when the connection closes). */
  "fs.watch": { params: { path: string }; result: { watching: boolean } };
  "fs.unwatch": { params: { path: string }; result: null };
  /** Write a text file; fails if it changed on disk since `expectMtime`. */
  "fs.write": { params: { path: string; text: string; expectMtime?: number }; result: { size: number; mtime: number } };
  /** Rename in place (`name` has no slashes); fails if the name is taken. Returns the new path. */
  "fs.rename": { params: { path: string; name: string }; result: string };
  /** Copy a file or folder next to itself as "name copy", "name copy 2"…; returns the copy's path. */
  "fs.duplicate": { params: { path: string }; result: string };
  /** New empty file or folder in `dir`, named "untitled" / "untitled folder" (then " 2"…); returns its path. */
  "fs.create": { params: { dir: string; kind: "file" | "dir" }; result: string };
  /**
   * Copy or move files and folders into `dir` (drag and drop); "auto" moves on the
   * same disk and copies from another, like Finder. A taken name gets " 2"… Returns where each one ended up.
   */
  "fs.transfer": { params: { paths: string[]; dir: string; op: "copy" | "move" | "auto" }; result: string[] };
  /**
   * Workspace Actions (docs/39): the ways to run the project in a folder (`path`,
   * else the workspace's root), ranked, described, and their runs. Changes arrive as actions.changed.
   */
  "actions.list": { params: { path?: string; workspaceId?: WorkspaceId }; result: ActionsList };
  /**
   * Run an action in its terminal when that is back at its prompt, else in a new one in the workspace.
   * A server still running isn't started twice: `started` false and its pane. `restart`: ⌃C, then run it again; `fresh`: always a new terminal.
   */
  "actions.run": { params: { root: string; actionId: string; workspaceId?: WorkspaceId; restart?: boolean; fresh?: boolean }; result: { paneId: PaneId; started: boolean } };
  /** ⌃C to an action's running terminal. */
  "actions.stop": { params: { root: string; actionId: string }; result: null };
  /** Pin an action to the top of its folder's list; a command from history or the README is kept as one. */
  "actions.pin": { params: { root: string; actionId: string; pinned: boolean }; result: null };
  /** Git state of the repository a folder is in, limited to that folder; null outside a work tree or without git. */
  "git.status": { params: { path: string }; result: GitStatus | null };
  /** Uncommitted changes under a folder (or one file of it) against HEAD, as a unified diff; null outside a repository. */
  "git.diff": { params: { path: string; file?: string }; result: { root: string; diff: string; truncated: boolean } | null };

  /** A SQLite database's tables, views, indexes and triggers, for the SQLite window. Read-only, never writes. */
  "sqlite.schema": { params: { path: string }; result: SqliteSchema };
  /** A page of a table's or view's rows, sorted and filtered. */
  "sqlite.rows": { params: SqliteRowsQuery; result: SqliteResult };
  /** One read-only SQL statement's rows; a statement that writes, or a second one, is refused. */
  "sqlite.query": { params: SqliteQuery; result: SqliteResult };
  /** Write a whole table or view to a CSV file (blobs as hex, NULL empty). Local only. */
  "sqlite.export": { params: { path: string; table: string; file: string }; result: { rows: number; bytes: number } };

  /** Full-text search over Claude Code / Codex transcripts. */
  "search.query": { params: { text: string; limit?: number }; result: SearchHit[] };
  /**
   * Live search in the files of a workspace's folder: names, then lines (docs/33).
   * The Home workspace's folder is the home folder, too big: there `cwd` (the selected
   * window's folder) picks the project instead. `root`: where it looked, null if nowhere.
   */
  "search.files": { params: { text: string; workspaceId?: WorkspaceId | null; cwd?: string | null; limit?: number; part?: "names" | "lines" }; result: { root: string | null; hits: FileHit[] } };
  /** What happened, by full text: commands (and what they printed), pages and files opened in cmd; newest matches first per kind. */
  "search.history": { params: { text: string; workspaceId?: WorkspaceId | null; limit?: number }; result: HistoryHit[] };
  /** The most recently active past sessions, newest first; `exclude`: session ids to leave out (open ones). */
  "search.status": { params: {}; result: SearchStatus };
  /** Rebuild the transcript index from scratch; progress arrives as search.status events. Fails when search is off. */
  "search.reindex": { params: {}; result: null };
  /** Resume (or fork) a past session in a new pane, typed into the user's shell. */
  /**
   * Shell command that resumes an agent's session from anywhere (cd + env + the
   * agent's resume command), e.g. to copy; null if it has no resumable session.
   */
  "agent.resumeCommand": { params: { agentId: AgentId }; result: string | null };
  "agent.resume": {
    params: Placement & { agent: AgentKind; sessionId: string; cwd?: string | null; env?: Record<string, string> | null; fork?: boolean };
    result: Agent;
  };

  /** Persisted UI state, owned by the UI; the core only stores it. */
  "ui.get": { params: {}; result: Record<string, unknown> };
  /** null deletes the key. Values must be JSON, ≤ 64 KiB. */
  "ui.set": { params: { key: string; value: unknown }; result: null };

  /** Remote access (docs/13-remote-access.md). The Mac manages it; a phone can only call what packages/core/src/remote/policy.ts allows. */
  "remote.status": { params: {}; result: RemoteStatus };
  /** Turn remote access on or off (the remote.enabled setting); off closes every session, paired devices stay. */
  "remote.enable": { params: {}; result: RemoteStatus };
  "remote.disable": { params: {}; result: RemoteStatus };
  /** A one-time pairing link (show it as a QR code); valid for 5 minutes, replaces any earlier one. */
  "remote.pair": { params: { scope?: RemoteScope }; result: { url: string; expiresAt: number } };
  /** Answer a remote.pairRequest. */
  "remote.approve": { params: { requestId: string; allow: boolean; scope?: RemoteScope }; result: null };
  "remote.devices": { params: {}; result: RemoteDevice[] };
  /** Close live sessions (one device's, or all) without unpairing; devices may reconnect. */
  "remote.disconnect": { params: { id?: string }; result: null };
  /** Recent activity, newest first. */
  "remote.log": { params: { limit?: number }; result: RemoteLogEntry[] };
  /** The setup checklist of an access mode (default: remote.access); empty for the relay. */
  "remote.checks": { params: { access?: string }; result: RemoteAccessCheck[] };
  /** "Check Again": publish the current access mode again if it isn't, then its checklist. */
  "remote.setup": { params: {}; result: RemoteAccessCheck[] };
  /** Unpair a device and close its sessions. */
  "remote.revoke": { params: { id: string }; result: null };
  /** Change a device's scope; its sessions reconnect with it. */
  "remote.setScope": { params: { id: string; scope: RemoteScope }; result: RemoteDevice };
  /**
   * What a remote session starts from (instead of events.subscribe): a projection
   * without settings, UI state or secrets. After it the session receives the
   * events the policy lets through.
   */
  "remote.bootstrap": {
    params: {};
    result: {
      panes: Pane[];
      agents: Agent[];
      windows: AppWindow[];
      workspaces: Workspace[];
      windowTypes: WindowTypeInfo[];
      device: { id: string; scope: RemoteScope } | null;
      /** This Mac, as the phone names it ("Jan's MacBook Pro"). */
      host: { name: string };
    };
  };
  /** The windows this connection shows (terminals, Magic): remote sessions get pane.output and magic.data only for these. */
  "window.follow": { params: { ids: WindowId[] }; result: null };

  /** After this call the connection receives `event` notifications. */
  "events.subscribe": {
    /** types: receive only these events (e.g. the Settings window wants settings.updated); omitted = all. */
    params: { types?: CoreEvent["type"][] };
    result: {
      panes: Pane[];
      agents: Agent[];
      /** Non-terminal windows (terminal windows are the panes). */
      windows: AppWindow[];
      /** Open workspaces in switcher order. */
      workspaces: Workspace[];
      windowTypes: WindowTypeInfo[];
      settings: SettingsSnapshot;
      ui: Record<string, unknown>;
    };
  };
}

export type Method = keyof Methods;
export type Params<M extends Method> = Methods[M]["params"];
export type Result<M extends Method> = Methods[M]["result"];

export type CoreEvent =
  | { type: "pane.output"; paneId: PaneId; data: string }
  | { type: "pane.updated"; pane: Pane }
  | { type: "pane.removed"; paneId: PaneId }
  | { type: "agent.updated"; agent: Agent }
  | { type: "agent.removed"; agentId: AgentId }
  | { type: "settings.updated"; snapshot: SettingsSnapshot }
  | { type: "secrets.updated"; status: SecretsStatus }
  | { type: "ai.updated"; status: AiStatus }
  | { type: "search.status"; status: SearchStatus }
  /** The core's startup phase and the jobs still running (every change). */
  | { type: "core.startup"; status: StartupStatus }
  | { type: "window.updated"; window: AppWindow }
  | { type: "window.removed"; id: WindowId }
  | { type: "workspace.updated"; workspace: Workspace }
  | { type: "workspace.removed"; id: WorkspaceId }
  /** Show this workspace (cmd ., ⌘O from elsewhere); the app picks or creates the app window. */
  | { type: "workspace.show"; workspaceId: WorkspaceId; newWindow: boolean }
  /** A Magic widget's run: agent steps, the header, the body so far, done or failed. */
  | { type: "magic.stream"; id: WindowId; progress: MagicProgress }
  /** New data from a Magic widget's source (error: the source failed; the widget keeps its last data). */
  | { type: "magic.data"; id: WindowId; data: unknown; at: number; error?: string }
  /** To the previewer connection only: render these pages offscreen and answer with magic.previewResult. */
  | { type: "magic.previewRequest"; reqId: string; requests: MagicPreviewRequest[] }
  /** The Widget Library changed (a widget made, changed, renamed, deleted, put in or taken out of a workspace). */
  | { type: "widget.library"; entries: WidgetEntry[] }
  /** A folder's Workspace Actions changed: its files, a run, the model's descriptions (actions.list again). */
  | { type: "actions.changed"; root: string }
  /** A watched file or folder changed on disk (see fs.watch). */
  | { type: "fs.changed"; path: string }
  /** Events recorded or updated since the last one, for a data.subscribe subscription (merge by id). */
  | { type: "data.changed"; id: string; events: DataEvent[] }
  /**
   * Rows of a view that changed, for a data.subscribeView subscription (turns by agent and index, sessions by key).
   * reset: the rows are the query's whole result and replace what the subscriber has (the view was rebuilt, workspaces changed).
   */
  | { type: "view.changed"; id: string; view: "turns" | "sessions"; rows: (TurnRow | SessionInfo)[]; reset?: boolean }
  /** Bring a window to the front (e.g. `open .` in a terminal). */
  | { type: "window.focus"; id: WindowId }
  | { type: "notification"; notification: AppNotification }
  | { type: "remote.updated"; status: RemoteStatus }
  /** A browser wants to pair: ask the person on the Mac (remote.approve). */
  | { type: "remote.pairRequest"; request: RemotePairRequest }
  /** A device typed into a terminal (throttled per device and pane), for a brief marker on the Mac. */
  | { type: "remote.input"; deviceId: string; name: string; paneId: PaneId }
  /** Allowed, denied or expired: dismiss the request's sheet. */
  | { type: "remote.pairEnded"; requestId: string }
  /** A remote session dropped output for this pane (it fell behind): fetch a new snapshot. */
  | { type: "pane.resync"; paneId: PaneId };

export interface SearchHit {
  sessionId: string;
  agent: AgentKind;
  path: string;
  /** Environment the agent needs to resume this session (e.g. CLAUDE_CONFIG_DIR for a profile); null = none. */
  env: Record<string, string> | null;
  cwd: string | null;
  branch: string | null;
  title: string;
  updatedAt: number | null;
  /** Matching passage; \x01…\x02 mark highlighted terms. */
  snippet: string | null;
  fuzzy: boolean;
}

/** A file whose path has the words (line null), or a line in it that has the text. */
export interface FileHit {
  path: string;
  /** The folder searched. */
  root: string;
  line: number | null;
  column: number | null;
  /** The line, matches marked \x01…\x02. */
  text: string | null;
}

/** Something that happened, found by its words. */
export type HistoryHit =
  | { kind: "command"; command: string; cwd: string | null; exitCode: number | null; at: number; paneId: PaneId | null; runs: number; snippet: string | null }
  | { kind: "page"; url: string; title: string | null; at: number }
  | { kind: "file"; path: string; at: number };

export interface SearchStatus {
  sessions: number;
  files: number;
  indexing: boolean;
  done: number;
  total: number;
}

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}
export interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}
export interface RpcNotification {
  jsonrpc: "2.0";
  method: "event";
  params: CoreEvent;
}
export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

/** Env vars injected into every pane. */
export const ENV = {
  socket: "CMD_SOCKET",
  paneId: "CMD_PANE_ID",
  agentId: "CMD_AGENT_ID",
  parentId: "CMD_PARENT_ID",
} as const;
