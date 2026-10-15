// Core API. Transport: newline-delimited JSON-RPC 2.0 over a Unix socket.
// Every method is reachable from the UI, the `cmd` CLI and (later) MCP.

import type { Agent, AgentId, AgentKind, AgentState, AppNotification, AppWindow, ClosedWindow, FileEntry, GitStatus, HookTarget, WorktreeChanges, Pane, PaneId, ProcessStat, RemotePairRequest, RemoteStatus, RemoteTheme, Workspace, WorkspaceId, WidgetEntry, WindowId, WindowTypeInfo } from "./model.ts";
import type { DataClassInfo, DataEvent, DataQuery, DataStats, NewDataEvent, SessionInfo, TurnRow, ViewQuery } from "./events.ts";
import type { SettingKey, Settings } from "./settings.ts";
import type { AiModel, AiStatus } from "./ai.ts";
import type { MagicPackageMethods, MagicPreviewRequest, MagicPreviewShot, MagicProgress, MagicRuntime } from "./magic.ts";
import type { SecretsStatus } from "./secrets.ts";
import type { ActivityEvent, ActivityExportHeader, AgentCoverage, AgentHome, AgentTurn } from "./activity.ts";
import type { JournalMethods } from "./journal.ts";
import type { SqliteQuery, SqliteResult, SqliteRowsQuery, SqliteSchema } from "./sqlite.ts";
import type { ActionsEvent, ActionsMethods } from "./actions.ts";
import type { StatsEvent, StatsMethods } from "./stats.ts";
import type { NowPlayingEvent, NowPlayingMethods } from "./nowplaying.ts";
import type { OperatorEvent, OperatorMethods } from "./operator.ts";
import type { ToolsEvent, ToolsMethods } from "./tools.ts";
import type { PagesEvent, PagesMethods } from "./pages.ts";
import type { ArrangeEvent, ArrangeMethods } from "./arrange.ts";
import type { RemoteMethods } from "./remote.ts";
import type { CoreHello } from "./version.ts";
import type { WidgetHostEvent, WidgetHostMethods } from "./widget-host.ts";

export interface CoreInfo {
  pid: number;
  /** PROTOCOL of the core's build. */
  protocol: number;
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
  /** The last times the core's thread was blocked for a while, newest last (core/src/kernel/scheduler.ts). */
  stalls: Stall[];
}

/** Startup work runs after the socket answers; `tasks` are the jobs still running, in order. */
export interface StartupStatus {
  phase: "starting" | "ready";
  /** Epoch ms the core started. */
  since: number;
  /** `done` of `total` when the job counts its work (scheduler.progress). */
  tasks: { id: string; label: string; done?: number; total?: number }[];
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
  /** Keys in the user's file cmd doesn't know (a typo, or a newer cmd's); `settings.reset` removes one. Absent from older cores. */
  unknown?: string[];
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

/** Every method: the core's own, plus each feature's (declared in its own file, merged here). */
export interface Methods extends JournalMethods, ActionsMethods, RemoteMethods, StatsMethods, NowPlayingMethods, OperatorMethods, ToolsMethods, PagesMethods, ArrangeMethods, WidgetHostMethods, MagicPackageMethods {
  /** What a client asks first: which protocol the core speaks and what it can do (CoreHello). */
  "core.hello": { params: {}; result: CoreHello };
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
  /** Notifications (packages/core/src/notifications/center.ts). */
  "pane.setMuted": { params: { paneId: PaneId; muted: boolean }; result: null };
  "pane.clearAttention": { params: { paneId: PaneId }; result: null };
  /** Looking at a window that isn't a terminal clears its attention marker (state.attention). */
  "window.clearAttention": { params: { id: WindowId }; result: null };
  /** `cmd notify`: from a terminal (paneId) or from anywhere. */
  "notify.send": { params: { paneId?: PaneId | null; title?: string; body: string }; result: null };
  /** Clear the Notifications widget (records notification.clear; the events stay in the log). */
  "notify.clear": { params: {}; result: null };
  /**
   * Terminal state, for re-attaching a view after a UI reload; replay it into a terminal of `cols` x `rows`.
   * `seq`: the pane's output count it shows; pane.output up to it is already in `data` (OutputGate, @cmd/protocol/replay).
   */
  "pane.snapshot": { params: { paneId: PaneId }; result: { data: string; cols: number; rows: number; seq?: number } };
  /** Clear stuck terminal state (modes a crashed program left on). */
  "pane.reset": { params: { paneId: PaneId }; result: null };
  /** Plain-text tail of the pane, as displayed. */
  "pane.read": { params: { paneId: PaneId; lines?: number }; result: { text: string } };
  /**
   * Wait until a terminal shows `text` (on its screen now, or in what it prints next), or, with `prompt`,
   * until it is back at its prompt (OSC 133: the running command ended, or none started within a
   * second and a half). `timeoutMs` defaults to 60 s, at most 10 min. `tail`: the screen's last lines then.
   */
  "pane.waitFor": { params: { paneId: PaneId; text?: string; prompt?: boolean; timeoutMs?: number }; result: { matched: boolean; timedOut: boolean; exitCode: number | null; tail: string } };

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
    /** context: text for the hook to hand the agent (the briefing, `agents.integration`). */
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
  /** Select a window and bring it into view in the app windows showing its workspace (the event window.focus). */
  "window.select": { params: { id: WindowId }; result: null };
  /** Closed windows, newest first (workspaceId: only that workspace's). */
  "window.closed": { params: { workspaceId?: WorkspaceId }; result: ClosedWindow[] };
  /** Reopen a closed window where it was (id: that one, else the workspace's newest); null: nothing to reopen. */
  "window.reopen": { params: { id?: WindowId; workspaceId?: WorkspaceId }; result: AppWindow | null };
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
  /** `present`: whether its app window has the person's focus (focus time stops while it hasn't). */
  "workspace.update": { params: { id: WorkspaceId; name?: string; icon?: string | null; order?: number; view?: Record<string, unknown>; active?: boolean; present?: boolean }; result: Workspace };
  /** Kill its terminals and agents, remove its windows; the workspace stays as a recent one. Home can't be closed. */
  "workspace.close": { params: { id: WorkspaceId }; result: null };
  /** Delete a closed workspace's record. */
  "workspace.forget": { params: { id: WorkspaceId }; result: null };
  /** All windows, terminals included. */
  "window.list": { params: {}; result: AppWindow[] };

  /**
   * Make a widget package from a Magic window's request (docs/56, "Magic on V3"), or the
   * change it asks for. Returns at once; progress arrives as magic.stream events and the
   * result in the window's state (it becomes the package's widget).
   */
  "magic.run": { params: { id: WindowId; prompt: string }; result: null };
  /** Stop a run in progress. */
  "magic.cancel": { params: { id: WindowId }; result: null };
  /**
   * Jam's AI: the new code for a request about the code playing now. `sounds`: what the
   * window has loaded; `history`: the code before each earlier change, newest first (for "undo
   * that"); `failed`: the last attempt and why it didn't play (the window retries).
   */
  "jam.change": {
    params: { code: string; request: string; sounds?: string[]; history?: { code: string; request: string; summary: string }[]; failed?: { code: string; error: string } };
    result: { code: string; summary: string };
  };
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

  /** The Widget Library (docs/16-widgets.md): built-in widgets, then packages' (docs/56). */
  "widget.list": { params: {}; result: WidgetEntry[] };
  /** Put a widget from the library in a workspace (another window showing it, if one already does). */
  /** `cwd`: the folder a built-in widget is about (Live Diff's repository), e.g. the selected terminal's. */
  "widget.add": { params: Placement & { ref: string; cwd?: string }; result: AppWindow };
  /** Delete a package made with Magic (its ref): its windows, folder, versions and the instance's data about it. */
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
  /** Copies a range of a video (s) into a new file beside it; its path. */
  "video.trim": { params: { path: string; start: number; end: number }; result: string };
  /** New empty file or folder in `dir`, named "untitled" / "untitled folder" (then " 2"…); returns its path. */
  "fs.create": { params: { dir: string; kind: "file" | "dir" }; result: string };
  /**
   * Copy or move files and folders into `dir` (drag and drop); "auto" moves on the
   * same disk and copies from another, like Finder. A taken name gets " 2"… Returns where each one ended up.
   */
  "fs.transfer": { params: { paths: string[]; dir: string; op: "copy" | "move" | "auto" }; result: string[] };
  /** Git state of the repository a folder is in, limited to that folder; null outside a work tree or without git. */
  "git.status": { params: { path: string }; result: GitStatus | null };
  /** Uncommitted changes under a folder (or one file of it) against HEAD, as a unified diff; null outside a repository. */
  "git.diff": { params: { path: string; file?: string }; result: { root: string; diff: string; truncated: boolean } | null };
  /**
   * Every checkout of the repository a folder is in that has work going on (the main one, and
   * linked worktrees with a terminal or agent in them or touched in the last day), with what
   * each changed since its base; null outside a repository.
   */
  "git.worktrees": { params: { path: string }; result: { repo: string; mainBranch: string | null; worktrees: WorktreeChanges[] } | null };
  /** A file of a checkout as a whole, at `base` (empty where it didn't exist) and now (empty when gone); binary or too large ones without text. */
  "git.fileVersions": { params: { top: string; file: string; base: string | null }; result: { before: string; after: string; binary: boolean; tooLarge: boolean } };

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

  /** The windows this connection shows (terminals, widgets): remote sessions get pane.output and widget.tree only for these. */
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
  /** `seq`: the pane's output count (UTF-16 units since this core took the pane on) after `data`; older cores leave it out. */
  | { type: "pane.output"; paneId: PaneId; data: string; seq?: number }
  | { type: "pane.updated"; pane: Pane }
  | { type: "pane.removed"; paneId: PaneId }
  | { type: "agent.updated"; agent: Agent }
  | { type: "agent.removed"; agentId: AgentId }
  | { type: "settings.updated"; snapshot: SettingsSnapshot }
  /** The theme.* settings changed: what remote sessions get instead of settings.updated. */
  | { type: "theme.updated"; theme: RemoteTheme }
  | { type: "secrets.updated"; status: SecretsStatus }
  | { type: "ai.updated"; status: AiStatus }
  | { type: "search.status"; status: SearchStatus }
  /** The core's startup phase and the jobs still running (every change). */
  | { type: "core.startup"; status: StartupStatus }
  | { type: "window.updated"; window: AppWindow }
  | { type: "window.removed"; id: WindowId }
  /** The closed windows changed (a window closed, was reopened or fell off the list): window.closed again. */
  | { type: "window.closedChanged" }
  | { type: "workspace.updated"; workspace: Workspace }
  | { type: "workspace.removed"; id: WorkspaceId }
  /** Show this workspace (cmd ., ⌘O from elsewhere); the app picks or creates the app window. */
  | { type: "workspace.show"; workspaceId: WorkspaceId; newWindow: boolean }
  /** A Magic widget's run: agent steps, the header, the body so far, done or failed. */
  | { type: "magic.stream"; id: WindowId; progress: MagicProgress }
  /** To the previewer connection only: draw these trees offscreen and answer with magic.previewResult. */
  | { type: "magic.previewRequest"; reqId: string; requests: MagicPreviewRequest[] }
  /** The Widget Library changed (a widget made, changed, renamed, deleted, put in or taken out of a workspace). */
  | { type: "widget.library"; entries: WidgetEntry[] }
  | ActionsEvent
  | StatsEvent
  | NowPlayingEvent
  | OperatorEvent
  | ToolsEvent
  | PagesEvent
  | ArrangeEvent
  | WidgetHostEvent
  /** A watched file or folder changed on disk (see fs.watch). */
  | { type: "fs.changed"; path: string }
  /**
   * Events recorded or updated since the last one, for a data.subscribe subscription (merge by id).
   * reset: events are the query's whole result and replace what the subscriber has (events were forgotten);
   * removed: the seqs of the forgotten events, when there weren't too many to list;
   * truncated: more changed at once than one message carries (an import, a transcript chunk): events are the
   * query's whole result (reset), and a client that follows every event reads the rest with data.query `after`.
   */
  | { type: "data.changed"; id: string; events: DataEvent[]; reset?: boolean; removed?: number[]; truncated?: boolean }
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
