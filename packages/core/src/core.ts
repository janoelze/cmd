import { randomUUID } from "node:crypto";
// The core process: owns panes and agents, serves JSON-RPC on a Unix socket.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ActivityExportHeader, Agent, AgentHome, AgentId, AiModel, AiProvider, AppWindow, HookTarget, CoreEvent, Method, Methods, Params, Placement, RemoteScope, Result, Settings, Workspace, WorkspaceId, WidgetEntry, WindowId, DataEvent, DataQuery, AppNotification, SessionInfo, TurnRow, ViewQuery } from "@cmd/protocol";
import { EXPORT_FORMAT, lineSplitter, TURN_FORMAT } from "@cmd/protocol";
import { ipcPath, logger, machineId, recordCrash } from "@cmd/protocol/node";
import { AgentTracker, sessionIdOf } from "./agents/tracker.ts";
import { JournalService, SYNC_FRESH_MS } from "./journal/service.ts";
import { JournalStore } from "./journal/store.ts";
import { recordNames, recordNotifications, recordWorkspaces, recordWindows } from "./data/recorders.ts";
import { DataService } from "./data/service.ts";
import { buildContext } from "./ai/context.ts";
import { describeAgent, describePane } from "./data/describe.ts";
import { PaneOutputRecorder } from "./data/sources/pane-output.ts";
import { projectIdOf } from "./data/project.ts";
import { matchesQuery } from "./data/match.ts";
import { WidgetTokens, widgetQuery } from "./data/widgets.ts";
import { ViewsStore } from "./data/views/views.ts";
import { ActivityView } from "./data/views/activity.ts";
import { SessionsView } from "./data/views/sessions.ts";
import { Scheduler } from "./scheduler.ts";
import { SearchView } from "./data/views/search.ts";
import { TranscriptIngest } from "./data/sources/ingest.ts";
import { conversationOf } from "./data/views/conversation.ts";
import { rewrite } from "./agents/activity/fixture.ts";
import { AgentHomes } from "./agents/homes.ts";
import { cleanAiBody, NOTICE_SYSTEM, noticeContext, type NoticeKind } from "./agents/notice.ts";
import { AgentNaming } from "./agents/naming.ts";
import { hookFiles, hookState, hookTargets, installHooks, removeHooks, setBriefingFlag, writeHookFiles, type HookFiles } from "./agents/hooks.ts";
import { hookEventName } from "./agents/state.ts";
import { NotificationCenter } from "./notifications.ts";
import { CommandLog, indexCommandOutput } from "./commands.ts";
import { TimerAlarms } from "./timers.ts";
import { PaneManager, type Inspector, type PtyFactory } from "./panes.ts";
import { restoreSession } from "./restore.ts";
import type { TermBackend } from "./terminals/types.ts";
import { ProcessSampler, ResourceMonitor, type ProcSampler, type TreeSampler } from "./resources.ts";
import { registerBuiltinSources } from "./search/builtin.ts";
import { FileSearch } from "./search/files.ts";
import { checkoutOf } from "./checkout.ts";
import { locateContext, TranscriptSources, type LocateContext, type TranscriptRoot } from "./search/sources.ts";
import { listDir, parseOverrides, readText, resolvePaths, registerBuiltins, shellOpenEnv, terminalWindow, WindowManager, WindowTypes, writeText } from "./windows/index.ts";
import { WatchService } from "./watch.ts";
import { gitDiff, gitStatus } from "./git.ts";
import { SqliteService } from "./sqlite/service.ts";
import { createPath, duplicatePath, renamePath, transferPaths } from "./fileops.ts";
import { Store } from "./store.ts";
import { SettingsService } from "./settings.ts";
import { WorkspaceManager } from "./workspaces/manager.ts";
import { MagicService } from "./magic/service.ts";
import { SecretsService } from "./secrets.ts";
import type { Backend } from "./ai/backends.ts";
import { AiService } from "./ai/service.ts";
import { playwrightPreviewer, type Previewer } from "./widgets/preview.ts";
import type { MagicPreviewRequest, MagicPreviewShot } from "@cmd/protocol";
import type { Connection, Served } from "./connection.ts";
import { checkRemoteCall, RemoteDenied, remoteEventVisible, type PolicyContext } from "./remote/policy.ts";
import { RemoteService } from "./remote/service.ts";
import { SummaryService } from "./summaries/service.ts";
import { UsageStats } from "./usage.ts";
import { changeCode } from "./jam/change.ts";
import type { DevKeys } from "./secrets.ts";
import { ActionsService } from "./actions/service.ts";
import { expandHome } from "./windows/builtin.ts";

export const VERSION = "0.0.1";

const log = logger("core");
const rpcLog = logger("rpc");

export interface CoreOptions {
  socketPath: string;
  /** SQLite file, or null for in-memory (tests). */
  dbPath: string | null;
  /** settings.json, or null for in-memory defaults (tests). */
  settingsPath?: string | null;
  /** API keys (secrets.ts), or null for in-memory (tests). */
  secretsPath?: string | null;
  /** Development builds: API keys from .env for keys not set in Settings (dev-keys.ts). */
  devKeys?: DevKeys;
  /** Where terminals run: the PTY host (main.ts), or a PtyFactory for in-process terminals (tests). */
  terminals: TermBackend | PtyFactory;
  /** A new backend when the PTY host died (its terminals are then resurrected); none: they are lost. */
  reconnectTerminals?: () => Promise<TermBackend>;
  /** How often to check that the socket file is still there (default 2 s). */
  socketCheckMs?: number;
  /** Another core took the PTY host over (this one was cut off from its clients, see main.ts): stop. */
  onReplaced?: () => void;
  pollMs?: number;
  /** Foreground-process lookup (ProcInfo); null falls back to process names. */
  inspector?: Inspector | null;
  /** Process-tree usage sampler (ProcInfo.trees); null disables resource monitoring. */
  sampler?: TreeSampler | null;
  /** Single-process usage sampler (ProcInfo.procs) for the Task Manager; null: no core/PTY host usage. */
  procSampler?: ProcSampler | null;
  /** Hook status directory (statusRoot()); null disables file-based hooks. */
  statusRoot?: string | null;
  /** Read agent transcripts into the log (main.ts). Tests leave it off, or pass `transcriptRoots`. */
  transcripts?: boolean;
  /** Tests: the transcript folders to read (default: TranscriptSources.locate plus search.archiveDirs). */
  transcriptRoots?: (settings: Settings) => TranscriptRoot[];
  /** Tests: read transcripts on this thread instead of in a worker. */
  ingestInline?: boolean;
  /** File that keeps running shells' `open` rules current; null: rules are fixed when a shell starts. */
  shellRulesFile?: string | null;
  /** Source hash this core was started from (see sourceBuildId). */
  build?: string;
  /** The instance's state dir (cmdHome), reported by core.hello. */
  stateDir?: string;
  /** Home's root (default: the user's home folder); tests use a temp dir. */
  home?: string;
  /** Tests: the model backend for Magic widgets (default: from the magic.* settings). */
  magicBackend?: (settings: Settings) => Backend;
  /** Tests: a provider's model list (default: its /v1/models). */
  aiListModels?: (provider: AiProvider, apiKey: string) => Promise<AiModel[]>;
  /** Where usage stats go (usage.ts); none: not counted (tests, development builds). */
  usageUrl?: string | null;
  /** Signs usage batches (the app's, per version); none: sent unsigned, which the server takes from old versions only. */
  usageKey?: string | null;
  /** Tests: who renders widget previews (default: the app's previewer connection, else Playwright). */
  magicPreviewer?: Previewer | null;
  /**
   * Install cmd's hook into agent configs that lack one (agents.hooks.auto). Only
   * the installed app does (main.ts): a development build's script lives in a checkout.
   */
  autoHooks?: boolean;
  /** Where agent homes are looked for (default: locateContext(), the user's home). */
  homesContext?: () => LocateContext;
  /** Tests: the Deno for widgets (default: found on this Mac). */
  magicDeno?: string | null;
}

const NO_SEARCH = { sessions: 0, files: 0, indexing: false, done: 0, total: 0 };

/** ui_state key: agent configs the user removed cmd's hook from. */
const DECLINED_KEY = "core.hooks.declined";

/** A comma-separated setting as a list. */
const splitList = (v: string) => v.split(",").map((d) => d.trim()).filter(Boolean);

type Handlers = { [M in Method]: (params: Params<M>) => Result<M> | Promise<Result<M>> };

/** Whether a view row answers a view query. */
function viewMatches(q: ViewQuery, r: TurnRow | SessionInfo, workspaceOf: (cwd: string | null) => string): boolean {
  if (q.workspaceId && workspaceOf(r.cwd) !== q.workspaceId) return false;
  if ("key" in r) {
    if (q.sessionId && r.key !== q.sessionId) return false;
    if (q.projectId && r.projectId !== q.projectId) return false;
    if (q.since && (r.updated ?? 0) < q.since) return false;
    return true;
  }
  if (q.agentId && r.agentId !== q.agentId) return false;
  if (q.sessionId && `${r.agentKind}:${r.sessionId}` !== q.sessionId) return false;
  if (q.projectId && projectIdOf(r.cwd) !== q.projectId) return false;
  if (q.since && r.startedAt < q.since) return false;
  return true;
}

/** The widgets socket lives beside the main one. */
export const widgetsSocketPath = (socketPath: string) => path.join(path.dirname(socketPath), "widgets.sock");

export class Core {
  readonly panes: PaneManager;
  readonly agents: AgentTracker;
  readonly notifications: NotificationCenter;
  readonly commands: CommandLog;
  readonly timers: TimerAlarms;
  readonly store: Store;
  readonly data: DataService;
  readonly views: ViewsStore;
  /** Background work on a budget, startup jobs and the stall watchdog (scheduler.ts). */
  readonly scheduler: Scheduler;
  /** Per workspace, the pane or window selected there and the focus event that says so (its span ends when the selection moves). */
  #focus = new Map<string, { id: string; eventId: string; at: number }>();
  readonly settings: SettingsService;
  readonly resources: ResourceMonitor | null;
  readonly processes: ProcessSampler | null;
  readonly windows: WindowManager;
  readonly windowTypes: WindowTypes;
  /** Where each agent keeps transcripts and how to resume them. */
  readonly transcripts: TranscriptSources;
  readonly workspaces: WorkspaceManager;
  readonly magic: MagicService;
  readonly secrets: SecretsService;
  readonly ai: AiService;
  readonly summaries: SummaryService;
  readonly naming: AgentNaming;
  readonly journal: JournalService;
  readonly remote: RemoteService;
  readonly usage: UsageStats;
  /** Workspace Actions: how to run the project in a folder (docs/39). */
  readonly actions: ActionsService;
  /** Agents already counted for usage stats. */
  #countedAgents = new Set<AgentId>();
  #startedAt = Date.now();
  /** cmd's agent hook files, when this core writes them (a state dir and status files). */
  #hooks: HookFiles | null = null;
  /** Where agents keep their config (agents/homes.ts). */
  readonly homes: AgentHomes;
  #homesDiscovered = false;
  #homesTimer: NodeJS.Timeout | undefined;
  #workspacesTimer: NodeJS.Timeout | undefined;
  /** Listening servers: one, plus one per time the socket file was put back (the old ones keep their clients). */
  #servers: net.Server[] = [];
  /** Open socket connections, cut on close so a lingering client can't hold it up. */
  #sockets = new Set<net.Socket>();
  /** Inode of the socket file this core created: on close, it removes that file only, not another's. */
  #sockIno: number | null = null;
  #sockCheck: ReturnType<typeof setInterval> | null = null;
  #sockError: string | null = null;
  /** Subscribed connections and which events each wants. */
  #subscribers = new Map<Connection, (e: CoreEvent) => boolean>();
  readonly watches = new WatchService();
  /** SQLite windows' reads, a worker per open database. */
  readonly sqlite = new SqliteService();
  /** fs.watch subscriptions per connection, released when it closes. */
  #connWatches = new Map<Connection, string[]>();
  /** data.subscribe subscriptions per connection: id → query; events that answer one are sent as data.changed, a few at a time. */
  #dataSubs = new Map<Connection, Map<string, DataQuery>>();
  #dataPending = new Map<Connection, Map<string, DataEvent[]>>();
  #dataFlush: ReturnType<typeof setTimeout> | null = null;
  /** data.subscribeView subscriptions per connection, and the changed rows waiting to go (by row key). */
  #viewSubs = new Map<Connection, Map<string, ViewQuery>>();
  #viewPending = new Map<Connection, Map<string, Map<string, TurnRow | SessionInfo>>>();
  #viewFlush: ReturnType<typeof setTimeout> | null = null;
  /** Connections on the widgets socket, and which widget each said it is (null until widget.hello). */
  #widgetConns = new Map<Connection, { widgetId: string; workspaceId: string | null } | null>();
  readonly widgetTokens = new WidgetTokens();
  /** Windows each connection shows (window.follow); remote sessions get output only for these. */
  #follows = new Map<Connection, Set<string>>();
  /** Connections that render widget previews (the app's main process), newest last. */
  #previewers: Connection[] = [];
  #previewSeq = 0;
  #previewWaits = new Map<string, { resolve: (s: MagicPreviewShot[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #playwright: Promise<Previewer | null> | null = null;
  #opts: CoreOptions;
  #ingest: TranscriptIngest | null = null;
  #paneOutput: PaneOutputRecorder;
  readonly sessions: SessionsView;
  #searchView: SearchView;
  #fileSearch: FileSearch;
  #closed = false;
  /** Restarts are chained so two workers never index at once. */
  #searchSwap: Promise<void> = Promise.resolve();
  #searchGen = 0;

  constructor(opts: CoreOptions) {
    this.#opts = opts;
    this.scheduler = new Scheduler({ watchdog: !!opts.stateDir });
    this.scheduler.on("startup", (status) => this.#broadcast({ type: "core.startup", status }));
    this.store = new Store(opts.dbPath ?? ":memory:");
    this.settings = new SettingsService(opts.settingsPath ?? null);
    const settings = () => this.settings.settings;
    // Window types (built-ins now; plugins register more through the same API).
    this.windowTypes = new WindowTypes();
    registerBuiltins(this.windowTypes);
    this.transcripts = registerBuiltinSources(new TranscriptSources());
    const overrides = () => parseOverrides(this.settings.settings["open.handlers"]);
    // cmd's hook script and CLI wrapper for agents, rewritten for this build (agents/hooks.ts).
    if (opts.stateDir && opts.statusRoot) {
      const files = hookFiles(opts.stateDir);
      try {
        writeHookFiles(files);
        this.#hooks = files;
        this.settings.bind(["agents.peers"], () => setBriefingFlag(files, this.settings.settings["agents.peers"]));
      } catch (err) {
        log.error(`could not write the agent hook: ${(err as Error).message}`);
      }
    }
    this.panes = new PaneManager(opts.terminals, {
      binDir: this.#hooks?.bin ?? null,
      socketPath: opts.socketPath,
      pollMs: opts.pollMs,
      settings,
      inspector: opts.inspector ?? null,
      // The shells' `open` learns what cmd can open from the registry.
      shellEnv: () => shellOpenEnv(this.windowTypes, overrides()),
      rulesFile: opts.shellRulesFile ?? null,
      store: this.store,
      historyDir: opts.stateDir ? path.join(opts.stateDir, "history") : null,
    });
    // Developer widgets come and go from the library with their setting.
    this.settings.bind(["widgets.developer"], () => this.#libraryChanged());
    this.settings.bind(["shell.openFolders", "shell.openFiles", "shell.openUrls", "open.handlers"], () => {
      try {
        this.panes.writeShellRules();
      } catch (err) {
        log.error(`could not write shell rules: ${(err as Error).message}`);
      }
    });
    // Every event says which cmd recorded it: the app's version, or the checkout's build.
    // A real core opens the log now and builds new indexes, imports and rebuilds views in start(), once it answers.
    this.data = new DataService({ file: opts.stateDir ? path.join(opts.stateDir, "data", "events.sqlite") : null, recordedBy: process.env.CMD_APP_VERSION || (opts.build ? `source+${opts.build.slice(0, 8)}` : "source"), settings: () => this.settings.settings, deferIndexes: !!opts.stateDir, maintenance: !!opts.stateDir });
    this.views = new ViewsStore(opts.stateDir ? path.join(opts.stateDir, "data", "views.sqlite") : null);
    this.data.on("recorded", (e) => this.#dataChanged([e]));
    this.data.on("batch", (events) => this.#dataChanged(events));
    // Views follow what was forgotten or excluded: rebuilt from what's left.
    this.data.on("removed", ({ types }) => {
      if (types.some((t) => t.startsWith("agent."))) void this.agents.activity.rebuild();
      if (types.some((t) => t.startsWith("transcript."))) void this.sessions.rebuild().then(() => this.#searchView.invalidate());
    });
    const activity = new ActivityView(this.data, this.views, { deferRebuild: !!opts.stateDir, pace: this.scheduler });
    activity.workspaceOf = (paneId) => this.panes.get(paneId)?.workspaceId ?? null;
    this.sessions = new SessionsView(this.views, this.data, { deferRebuild: !!opts.stateDir, pace: this.scheduler });
    this.sessions.onChange((rows) => this.#viewChanged("sessions", rows));
    this.sessions.onReset(() => this.#viewReset((q) => q.view === "sessions"));
    activity.onTurn((t, cwd) => this.#viewChanged("turns", [{ ...t, cwd }]));
    this.#searchView = new SearchView(this.data, this.sessions);
    this.#fileSearch = new FileSearch({ excluded: () => this.data.rules().folders });
    this.agents = new AgentTracker(this.panes, {
      store: this.store,
      settings,
      statusRoot: opts.statusRoot ?? null,
      sources: this.transcripts,
      activity,
      git: !!opts.stateDir,
    });
    this.#paneOutput = new PaneOutputRecorder({ data: this.data, panes: this.panes, activity, paneOf: (id) => this.agents.get(id)?.paneId ?? null });
    this.homes = new AgentHomes(this.store.db, opts.homesContext ?? locateContext, () => splitList(this.settings.settings["agents.homes"]));
    this.agents.on("home", (agent, dir) => this.#newHome(this.homes.learn(agent, dir, "hook")));
    this.agents.on("transcript", (agent, file) => {
      const dir = this.homes.homeOfTranscript(agent, file);
      if (dir) this.#newHome(this.homes.learn(agent, dir, "transcript"));
    });
    // Real cores look for agent homes at start(), again every few hours and when agents.homes changes.
    if (opts.stateDir && opts.statusRoot) {
      this.#homesTimer = setInterval(() => this.#discoverHomes(), 6 * 3600_000);
      this.#homesTimer.unref();
      // (bind also runs once now: these wait for the startup discovery instead)
      this.settings.bind(["agents.homes"], () => this.#homesDiscovered && this.#discoverHomes());
      this.settings.bind(["agents.hooks.auto"], () => this.#homesDiscovered && this.#autoHooks());
    }
    this.notifications = new NotificationCenter(this.panes, this.agents, settings, (a, kind, signal) => this.#writeNotice(a, kind, signal));
    this.notifications.on("notification", (notification) => this.#broadcast({ type: "notification", notification }));
    this.commands = new CommandLog(this.panes, this.data);
    this.resources = opts.sampler ? new ResourceMonitor(this.panes, opts.sampler, 2000, () => this.#subscribers.size > 0) : null;
    this.processes = opts.procSampler ? new ProcessSampler(opts.procSampler) : null;
    this.workspaces = new WorkspaceManager(this.store, opts.home);
    this.workspaces.on("updated", (workspace) => this.#broadcast({ type: "workspace.updated", workspace }));
    this.workspaces.on("removed", (id) => this.#broadcast({ type: "workspace.removed", id }));
    // A workspace opened or closed moves folders between workspaces: live queries by workspace start over.
    let roots = "";
    const rootsChanged = () => {
      const now = this.workspaces.list().map((s) => s.root).sort().join("\n");
      if (now !== roots) (roots = now), this.#viewReset((q) => !!q.workspaceId);
    };
    rootsChanged();
    this.workspaces.on("updated", rootsChanged);
    this.workspaces.on("removed", rootsChanged);
    this.windows = new WindowManager(this.panes, this.store, this.windowTypes, overrides);
    this.notifications.workspaceOf = (paneId, windowId) => (paneId ? this.panes.get(paneId)?.workspaceId : windowId ? this.windows.others().find((w) => w.id === windowId)?.workspaceId : null) ?? null;
    // Windows of a workspace that is gone or closed (e.g. the core died mid-close) go Home.
    for (const w of this.windows.others()) {
      if (this.workspaces.get(w.workspaceId)?.closedAt !== null) this.windows.move(w.id, this.workspaces.home().id);
    }
    this.windows.on("updated", (window) => this.#broadcast({ type: "window.updated", window }));
    this.timers = new TimerAlarms(this.windows, (w, title, body) => this.notifications.window(w.id, "timer", title, body));
    this.windows.on("removed", (id) => {
      this.store.deleteUiStateOf(id);
      this.#broadcast({ type: "window.removed", id });
      this.#libraryChanged();
    });
    this.secrets = new SecretsService(opts.secretsPath ?? null, opts.devKeys);
    this.secrets.on("updated", (status) => this.#broadcast({ type: "secrets.updated", status }));
    this.ai = new AiService({
      settings,
      secrets: this.secrets,
      stateDir: opts.stateDir ?? null,
      listModels: opts.aiListModels,
      // Every model call is a fact: what for, which model, how much; what was sent and what came back as the content.
      onCall: (c) => {
        const at = Date.now() - c.ms;
        const content = c.input !== undefined || c.output !== undefined ? `${c.input ?? ""}\n\n=== output ===\n\n${c.output ?? ""}` : null;
        this.data.record({ id: `ai:${at}:${c.purpose}:${Math.random().toString(36).slice(2, 8)}`, at, until: at + c.ms, type: "ai.call", source: "cmd", text: `${c.purpose} · ${c.model}`, data: { purpose: c.purpose, provider: c.provider, model: c.model, tier: c.tier, ms: c.ms, tokens: { in: c.usage?.input ?? 0, out: c.usage?.output ?? 0 }, ok: c.ok, ...(c.error ? { error: c.error } : {}), ...(c.context ? { context: { budget: c.context.budget, chars: c.context.chars, hash: c.context.hash, parts: c.context.parts, events: c.context.events.slice(0, 500) } } : {}) }, content });
      },
    });
    this.ai.on("updated", (status) => this.#broadcast({ type: "ai.updated", status }));
    this.settings.bind(["ai.provider", "ai.anthropic.model", "ai.anthropic.fastModel", "ai.openai.model", "ai.openai.fastModel"], () => this.ai.settingsChanged());
    if (opts.stateDir) this.ai.start();
    this.naming = new AgentNaming({
      ai: { object: (o) => this.ai.object(o), ready: () => this.ai.status().ready },
      settings: () => this.settings.settings,
      agents: () => this.agents.list(),
      turns: (id) => this.agents.activity.turns(id, 40),
      name: (id, name, why) => this.agents.modelName(id, name, why),
    });
    this.summaries = new SummaryService({
      ai: {
        object: (o) => this.ai.object(o),
        modelName: () => {
          const p = this.ai.provider();
          return p ? (this.ai.status().providers[p].models?.fast.name ?? null) : null;
        },
      },
      agent: (id) => this.agents.get(id),
      turns: (id) => this.agents.activity.turns(id, 500),
      transcript: (a) => (sessionIdOf(a) ? conversationOf(this.data, `${a.kind}:${sessionIdOf(a)}`) : null),
      agentTitle: (kind) => this.transcripts.get(kind)?.title ?? kind,
      dir: opts.stateDir ? path.join(opts.stateDir, "summaries") : null,
      show: (file, workspaceId) => {
        const open = this.windows.others().find((w) => (w.kind === "markdown" || w.kind === "text") && w.state.path === file);
        if (open) return this.#broadcast({ type: "window.focus", id: open.id }), open.id;
        return this.#opened(this.windows.open("markdown", { path: file }, this.workspaces.mustOpen(workspaceId))).id;
      },
      notify: (id, title, body) => this.notifications.window(id, "summary", title, body),
    });
    this.journal = new JournalService({
      store: new JournalStore(this.store.db, { recordedBy: this.agents.activity.recordedBy, data: this.data, turns: (since) => this.agents.activity.turnsSince(since), sessions: (since) => this.sessions.sessionsSince(since) }),
      workspaces: () => this.workspaces.list(),
      agentWorkspace: (id) => this.agents.get(id)?.workspaceId ?? null,
      ai: {
        object: (o) => this.ai.object(o),
        modelName: () => {
          const p = this.ai.provider();
          return p ? (this.ai.status().providers[p].models?.smart.name ?? null) : null;
        },
      },
      pace: this.scheduler,
    });
    recordWindows(this.data, this.windows);
    recordWorkspaces(this.data, this.workspaces);
    recordNotifications(this.data, this.notifications);
    this.magic = new MagicService({
      widgetSocket: path.isAbsolute(opts.socketPath) ? { path: widgetsSocketPath(opts.socketPath), token: (widgetId, workspaceId) => this.widgetTokens.issue({ widgetId, workspaceId }) } : null,
      windows: this.windows,
      settings,
      ai: this.ai,
      broadcast: (e) => this.#broadcast(e),
      notify: (n) => this.notifications.widget(n),
      backend: opts.magicBackend,
      stateDir: opts.stateDir ?? null,
      previewer: () => this.#previewer(),
      deno: opts.magicDeno,
      watched: () => this.#subscribers.size > 0,
      libraryChanged: () => this.#libraryChanged(),
      cwdFor: (w) => this.workspaces.get(w.workspaceId)?.root ?? this.workspaces.home().root,
      workspaceFor: (w) => {
        const sp = this.workspaces.get(w.workspaceId);
        return sp && !sp.home ? { name: sp.name, root: sp.root } : null;
      },
    });
    this.actions = new ActionsService({
      panes: this.panes,
      db: this.store.db,
      commands: (root, since) => {
        const projectId = projectIdOf(root);
        if (!projectId) return [];
        return this.data.query({ types: ["command"], projectId, at: [since, Date.now() + 1], by: "time", order: "desc", limit: 5000 }).flatMap((e) => {
          const d = e.data as { command?: string | null; cwd?: string; exitCode?: number | null };
          return d.command && d.cwd ? [{ command: d.command, cwd: d.cwd, at: e.at, exitCode: d.exitCode ?? null }] : [];
        });
      },
      ai: { object: (o) => this.ai.object(o), ready: () => this.ai.status().ready },
      describeOn: () => this.settings.settings["actions.describe"],
      roots: () => this.windows.list().flatMap((w) => (w.kind === "actions" ? [this.#actionsRoot(w.state.path as string | undefined, w.workspaceId)] : [])),
      agentsIn: (top) => this.agents.list().filter((a) => a.git?.top === top && a.state !== "exited").length,
      agentCommand: (agent) => {
        const v = (this.settings.settings as Record<string, unknown>)[`agents.${agent}.command`];
        return typeof v === "string" && v.trim() ? v.trim() : null;
      },
      createPane: (o) => {
        const pane = this.panes.create({ cwd: o.cwd, command: o.command, workspaceId: this.workspaces.mustOpen(o.workspaceId).id });
        this.usage.window("terminal");
        return pane;
      },
    });
    this.actions.on("changed", (root) => this.#broadcast({ type: "actions.changed", root }));
    // A dev server said where it listens: open it beside its terminal, once, if asked to.
    this.actions.on("url", (paneId, url) => {
      const pane = this.panes.get(paneId);
      if (!pane || !this.settings.settings["actions.openBrowser"]) return;
      if (this.windows.list().some((w) => w.kind === "browser" && w.workspaceId === pane.workspaceId && typeof w.state.url === "string" && w.state.url.startsWith(url.replace(/\/$/, "")))) return;
      this.#opened(this.windows.open("browser", { url }, this.workspaces.mustOpen(pane.workspaceId)));
    });
    this.settings.bind(["actions.describe"], () => this.actions.aiChanged());
    this.ai.on("updated", () => this.actions.aiChanged());
    this.panes.on("request", (paneId, action, arg) => this.#onShellRequest(paneId, action, arg));
    this.watches.on("changed", (path) => this.#broadcast({ type: "fs.changed", path }));
    this.settings.on("updated", (snapshot) => this.#broadcast({ type: "settings.updated", snapshot }));

    this.panes.on("output", (paneId, data) => this.#broadcast({ type: "pane.output", paneId, data }));
    this.panes.on("updated", (pane) => {
      this.#broadcast({ type: "pane.updated", pane });
      describePane(this.data, pane);
    });
    this.panes.on("removed", (paneId) => {
      this.store.deleteUiStateOf(paneId);
      this.#broadcast({ type: "pane.removed", paneId });
    });
    this.usage = new UsageStats({
      url: opts.usageUrl ?? null,
      key: opts.usageKey ?? null,
      enabled: () => this.settings.settings["diagnostics.usageStats"],
      id: machineId,
      version: process.env.CMD_APP_VERSION ?? "source",
    });
    this.agents.on("updated", (agent) => {
      describeAgent(this.data, agent);
      this.naming.updated(agent);
      this.#broadcast({ type: "agent.updated", agent });
      this.#countAgent(agent);
      // Hooks report where the transcript is: picks up folders discovery doesn't know.
      if (agent.native.transcriptPath) this.#ingest?.learn(agent.kind, agent.native.transcriptPath);
    });
    recordNames(this.data, this.agents, this.sessions);
    this.agents.on("removed", (agentId) => {
      this.naming.removed(agentId);
      this.#countedAgents.delete(agentId);
      this.#broadcast({ type: "agent.removed", agentId });
    });
    this.remote = new RemoteService({
      store: this.store,
      audit: {
        record: (kind, deviceId, detail) => this.data.record({ id: `remote:${Date.now()}:${kind}:${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), type: "remote.audit", source: "cmd", deviceId, text: `${kind}${detail ? `: ${detail}` : ""}`, data: { kind, detail } }),
        list: (limit) => this.data.query({ types: ["remote.audit"], by: "time", order: "desc", limit }).map((e) => ({ at: e.at, kind: (e.data as { kind: string }).kind, deviceId: e.deviceId, detail: (e.data as { detail: string | null }).detail })),
      },
      settings: this.settings,
      stateDir: opts.stateDir ?? null,
      serve: (conn) => this.serve(conn),
      broadcast: (e) => this.#broadcast(e),
    });
  }

  #started = false;

  /**
   * What used to run before the socket opened, now behind it (docs/34): each a
   * startup job on the scheduler, in this order, each on its own tick, so the
   * app connects within a second and the UI says what the core is still doing
   * (core.startup). listen() calls it; tests that don't listen call it themselves.
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    const o = this.#opts;
    const s = this.scheduler;
    if (o.stateDir) {
      // One statement per index; a new one reads the whole log (seconds), and shows in the stall log by this name.
      s.startup("indexes", "Preparing the event log", () => this.data.store.ensureIndexes());
      // What older cmds kept in cmd.sqlite comes along once, then its tables go: their readers read the log now.
      s.startup("legacy", "Importing older data", () => {
        this.data.importLegacy(this.store.db);
        this.store.db.exec(`DROP TABLE IF EXISTS agent_events; DROP TABLE IF EXISTS agent_turns; DROP TABLE IF EXISTS journal_events;`);
        this.data.importRemoteLog(this.store.db);
        this.store.db.exec(`DROP TABLE IF EXISTS remote_log;`);
        // The transcript index of cmd ≤ 0.15: the log and the sessions view replace it.
        for (const f of ["search.sqlite", "search.sqlite-wal", "search.sqlite-shm"]) fs.rmSync(path.join(o.stateDir!, f), { force: true });
      });
    }
    // Views whose rules changed: from the log again (after the import, which they read).
    if (this.agents.activity.needsRebuild) s.startup("turns", "Rebuilding agent turns", async () => void (await this.agents.activity.rebuild()));
    if (this.sessions.needsRebuild) s.startup("sessions", "Indexing sessions", () => this.sessions.rebuild().then(() => this.#searchView.invalidate()));
    // Transcripts are read in a worker and recorded here in paced steps; the reading's own progress is search.status.
    if (o.transcripts || o.transcriptRoots) s.startup("transcripts", "Starting the transcript reader", () => void this.settings.bind(["data.record.transcripts", "search.archiveDirs"], () => this.#restartSearch()));
    if (o.stateDir) s.startup("search", "Preparing search", () => this.#searchView.warm());
    // Commands from before their output was searchable: once, from what they printed.
    if (o.stateDir) s.startup("command-output", "Indexing command output", () => void indexCommandOutput(this.data, s).then((n) => n && log.info("command output indexed", { commands: n })));
    if (o.stateDir && o.statusRoot) s.startup("homes", "Looking for agents", () => this.#discoverHomes());
    if (o.stateDir) s.startup("journal", "Starting the journal", () => this.journal.start());
    if (o.stateDir) s.startup("retention", "Scheduling retention", () => this.data.start());
    // Workspaces whose folder was removed (a worktree after its merge) say so.
    if (o.stateDir)
      s.startup("workspaces", "Checking workspaces", () => {
        this.workspaces.check();
        this.#workspacesTimer = setInterval(() => this.workspaces.check(), 30_000);
        this.#workspacesTimer.unref();
      });
    s.ready();
  }

  /**
   * Where a workspace's files are searched: its folder. In the Home workspace (the home
   * folder: too big to search as you type) the folder of `cwd` instead, the
   * selected window's: its repository's top if it's in one, else the folder
   * itself; never the home folder or one above it.
   */
  #searchRoot(workspaceId: WorkspaceId | null, cwd: string | null): string | null {
    const workspace = workspaceId ? this.workspaces.get(workspaceId) : undefined;
    if (workspace && !workspace.home) return workspace.root;
    if (!cwd || !path.isAbsolute(cwd)) return null;
    const at = checkoutOf(cwd)?.top ?? path.resolve(cwd);
    const home = os.homedir();
    return at === home || home.startsWith(at.endsWith(path.sep) ? at : at + path.sep) ? null : at;
  }

  readonly handlers: Handlers = {
    "core.hello": () => ({ version: VERSION, pid: process.pid, socket: this.#opts.socketPath, build: this.#opts.build ?? "", stateDir: this.#opts.stateDir, root: path.resolve(import.meta.dirname, "../../..") }),
    "core.info": async () => {
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();
      return {
        pid: process.pid,
        build: this.#opts.build ?? "",
        root: path.resolve(import.meta.dirname, "../../.."),
        node: process.versions.node,
        startedAt: Date.now() - process.uptime() * 1000,
        rssBytes: mem.rss,
        heapBytes: mem.heapUsed,
        cpuSeconds: (cpu.user + cpu.system) / 1e6,
        panes: this.panes.list().length,
        connections: this.#sockets.size,
        socket: this.#opts.socketPath,
        dbPath: this.#opts.dbPath,
        settingsPath: this.#opts.settingsPath ?? null,
        startup: this.scheduler.status(),
        stalls: this.scheduler.stalls(),
        ptyHost: this.panes.backend.info?.() ?? null,
      };
    },
    "core.processes": async () => {
      const host = this.panes.backend.info?.()?.pid ?? null;
      const stats = (await this.processes?.sample(host ? [process.pid, host] : [process.pid])) ?? new Map();
      return { core: stats.get(process.pid) ?? null, ptyHost: host ? (stats.get(host) ?? null) : null };
    },
    "usage.launch": () => (this.usage.launch(), null),
    "pane.create": (p) => {
      const workspace = this.#place(p, { path: p.cwd });
      const pane = this.panes.create({ ...p, cwd: p.cwd ?? workspace.root, workspaceId: workspace.id });
      this.usage.window("terminal");
      return pane;
    },
    "pane.list": () => this.panes.list(),
    "pane.write": (p) => (this.panes.write(p.paneId, p.data), null),
    "pane.resize": (p) => (this.panes.resize(p.paneId, p.cols, p.rows), null),
    // Connection-aware (the override belongs to the caller); handled in serve. In-process: owned by the core.
    "pane.fitOverride": (p) => (this.#fitOverride(this, "this Mac", p), null),
    "pane.reclaim": (p) => (this.panes.release(p.paneId), null),
    "pane.kill": (p) => (this.panes.kill(p.paneId), null),
    "pane.setMuted": (p) => (this.notifications.setMuted(p.paneId, p.muted), null),
    "pane.clearAttention": (p) => (this.notifications.clearAttention(p.paneId), null),
    "notify.send": (p) => (this.notifications.send(p.paneId ?? null, p.title, p.body), null),
    "notify.clear": () => {
      this.data.record({ id: `notification-clear:${Date.now()}`, at: Date.now(), type: "notification.clear", source: "user", data: {} });
      return null;
    },
    "pane.snapshot": (p) => this.panes.snapshot(p.paneId),
    "pane.read": async (p) => ({ text: await this.panes.read(p.paneId, p.lines) }),
    "pane.reset": async (p) => (await this.panes.resetState(p.paneId), null),
    "agent.list": () => this.agents.list(),
    "agent.spawn": (p) => {
      const workspace = this.#place(p, { parentId: p.parentId, path: p.cwd });
      const parent = p.parentId ? this.agents.get(p.parentId) : null;
      return this.agents.spawn({ ...p, workspaceId: workspace.id, cwd: p.cwd ?? parent?.cwd ?? workspace.root });
    },
    "agent.send": async (p) => (await this.agents.send(p.agentId, p.text, p.submit), null),
    "agent.wait": (p) => this.agents.wait(p.agentIds, p.until, p.mode, p.timeoutMs),
    "agent.kill": (p) => ({ killed: this.agents.kill(p.agentId, p.tree) }),
    "agent.rename": (p) => this.agents.rename(p.agentId, p.name),
    "agent.markSeen": (p) => {
      this.agents.markSeen(p.agentId);
      this.data.record({ id: `look:${p.agentId}:${Date.now()}`, at: Date.now(), type: "user.look", source: "user", agentId: p.agentId, paneId: this.agents.get(p.agentId)?.paneId ?? null, workspaceId: this.agents.get(p.agentId)?.workspaceId ?? null, data: { agentId: p.agentId } });
      return null;
    },
    "agent.summarize": async (p) => {
      const s = await this.summaries.start(p.agentId, { open: p.open });
      return { path: s.path, windowId: s.windowId, markdown: p.wait ? await s.done : null };
    },
    "agents.coverage": (p) => this.agents.activity.coverage(p.days),
    "journal.days": (p) => this.journal.days(journalScope(p), Math.min(p.count ?? 7, 60), p.write),
    "journal.day": async (p) => (await this.journal.sync(p.write === "force" ? 0 : SYNC_FRESH_MS), this.journal.day(journalScope(p), this.journal.dayOf(p.date), p.write)),
    "journal.week": (p) => this.journal.week(journalScope(p), p.date, p.write),
    "journal.history": (p) => this.journal.store.history(journalScope(p), this.journal.dayOf(p.date)),
    "journal.events": (p) => this.journal.store.events(p),
    "journal.threads": async (p) => {
      await this.journal.sync(SYNC_FRESH_MS);
      const t = this.journal.threads(journalScope(p), this.journal.dayOf(p.date));
      return { threads: t.threads, digest: t.digest.text };
    },
    "journal.note": (p) => {
      const pane = p.paneId ? this.panes.get(p.paneId) : undefined;
      const agent = pane?.agentId ? this.agents.get(pane.agentId) : null;
      const session = agent ? (agent.native.claudeSessionId ?? agent.native.codexThreadId ?? null) : null;
      return { id: this.journal.note(p.text, { by: agent ? "agent" : "user", agentSession: session, workspaceId: p.workspaceId ?? pane?.workspaceId ?? null, cwd: pane?.cwd ?? null }) };
    },
    "journal.sync": async () => (await this.journal.sync(), null),
    "data.query": (p) => this.data.query(p.query),
    "data.stats": () => this.data.stats(),
    "data.explain": () => this.data.explain(),
    "data.record": (p) => {
      if (!/^(user\.|note$)/.test(p.event.type)) throw new Error("clients record user actions and notes; the core records the rest");
      const e = this.data.record({ ...p.event, source: p.event.source || "client" });
      return e ? { seq: e.seq } : null;
    },
    "data.import": (p) => ({ imported: this.data.recordAll(p.events) }),
    "data.subscribe": (p) => ({ id: randomUUID(), events: this.data.query(p.query) }),
    "data.view": (p) => this.#viewRows(p.query),
    "data.subscribeView": (p) => ({ id: randomUUID(), rows: this.#viewRows(p.query) }),
    "widget.hello": () => {
      throw new Error("widget.hello is for the widgets socket");
    },
    "data.unsubscribe": () => null,
    "data.forget": (p) => ({ events: this.data.forget(p) }),
    "data.applyRules": async () => ({ events: await this.data.applyRules() }),
    "data.rebuild": async (p) => (p.view === "turns" ? { rows: (await this.agents.activity.rebuild()).turns } : { rows: (await this.sessions.rebuild(), this.sessions.counts().sessions) }),
    "data.entities": (p) => {
      const list = p.id ? [this.data.store.entityOf(p.kind, p.id)].filter((e) => !!e) : this.data.store.entities(p.kind).slice(0, Math.min(p.limit ?? 50, 1000)).map((e) => ({ kind: p.kind, ...e }));
      return list.map((e) => ({ ...e!, links: this.data.store.linksOf(p.kind, e!.id) }));
    },
    "agents.export": (p) => {
      const log = this.agents.activity;
      const since = Date.now() - (p.days ?? 14) * 86400_000;
      const limit = Math.min(p.limit ?? 2000, 10_000);
      const events = log.events({ since, afterId: p.afterId, limit: limit + 1, raw: true, oldest: true });
      const more = events.length > limit;
      const page = more ? events.slice(0, limit) : events;
      const turns = p.afterId ? [] : log.turnsSince(since).map((t) => t.turn);
      const header: ActivityExportHeader = { format: "cmd-agent-activity", version: EXPORT_FORMAT, schema: log.schemaVersion(), turnFormat: TURN_FORMAT, exportedAt: Date.now(), cmd: log.recordedBy, since, anonymized: !!p.anonymize };
      const anon = <T,>(v: T): T => (p.anonymize ? (rewrite(v, [[os.homedir(), "~"]]) as T) : v);
      return { header, turns: anon(turns), events: anon(page), next: more ? page.at(-1)!.id : null };
    },
    "agents.homes": (p) => {
      if (p.rescan || !this.#homesDiscovered) this.#discoverHomes();
      return this.homes.all();
    },
    "hook.ingest": (p) => {
      const event = hookEventName(p.agent, p.event);
      const agentId = this.agents.ingestHook(p.paneId, p.agent, event, p.payload, p.spooled)?.id ?? null;
      const context = agentId ? this.agents.peerBriefing(agentId, event) : null;
      return context ? { agentId, context } : { agentId };
    },
    "hooks.status": () => this.#hookTargets(),
    "hooks.install": (p) => {
      const t = this.#hookTarget(p.file);
      installHooks(t.agent, t.file, this.#hooks!.script);
      this.#setDeclined(t.file, false);
      return this.#hookTargets();
    },
    "hooks.remove": (p) => {
      const t = this.#hookTarget(p.file);
      removeHooks(t.file);
      this.#setDeclined(t.file, true);
      return this.#hookTargets();
    },
    identify: (p) => {
      const pane = this.panes.get(p.paneId);
      return { pane, agent: pane?.agentId ? this.agents.get(pane.agentId) : null };
    },
    "settings.get": () => this.settings.snapshot(),
    "settings.set": (p) => this.settings.set(p.key, p.value),
    "settings.reset": (p) => this.settings.reset(p.key),
    "window.open": (p) => this.#openWindow(p),
    "window.update": (p) => this.windows.update(p.id, p),
    "window.types": () => this.windowTypes.info(),
    "window.close": (p) => (this.windows.close(p.id), null),
    "window.clearAttention": (p) => {
      const w = this.windows.others().find((x) => x.id === p.id);
      if (w?.state.attention) this.windows.update(p.id, { state: { attention: null } });
      return null;
    },
    "window.list": () => this.windows.list(),
    "widget.list": () => this.#widgets(),
    "widget.add": (p) => {
      const r = widgetRef(p.ref);
      if (!r.widgetId && this.windowTypes.get(r.kind)?.role !== "widget") throw new Error(`not a widget: ${p.ref}`);
      return this.#openWindow({ ...p, kind: r.kind, input: r.widgetId ? { widgetId: r.widgetId } : p.cwd ? { cwd: p.cwd } : {} });
    },
    "widget.rename": (p) => (this.magic.renameWidget(magicRef(p.ref), p.title), null),
    "widget.duplicate": (p) => {
      const id = this.magic.duplicateWidget(magicRef(p.ref));
      return this.#widgets().find((e) => e.ref === `magic:${id}`)!;
    },
    "widget.delete": (p) => (this.magic.deleteWidget(magicRef(p.ref)), null),
    "window.openTarget": (p) =>
      this.#opened(this.windows.openTarget(p.target, this.#place(p, { path: /^[a-z][\w+.-]+:/i.test(p.target) ? undefined : p.target }))),
    "window.move": (p) => this.#moveWindow(p.id, p.workspaceId),
    "workspace.list": (p) => this.workspaces.list(p.closed),
    "workspace.open": (p) => {
      const r = this.workspaces.open(p.path, p);
      if (p.show) this.#broadcast({ type: "workspace.show", workspaceId: r.workspace.id, newWindow: !!p.newWindow });
      return r;
    },
    "workspace.match": (p) => this.workspaces.match(p.path, p.cwd),
    "workspace.update": (p) => {
      const sel = p.view?.["selection.pane"];
      if (typeof sel === "string") this.#focused(p.id, sel);
      return this.workspaces.update(p.id, p);
    },
    "workspace.close": (p) => (this.#closeWorkspace(p.id), null),
    "workspace.forget": (p) => (this.workspaces.forget(p.id), null),
    "magic.run": (p) => (this.magic.run(p.id, p.prompt), null),
    "magic.cancel": (p) => (this.magic.cancel(p.id), null),
    "magic.refresh": (p) => (this.magic.refresh(p.id), null),
    "magic.setRefresh": (p) => (this.magic.setRefresh(p.id, p.seconds), null),
    "magic.media": (p) => (this.magic.media(p.id, p.allow), null),
    "magic.widget": (p) => this.magic.widget(p.id),
    "magic.restore": (p) => (this.magic.restore(p.id, p.revision), null),
    "magic.config": (p) => (this.magic.setConfig(p.id, p.values ?? {}), null),
    "magic.secret": (p) => (this.magic.setSecret(p.id, p.key, p.value), null),
    "magic.state": (p) => (this.magic.setState(p.id, p.key, p.value), null),
    "magic.fix": (p) => (this.magic.fix(p.id), null),
    "magic.mute": (p) => (this.magic.setMuted(p.id, p.muted), null),
    "jam.change": (p) => changeCode((o) => this.ai.object(o), p),
    "magic.runtime": () => this.magic.runtime(),
    "magic.installRuntime": () => this.magic.installRuntime(),
    // Connection-aware (#afterCall): the caller becomes a previewer.
    "magic.previewer": () => null,
    "magic.previewResult": (p) => {
      const wait = this.#previewWaits.get(p.reqId);
      if (!wait) return null;
      this.#previewWaits.delete(p.reqId);
      clearTimeout(wait.timer);
      if (p.error || !p.shots) wait.reject(new Error(p.error ?? "no shots"));
      else wait.resolve(p.shots);
      return null;
    },
    "secrets.status": () => this.secrets.status(),
    "secrets.set": (p) => this.secrets.set(p.key, p.value),
    "ai.status": () => this.ai.status(),
    "ai.connect": (p) => this.ai.connect(p.provider, p.key),
    "ai.models": (p) => this.ai.models(p.provider, p.refresh),
    "fs.list": (p) => listDir(p.path),
    "fs.read": (p) => readText(p.path),
    "fs.resolve": (p) => resolvePaths(p.paths, p.cwd),
    "fs.write": (p) => writeText(p.path, p.text, p.expectMtime),
    "fs.rename": (p) => renamePath(p.path, p.name),
    "fs.duplicate": (p) => duplicatePath(p.path),
    "fs.create": (p) => createPath(p.dir, p.kind),
    "fs.transfer": (p) => transferPaths(p.paths, p.dir, p.op),
    "actions.list": (p) => this.actions.list(this.#actionsRoot(p.path, p.workspaceId)),
    "actions.run": (p) => this.actions.run(p.root, p.actionId, this.#place({ workspaceId: p.workspaceId }, { path: p.root }).id, { restart: p.restart, fresh: p.fresh }),
    "actions.stop": (p) => (this.actions.stop(p.root, p.actionId), null),
    "actions.pin": (p) => (this.actions.pin(p.root, p.actionId, p.pinned), null),
    "git.status": (p) => gitStatus(p.path),
    "git.diff": (p) => gitDiff(p.path, p.file),
    "sqlite.schema": (p) => this.sqlite.schema(p.path),
    "sqlite.rows": (p) => this.sqlite.rows(p),
    "sqlite.query": (p) => this.sqlite.query(p),
    "sqlite.export": (p) => this.sqlite.export(p.path, p.table, p.file),
    // Connection-aware; handled in #serve. These run for in-process callers.
    "fs.watch": (p) => ({ watching: this.watches.watch(p.path) }),
    "fs.unwatch": (p) => (this.watches.unwatch(p.path), null),
    "search.query": (p) => this.#searchView.search(p.text, p.limit),
    "search.status": () => this.#ingest?.status() ?? NO_SEARCH,
    "search.files": async (p) => {
      const root = this.#searchRoot(p.workspaceId ?? null, p.cwd ?? null);
      return { root, hits: root ? await this.#fileSearch.search(root, p.text, { limit: p.limit, part: p.part }) : [] };
    },
    "search.history": (p) => this.#searchView.history(p.text, { workspaceId: p.workspaceId ?? null, limit: p.limit }),
    "search.reindex": () => {
      if (!this.#ingest) throw new Error("transcripts are off (Settings → Data)");
      this.#ingest.reindex();
      return null;
    },
    "agent.resumeCommand": (p) => this.agents.resumeCommand(p.agentId),
    "agent.resume": (p) => this.agents.resume({ ...p, workspaceId: this.#place(p, { path: p.cwd ?? undefined }).id }),
    "ui.get": () => this.store.uiState(),
    "ui.set": (p) => {
      if (typeof p.key !== "string" || !p.key || p.key.length > 200) throw new Error("ui.set: invalid key");
      if (JSON.stringify(p.value ?? null).length > 64 * 1024) throw new Error("ui.set: value too large");
      this.store.setUiState(p.key, p.value);
      return null;
    },
    "remote.status": () => this.remote.status(),
    "remote.enable": async () => (this.settings.set("remote.enabled", true), await this.remote.ready(), this.remote.status()),
    "remote.disable": async () => (this.settings.set("remote.enabled", false), await this.remote.ready(), this.remote.status()),
    "remote.pair": (p) => this.remote.pair(p.scope ?? "view"),
    "remote.approve": (p) => (this.remote.approve(p.requestId, p.allow, p.scope), null),
    "remote.devices": () => this.remote.devices(),
    "remote.disconnect": (p) => (this.remote.disconnect(p.id), null),
    "remote.log": (p) => this.remote.log(p.limit),
    "remote.revoke": (p) => (this.remote.revoke(p.id), null),
    "remote.setScope": (p) => this.remote.setScope(p.id, p.scope),
    // Connection-aware (the session's device, follows); handled in serve. These run for in-process callers.
    "remote.bootstrap": () => ({
      panes: this.panes.list(),
      agents: this.agents.list(),
      windows: this.windows.others(),
      workspaces: this.workspaces.list(),
      windowTypes: this.windowTypes.info(),
      device: null,
      host: { name: computerName() },
    }),
    "window.follow": () => null,
    "events.subscribe": () => ({
      panes: this.panes.list(),
      agents: this.agents.list(),
      windows: this.windows.others(),
      workspaces: this.workspaces.list(),
      windowTypes: this.windowTypes.info(),
      settings: this.settings.snapshot(),
      ui: this.store.uiState(),
    }),
  };

  #hookTargets(): HookTarget[] {
    if (!this.#hooks) return [];
    const script = this.#hooks.script;
    if (!this.#homesDiscovered) {
      this.#homesDiscovered = true;
      for (const h of this.homes.discover()) this.#ingest?.learnHome(h.agent, h.dir);
    }
    const declined = this.#declined();
    return hookTargets(this.homes.all()).map((t) => ({ ...t, state: hookState(t.agent, t.file, script), ...(declined.has(t.file) ? { declined: true } : {}) }));
  }

  /** Only the agent configs hooks.status lists can be written. */
  #hookTarget(file: string): HookTarget {
    const t = this.#hookTargets().find((x) => x.file === file);
    if (!t) throw new Error(`not an agent config cmd installs hooks into: ${file}`);
    return t;
  }

  /** An agent notification's body from the fast tier (notifications.ai); null without a provider. */
  async #writeNotice(a: Agent, kind: NoticeKind, signal: AbortSignal): Promise<string | null> {
    if (!this.ai.status().ready) return null;
    const ctx = buildContext({ purpose: `notify.${kind}`, budget: 6000, parts: [{ name: "turn", text: JSON.stringify(noticeContext(a, kind)) }] });
    // A name being decided for this turn goes in the title (the notifier reads it when sending): written meanwhile, within the notifier's wait.
    // The notifier hears the agent's update before the namer does: after a tick, both have.
    await null;
    const named = Promise.race([this.naming.settled(a.id), new Promise((r) => signal.addEventListener("abort", r, { once: true }))]);
    const [res] = await Promise.all([this.ai.complete({ tier: "fast", purpose: `notify.${kind}`, system: NOTICE_SYSTEM, prompt: ctx.text, effort: "minimal", maxOutputTokens: 800, signal, context: ctx.record }), named]);
    return cleanAiBody(res.value);
  }

  #discoverHomes(): void {
    if (this.#closed) return;
    this.#homesDiscovered = true;
    try {
      for (const h of this.homes.discover()) this.#ingest?.learnHome(h.agent, h.dir);
    } catch (err) {
      log.error(`looking for agent homes: ${(err as Error).message}`);
    }
    this.#autoHooks();
  }

  /** A home cmd didn't know: its transcripts are indexed, and it may get the hook. */
  #newHome(h: AgentHome | null): void {
    if (!h) return;
    this.#ingest?.learnHome(h.agent, h.dir);
    if (this.#homesDiscovered) this.#autoHooks();
  }

  /** Configs the user took cmd's hook out of (hooks.remove): automatic installs leave them alone. */
  #declined(): Set<string> {
    const v = this.store.uiState()[DECLINED_KEY];
    return new Set(Array.isArray(v) ? (v as string[]) : []);
  }

  #setDeclined(file: string, on: boolean): void {
    const d = this.#declined();
    if (on) d.add(file);
    else d.delete(file);
    this.store.setUiState(DECLINED_KEY, d.size ? [...d] : null);
  }

  /**
   * Out of the box: cmd's hook in every agent config without one, an old one
   * (`cmd hook`, this cmd's in an older form) or a broken one (its script gone). Never over
   * another live cmd's hook, never into a file the user removed it from, never
   * from a development build (opts.autoHooks).
   */
  #autoHooks(): void {
    if (!this.#opts.autoHooks || !this.#hooks || this.#closed || !this.settings.settings["agents.hooks.auto"]) return;
    const added: string[] = [];
    for (const t of this.#hookTargets()) {
      if (t.declined || (t.state !== "missing" && t.state !== "legacy" && t.state !== "stale")) continue;
      try {
        installHooks(t.agent, t.file, this.#hooks.script);
        log.info(`installed cmd's hook into ${t.file} (was ${t.state})`);
        if (!added.includes(t.title)) added.push(t.title);
      } catch (err) {
        log.error(`could not install cmd's hook into ${t.file}: ${(err as Error).message}`);
      }
    }
    if (added.length) {
      const names = added.length > 1 ? `${added.slice(0, -1).join(", ")} and ${added.at(-1)}` : added[0]!;
      this.notifications.info(`${names} set up`, `${added.length > 1 ? "Their" : "Its"} state shows in cmd now. Change it in Settings → Agents.`);
    }
  }

  /** Reads transcripts for the current settings (folders, on/off); again when they change. */
  #restartSearch(): void {
    const gen = ++this.#searchGen;
    this.#searchSwap = this.#searchSwap.then(async () => {
      const old = this.#ingest;
      this.#ingest = null;
      await old?.close();
      if (gen !== this.#searchGen || this.#closed) return; // a newer restart replaces this one
      const s = this.settings.settings;
      let next: TranscriptIngest | null = null;
      if (s["data.record.transcripts"]) {
        const archives = s["search.archiveDirs"].split(",").map((d) => d.trim()).filter(Boolean);
        const roots = this.#opts.transcriptRoots?.(s) ?? this.transcripts.locate(locateContext(), archives);
        next = new TranscriptIngest({ data: this.data, views: this.views, sessions: this.sessions, sources: this.transcripts, roots, inline: this.#opts.ingestInline, pace: this.scheduler });
        for (const h of this.homes.all()) next.learnHome(h.agent, h.dir);
        next.on("status", (status) => this.#broadcast({ type: "search.status", status }));
        next.on("changed", () => this.#searchView.invalidate());
        next.start();
      }
      this.#ingest = next;
      this.#broadcast({ type: "search.status", status: next?.status() ?? NO_SEARCH });
    });
  }

  /**
   * Where something new goes (see Placement): an explicit workspace, the calling
   * pane's, the parent agent's, the open workspace whose root most deeply contains
   * the path, else Home.
   */
  /** The folder Workspace Actions are for: a path given, else the workspace's root. */
  #actionsRoot(p: string | undefined, workspaceId: WorkspaceId | undefined): string {
    if (p) return path.resolve(expandHome(p));
    return (workspaceId ? this.workspaces.get(workspaceId)?.root : undefined) ?? this.workspaces.home().root;
  }

  #place(p: Placement, o: { parentId?: AgentId | null; path?: string } = {}): Workspace {
    if (p.workspaceId) return this.workspaces.mustOpen(p.workspaceId);
    const caller = p.callerPaneId ? this.panes.get(p.callerPaneId) : null;
    if (caller) return this.workspaces.mustOpen(caller.workspaceId);
    const parent = o.parentId ? this.agents.get(o.parentId) : null;
    if (parent) return this.workspaces.mustOpen(parent.workspaceId);
    return o.path ? this.workspaces.match(o.path) : this.workspaces.home();
  }

  #moveWindow(id: WindowId, workspaceId: WorkspaceId): AppWindow {
    this.workspaces.mustOpen(workspaceId);
    const pane = this.panes.get(id);
    if (!pane) return this.windows.move(id, workspaceId);
    const agent = pane.agentId ? this.agents.get(pane.agentId) : null;
    if (agent) this.agents.moveTree(agent.id, workspaceId);
    else this.panes.setWorkspace(id, workspaceId);
    return terminalWindow(this.panes.get(id)!);
  }

  /** Kill the workspace's terminals (their agents go with them) and remove its windows; keep it as a recent workspace. */
  /** The selection in a workspace moved: the previous focus span ends, a new one starts (user.focus). */
  #focused(workspaceId: string, id: string): void {
    const prev = this.#focus.get(workspaceId);
    const now = Date.now();
    if (prev?.id === id) return;
    if (prev) this.data.record({ id: prev.eventId, at: prev.at, until: now, type: "user.focus", source: "user", workspaceId, ...(this.panes.get(prev.id) ? { paneId: prev.id, data: { paneId: prev.id } } : { windowId: prev.id, data: { windowId: prev.id } }) });
    const eventId = `focus:${workspaceId}:${id}:${now}`;
    const pane = this.panes.get(id);
    this.data.record({ id: eventId, at: now, type: "user.focus", source: "user", workspaceId, ...(pane ? { paneId: id, agentId: pane.agentId, data: { paneId: id } } : { windowId: id, data: { windowId: id } }) });
    this.#focus.set(workspaceId, { id, eventId, at: now });
  }

  #closeWorkspace(id: WorkspaceId): void {
    const workspace = this.workspaces.mustOpen(id);
    if (workspace.home) throw new Error("Home can't be closed");
    for (const p of this.panes.list()) if (p.workspaceId === id) this.panes.kill(p.id);
    for (const a of this.agents.list()) if (a.workspaceId === id && !a.paneId) this.agents.kill(a.id);
    for (const w of this.windows.inWorkspace(id)) this.windows.close(w.id);
    this.workspaces.markClosed(id);
  }

  /** Count a window someone opened (not restored ones) for usage stats. */
  #opened<W extends AppWindow | null>(w: W): W {
    if (w) this.usage.window(w.kind);
    if (w && this.windowTypes.get(w.kind)?.role === "widget") this.#libraryChanged();
    return w;
  }

  #openWindow(p: Params<"window.open">): AppWindow {
    const input = p.input ?? {};
    const at = [input.cwd, input.path].find((v): v is string => typeof v === "string");
    // A Magic window for a widget in the library: only one that exists.
    const widgetId = p.kind === "magic" && typeof input.widgetId === "string" ? input.widgetId : null;
    if (widgetId && !this.magic.library().some((e) => e.id === widgetId)) throw new Error(`no such widget: ${widgetId}`);
    const w = this.windows.open(p.kind, input, this.#place(p, { path: at }));
    if (widgetId) this.magic.opened(w.id);
    return this.#opened(this.windows.others().find((x) => x.id === w.id) ?? w);
  }

  /** The Widget Library: built-in widget types, then widgets made with Magic by last use (docs/16-widgets.md). */
  #widgets(): WidgetEntry[] {
    const others = this.windows.others();
    const builtin = this.windowTypes
      .all()
      .filter((t) => t.role === "widget" && t.kind !== "magic" && (!t.tags?.includes("developer") || this.settings.settings["widgets.developer"]))
      .map((t): WidgetEntry => ({ ref: `type:${t.kind}`, source: "builtin", kind: t.kind, title: t.title, description: t.description, icon: t.icon, ...(t.tags?.length ? { tags: t.tags } : {}), windows: others.filter((w) => w.kind === t.kind).map((w) => w.id) }));
    const magic = this.windowTypes.get("magic")!;
    const yours = this.magic.library().map((e): WidgetEntry => ({
      ref: `magic:${e.id}`,
      source: "yours",
      kind: "magic",
      title: e.title,
      description: e.description,
      icon: magic.icon,
      request: e.history[0],
      shot: e.shot,
      dir: this.magic.store.dir(e.id),
      createdAt: e.createdAt,
      usedAt: e.usedAt,
      windows: e.windows,
    }));
    return [...builtin, ...yours];
  }

  #libraryTimer: ReturnType<typeof setTimeout> | null = null;

  /** Tell UIs the library changed; changes in a burst (a build, closing a workspace) go out once. */
  #libraryChanged(): void {
    if (this.#libraryTimer || !this.#subscribers.size) return;
    this.#libraryTimer = setTimeout(() => {
      this.#libraryTimer = null;
      this.#broadcast({ type: "widget.library", entries: this.#widgets() });
    }, 50);
  }

  /**
   * Count an agent once, when it starts: not subagents, restored ones, or ones
   * that were already running when this core started (re-detected after a restart).
   */
  #countAgent(a: Agent): void {
    if (this.#countedAgents.has(a.id)) return;
    this.#countedAgents.add(a.id);
    if (a.parentId || a.spawn.source === "restored") return;
    const since = a.spawn.source === "detected" && a.paneId ? this.panes.foreground(a.paneId)?.startedAt : undefined;
    if (since && since < this.#startedAt) return; // 0: unknown (no native helper)
    this.usage.agent(a.kind);
  }

  /** Requests from a pane's shell integration, e.g. `open .` → file window in the pane's workspace. */
  #onShellRequest(paneId: string, action: string, arg: string): void {
    if (action !== "open" || !arg) return;
    try {
      const w = this.#opened(this.windows.openTarget(arg, this.#place({ callerPaneId: paneId })));
      if (w) this.#broadcast({ type: "window.focus", id: w.id });
    } catch {
      // not a folder / URL: ignore
    }
  }

  /**
   * Bring back the terminals and agents of the last session (restore.ts): take
   * over those still running, resurrect the rest. At startup, before listen(),
   * and again when the PTY host died.
   */
  restore(): void {
    try {
      restoreSession({ panes: this.panes, agents: this.agents, workspaces: this.workspaces, store: this.store, settings: () => this.settings.settings });
    } catch (err) {
      // A core without its last session still starts (and can update itself).
      log.error("could not restore the last session", err);
    }
    this.#watchBackend();
  }

  #hostRestarts = 0;

  #watchBackend(): void {
    const backend = this.panes.backend;
    backend.onLost?.(() => void this.#backendLost(backend));
    backend.onReplaced?.(() => this.panes.backend === backend && !this.#closed && this.#opts.onReplaced?.());
  }

  /**
   * The PTY host died, and its terminals with it: start a new one and bring them
   * back as after a restart. UIs are disconnected so they reconnect and load the
   * restored terminals afresh, as they do when the core restarts.
   */
  async #backendLost(lost: TermBackend): Promise<void> {
    if (this.#closed || this.panes.backend !== lost) return;
    const reconnect = this.#opts.reconnectTerminals;
    if (!reconnect || ++this.#hostRestarts > 5) {
      log.error(`the PTY host is gone; not starting another (${this.#hostRestarts - 1} restarts so far)`);
      return;
    }
    log.info(`starting a new PTY host (restart ${this.#hostRestarts} of 5) to bring the terminals back`);
    try {
      const next = await reconnect();
      if (this.#closed) return next.dispose();
      this.agents.forget();
      this.panes.replaceBackend(next);
      this.restore();
    } catch (err) {
      log.error(`could not start a new PTY host: ${(err as Error).message}`);
      return;
    }
    for (const s of this.#subscribers.keys()) s.close();
  }

  async call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    const h = this.handlers[method] as (p: Params<M>) => Result<M> | Promise<Result<M>>;
    if (!h) throw new Error(`unknown method: ${method}`);
    return h(params);
  }

  async listen(): Promise<void> {
    await this.#bind();
    this.settings.watch();
    this.start();
    // The socket file can go while we run (removed by hand, a temp-dir cleaner):
    // put it back, or clients find no core and the app starts another.
    if (this.#sockIno !== null) {
      this.#sockCheck = setInterval(() => void this.#checkSocket(), this.#opts.socketCheckMs ?? 2000);
      this.#sockCheck.unref();
    }
  }

  async #bind(): Promise<void> {
    const sock = ipcPath(this.#opts.socketPath);
    // A named pipe (Windows) has no file: nothing to create, clean up or chmod,
    // and listening on a taken pipe fails by itself.
    const isFile = sock === this.#opts.socketPath;
    if (isFile) {
      fs.mkdirSync(path.dirname(sock), { recursive: true });
      await removeStaleSocket(sock);
    }
    // A file socket is bound under a temporary name, then renamed into place:
    // closing a server unlinks the path it was bound to (libuv), and by then
    // that path may be another process's socket. The rename is atomic, too.
    const bindTo = isFile ? path.join(path.dirname(sock), `.${process.pid}-${this.#servers.length}.sock`) : sock;
    if (isFile) fs.rmSync(bindTo, { force: true });
    const server = net.createServer((sock) => this.#serveSocket(sock));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(bindTo, () => resolve());
    });
    this.#servers.push(server);
    if (isFile) {
      fs.chmodSync(bindTo, 0o600);
      fs.renameSync(bindTo, sock);
      this.#sockIno = fs.statSync(sock).ino;
      await this.#bindWidgets();
    }
  }

  #widgetsBound = false;

  /**
   * The widgets socket beside the main one: every connection on it is a widget's
   * data.ts (see #widgetCall). Secondary to the main socket: a core that took
   * the main path takes this one too (renamed over, atomically), and a rebind
   * of the main socket keeps the one already there.
   */
  async #bindWidgets(): Promise<void> {
    const sock = widgetsSocketPath(this.#opts.socketPath);
    if (this.#widgetsBound && fs.existsSync(sock)) return;
    const bindTo = path.join(path.dirname(sock), `.${process.pid}-${this.#servers.length}-w.sock`);
    fs.rmSync(bindTo, { force: true });
    const server = net.createServer((s) => this.#serveSocket(s, true));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(bindTo, () => resolve());
    });
    this.#servers.push(server);
    fs.chmodSync(bindTo, 0o600);
    fs.renameSync(bindTo, sock);
    this.#widgetsBound = true;
  }

  #rebinding = false;

  async #checkSocket(): Promise<void> {
    if (this.#closed || this.#rebinding) return;
    let ino: number | null = null;
    try {
      ino = fs.statSync(this.#opts.socketPath).ino;
    } catch {}
    if (ino === this.#sockIno) return;
    this.#rebinding = true;
    try {
      await this.#bind();
      log.warn(`the socket file was gone or replaced: listening on ${this.#opts.socketPath} again`);
      this.#sockError = null;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== this.#sockError) log.warn(`could not put the socket back: ${msg}`);
      this.#sockError = msg;
    } finally {
      this.#rebinding = false;
    }
  }

  /** A Unix socket client: local access. */
  #serveSocket(sock: net.Socket, widget = false): void {
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    this.#sockets.add(sock);
    rpcLog.debug(widget ? "widget connection opened" : "connection opened");
    const conn: Connection = {
      access: "local",
      send: (line) => void (sock.writable && sock.write(line)),
      close: () => sock.destroy(),
    };
    if (widget) this.#widgetConns.set(conn, null);
    const served = this.serve(conn);
    sock.on("close", () => {
      this.#sockets.delete(sock);
      this.#widgetConns.delete(conn);
      rpcLog.debug("connection closed");
      served.closed();
    });
    sock.on("data", lineSplitter((line) => served.receive(line)));
  }

  /** JSON-RPC over any connection; a remote one is held to remote/policy.ts. */
  serve(conn: Connection): Served {
    return {
      receive: (line) => void this.#receive(conn, line),
      closed: () => {
        this.#previewers = this.#previewers.filter((c) => c !== conn);
        this.panes.releaseAll(conn);
        this.#subscribers.delete(conn);
        this.#follows.delete(conn);
        for (const p of this.#connWatches.get(conn) ?? []) this.watches.unwatch(p);
        this.#connWatches.delete(conn);
        this.#dataSubs.delete(conn);
        this.#dataPending.delete(conn);
        this.#viewSubs.delete(conn);
        this.#viewPending.delete(conn);
      },
    };
  }

  async #receive(conn: Connection, line: string): Promise<void> {
    if (!line.trim()) return;
    let req: { id: number; method: Method; params?: unknown };
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof req !== "object" || req === null) return;
    const reply = (msg: object) => conn.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...msg }) + "\n");
    try {
      const params = (req.params ?? {}) as never;
      // A widget's data.ts: it says which widget it is, then it may read events, nothing else.
      if (this.#widgetConns.has(conn)) {
        reply({ result: this.#widgetCall(conn, req.method, params) });
        return;
      }
      if (conn.access !== "local") checkRemoteCall(req.method, params, conn.access, this.#policy);
      const done = this.scheduler.mark(`rpc ${req.method}`);
      let result;
      try {
        result =
          req.method === "pane.fitOverride"
            ? (this.#fitOverride(conn, conn.access === "local" ? "this Mac" : this.remote.nameOf(conn), params), null)
            : await this.call(req.method, params);
      } finally {
        done();
      }
      this.#afterCall(conn, req.method, params, result);
      reply({ result: result ?? null });
      return;
    } catch (err) {
      if (err instanceof RemoteDenied) {
        this.remote.audit("denied", conn.deviceId ?? null, `${String(req.method)}: ${err.message}`);
        reply({ error: { code: -32001, message: err.message } });
        return;
      }
      // Handlers throw plain Errors for expected failures (a closed pane, a bad
      // path); a TypeError and the like is a bug in the core: report it.
      if (err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError) {
        rpcLog.error(`${req.method} threw`, err);
        recordCrash({ process: "core", kind: `rpc ${req.method}`, message: `${err.name}: ${err.message}`, stack: err.stack ?? null, context: { build: this.#opts.build ?? "" } });
      } else rpcLog.warn(`${req.method} failed: ${(err as Error).message}`);
      reply({ error: { code: -32000, message: (err as Error).message } });
    }
  }

  /** What a widget connection may do (docs/28 §4, S6): identify itself, then query events within the policy. */
  #widgetCall(conn: Connection, method: Method, params: Record<string, unknown>): unknown {
    if (method === "widget.hello") {
      const id = this.widgetTokens.check(String(params.token ?? ""));
      if (!id) throw new Error("unknown or expired widget token");
      this.#widgetConns.set(conn, id);
      return id;
    }
    const who = this.#widgetConns.get(conn);
    if (!who) throw new Error("say widget.hello first");
    if (method === "data.query") return this.data.query(widgetQuery(params.query as DataQuery));
    throw new Error(`widgets may only read events (data.query), not ${String(method)}`);
  }

  /** Per-connection bookkeeping for the connection-aware methods. */
  #afterCall(conn: Connection, method: Method, params: Record<string, unknown>, result: unknown): void {
    // Typing at the Mac takes a terminal back from a device sizing it (not the
    // reports a terminal sends by itself: focus in/out, device attributes, cursor position).
    if (conn.access === "local" && method === "pane.write" && !/^(\x1b\[[\d;?>]*[IOcRn])+$/.test(params.data as string)) {
      this.panes.release(params.paneId as string);
    }
    if (conn.access !== "local") {
      if (method === "pane.write") this.remote.input(conn, params.paneId as string);
      else if (method === "agent.send") {
        const paneId = this.agents.get(params.agentId as string)?.paneId;
        if (paneId) this.remote.input(conn, paneId);
      }
    }
    // Remember per-connection watches so a closed UI doesn't leak them.
    const wp = typeof params.path === "string" ? params.path : null;
    if (method === "fs.watch" && wp && (result as { watching: boolean }).watching) {
      this.#connWatches.set(conn, [...(this.#connWatches.get(conn) ?? []), wp]);
    } else if (method === "fs.unwatch" && wp) {
      const list = this.#connWatches.get(conn) ?? [];
      const i = list.indexOf(wp);
      if (i >= 0) list.splice(i, 1);
    } else if (method === "data.subscribe") {
      const subs = this.#dataSubs.get(conn) ?? new Map<string, DataQuery>();
      subs.set((result as { id: string }).id, params.query as DataQuery);
      this.#dataSubs.set(conn, subs);
    } else if (method === "data.subscribeView") {
      const subs = this.#viewSubs.get(conn) ?? new Map<string, ViewQuery>();
      subs.set((result as { id: string }).id, params.query as ViewQuery);
      this.#viewSubs.set(conn, subs);
    } else if (method === "data.unsubscribe") {
      this.#dataSubs.get(conn)?.delete(params.id as string);
      this.#viewSubs.get(conn)?.delete(params.id as string);
    } else if (method === "window.follow") {
      this.#follows.set(conn, new Set(params.ids as string[]));
      if (conn.access !== "local") this.remote.following(conn, params.ids as string[]);
    } else if (method === "magic.previewer" && conn.access === "local") {
      this.#previewers = [...this.#previewers.filter((c) => c !== conn), conn];
    } else if (method === "events.subscribe") {
      const types = (params as Params<"events.subscribe">).types;
      const set = Array.isArray(types) ? new Set<string>(types) : null;
      this.#subscribers.set(conn, set ? (e) => set.has(e.type) : () => true);
      this.magic.resume();
    } else if (method === "remote.bootstrap") {
      if (conn.deviceId) (result as Result<"remote.bootstrap">).device = { id: conn.deviceId, scope: conn.access as RemoteScope };
      this.#subscribers.set(conn, (e) => remoteEventVisible(e, this.#follows.get(conn) ?? EMPTY, this.#connWatches.get(conn) ?? []));
      this.magic.resume();
    }
  }

  #fitOverride(owner: object, label: string, p: Params<"pane.fitOverride">): void {
    if ("release" in p) this.panes.release(p.paneId, owner);
    else this.panes.override(p.paneId, owner, label, p.cols, p.rows);
  }

  /** What remote/policy.ts checks arguments against. */
  get #policy(): PolicyContext {
    return { panes: this.panes, agents: this.agents, workspaces: this.workspaces, windows: this.windows, home: this.#opts.home };
  }

  /** Widget previews: the app (offscreen Electron windows) when one is connected, else Playwright, else none. */
  async #previewer(): Promise<Previewer | null> {
    if (this.#opts.magicPreviewer !== undefined) return this.#opts.magicPreviewer;
    const conn = this.#previewers.at(-1);
    if (conn) {
      return {
        name: "app",
        render: (requests: MagicPreviewRequest[]) =>
          new Promise<MagicPreviewShot[]>((resolve, reject) => {
            const reqId = String(++this.#previewSeq);
            const timer = setTimeout(() => {
              this.#previewWaits.delete(reqId);
              reject(new Error("the preview took too long"));
            }, 60_000);
            this.#previewWaits.set(reqId, { resolve, reject, timer });
            conn.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "magic.previewRequest", reqId, requests } satisfies CoreEvent }) + "\n");
          }),
      };
    }
    return (this.#playwright ??= playwrightPreviewer());
  }

  /** New or updated events against every subscription; what matches is sent a few at a time, as one data.changed per subscription. */
  #dataChanged(events: DataEvent[]): void {
    if (!this.#dataSubs.size) return;
    const text = (seq: number, expr: string) => this.data.textMatches(seq, expr);
    for (const [conn, subs] of this.#dataSubs) {
      for (const [id, q] of subs) {
        const hits = events.filter((e) => matchesQuery(q, e, text));
        if (!hits.length) continue;
        let pending = this.#dataPending.get(conn);
        if (!pending) this.#dataPending.set(conn, (pending = new Map()));
        const list = pending.get(id);
        if (list) for (const e of hits) list.push(e);
        else pending.set(id, hits);
      }
    }
    if (this.#dataPending.size && !this.#dataFlush) {
      this.#dataFlush = setTimeout(() => {
        this.#dataFlush = null;
        for (const [conn, pending] of this.#dataPending) {
          for (const [id, evs] of pending) {
            const event: CoreEvent = { type: "data.changed", id, events: evs.slice(-500) };
            const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: event }) + "\n";
            if (conn.event) conn.event(event, line);
            else conn.send(line);
          }
        }
        this.#dataPending.clear();
      }, 50);
      this.#dataFlush.unref?.();
    }
  }

  /** A view's rows for a query: turns oldest first, sessions newest first. */
  #viewRows(q: ViewQuery): (TurnRow | SessionInfo)[] {
    const limit = Math.min(q.limit ?? 50, 1000);
    if (q.view === "sessions") return this.sessions.list(q, q.workspaceId ? (r) => this.workspaces.of(r.cwd) === q.workspaceId : undefined);
    const since = q.since ?? Date.now() - 7 * 86400_000;
    const rows = q.agentId && !q.since ? this.agents.activity.turns(q.agentId, limit).map((t) => ({ ...t, cwd: null })) : this.agents.activity.turnsSince(since).map(({ turn, cwd }) => ({ ...turn, cwd }));
    return rows.filter((r) => viewMatches(q, r, (cwd) => this.workspaces.of(cwd))).slice(-limit);
  }

  /** A changed view row against every view subscription; what matches goes out in one view.changed per subscription. */
  #viewChanged(view: "turns" | "sessions", rows: (TurnRow | SessionInfo)[]): void {
    if (!this.#viewSubs.size) return;
    for (const [conn, subs] of this.#viewSubs) {
      for (const [id, q] of subs) {
        if (q.view !== view) continue;
        for (const r of rows) {
          if (!viewMatches(q, r, (cwd) => this.workspaces.of(cwd))) continue;
          let pending = this.#viewPending.get(conn);
          if (!pending) this.#viewPending.set(conn, (pending = new Map()));
          let m = pending.get(id);
          if (!m) pending.set(id, (m = new Map()));
          m.set("key" in r ? r.key : `${r.agentId}#${r.index}`, r);
        }
      }
    }
    if (this.#viewPending.size && !this.#viewFlush) {
      this.#viewFlush = setTimeout(() => {
        this.#viewFlush = null;
        for (const [conn, pending] of this.#viewPending) {
          for (const [id, m] of pending) {
            const q = this.#viewSubs.get(conn)?.get(id);
            if (!q) continue;
            this.#sendEvent(conn, { type: "view.changed", id, view: q.view, rows: [...m.values()] });
          }
        }
        this.#viewPending.clear();
      }, 50);
      this.#viewFlush.unref?.();
    }
  }

  /** The view subscriptions `pick` names get their query's whole result again, replacing theirs (view.changed with reset). */
  #viewReset(pick: (q: ViewQuery) => boolean): void {
    for (const [conn, subs] of this.#viewSubs) {
      for (const [id, q] of subs) {
        if (!pick(q)) continue;
        this.#viewPending.get(conn)?.delete(id);
        this.#sendEvent(conn, { type: "view.changed", id, view: q.view, rows: this.#viewRows(q), reset: true });
      }
    }
  }

  #sendEvent(conn: Connection, event: CoreEvent): void {
    const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: event }) + "\n";
    if (conn.event) conn.event(event, line);
    else conn.send(line);
  }

  #broadcast(event: CoreEvent): void {
    if (this.#subscribers.size === 0) return;
    const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: event }) + "\n";
    for (const [c, wants] of this.#subscribers) {
      if (!wants(event)) continue;
      if (c.event) c.event(event, line);
      else c.send(line);
    }
  }

  async close(): Promise<void> {
    if (this.#libraryTimer) clearTimeout(this.#libraryTimer);
    clearInterval(this.#homesTimer);
    clearInterval(this.#workspacesTimer);
    this.scheduler.dispose(); // a startup job still running fails on the closed stores, quietly
    this.agents.close();
    this.usage.close();
    this.ai.dispose();
    this.journal.dispose();
    // The transcript reader first: its worker's last batches must not land on closed stores.
    this.#closed = true;
    this.#paneOutput.dispose();
    if (this.#dataFlush) clearTimeout(this.#dataFlush);
    if (this.#viewFlush) clearTimeout(this.#viewFlush);
    await this.#searchSwap;
    await this.#ingest?.close();
    this.data.dispose();
    this.views.close();
    await this.usage.flush();
    this.magic.dispose();
    this.remote.close();
    await this.panes.shutdown();
    for (const s of this.#subscribers.keys()) s.close();
    if (this.#sockCheck) clearInterval(this.#sockCheck);
    const closed = Promise.all(this.#servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    for (const s of this.#sockets) s.destroy();
    await closed;
    // Leave a socket file this core didn't create be (another process's, on the same path).
    try {
      if (this.#sockIno !== null && fs.statSync(this.#opts.socketPath).ino === this.#sockIno) fs.unlinkSync(this.#opts.socketPath);
    } catch {}
    this.resources?.close();
    this.timers.close();
    this.actions.dispose();
    this.watches.close();
    this.sqlite.close();
    this.agents.close();
    this.store.close();
    this.settings.close();
  }
}

const EMPTY: ReadonlySet<string> = new Set();

let hostName: string | null = null;
/** The Mac's name as set in System Settings ("Jan's MacBook Pro"), else the host name. */
function computerName(): string {
  if (hostName) return hostName;
  try {
    if (process.platform === "darwin") hostName = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim();
  } catch {}
  return (hostName ||= os.hostname().replace(/\.local$/, ""));
}

/** Refuse to start if another core is alive on this socket; remove it if stale. */
async function removeStaleSocket(sock: string): Promise<void> {
  if (!fs.existsSync(sock)) return;
  const alive = await new Promise<boolean>((resolve) => {
    const c = net.createConnection(sock);
    c.once("connect", () => (c.destroy(), resolve(true)));
    c.once("error", () => resolve(false));
  });
  if (alive) throw new Error(`a core is already running on ${sock}`);
  fs.unlinkSync(sock);
}

export type { Methods };

/** A Widget Library ref: "magic:<widget id>" (made with Magic) or "type:<kind>" (a built-in widget). */
function widgetRef(ref: string): { kind: string; widgetId?: string } {
  const m = /^(magic|type):([\w-]+)$/.exec(ref);
  if (!m) throw new Error(`not a widget: ${ref}`);
  return m[1] === "magic" ? { kind: "magic", widgetId: m[2] } : { kind: m[2]! };
}

function magicRef(ref: string): string {
  const r = widgetRef(ref);
  if (!r.widgetId) throw new Error(`built-in widgets can't be renamed, duplicated or deleted: ${ref}`);
  return r.widgetId;
}

/** A journal method's scope: a workspace, else the one asked for, else everything. */
function journalScope(p: { workspaceId?: WorkspaceId; scope?: string }): string {
  return p.workspaceId ? `workspace:${p.workspaceId}` : (p.scope ?? "all");
}
