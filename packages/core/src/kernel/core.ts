// The core process: owns panes and agents, serves JSON-RPC on a Unix socket. This file is the
// composition root: it makes every service in dependency order (each wired by its own
// createX(ctx), context.ts), merges every folder's handlers (handlers.ts in each), runs the
// startup jobs and closes everything in order. What a service does lives in its folder.

import fs from "node:fs";
import path from "node:path";
import { PROTOCOL, RpcError, UNKNOWN_METHOD, type AgentId, type AiModel, type AiProvider, type AppWindow, type Method, type Methods, type Params, type Placement, type Result, type Settings, type Workspace } from "@cmd/protocol";
import { logger, machineId } from "@cmd/protocol/node";
import { createActions } from "../actions/feature.ts";
import type { ActionsService } from "../actions/service.ts";
import { createHomes, type AgentHomes } from "../agents/homes.ts";
import { createNaming, type AgentNaming } from "../agents/naming.ts";
import { AgentSetup, writeAgentHooks } from "../agents/setup.ts";
import { createAgents, watchAgents, type AgentTracker } from "../agents/tracker.ts";
import type { Backend } from "../ai/backends.ts";
import { createAi, type AiService } from "../ai/service.ts";
import { removeOldBackups } from "../data/migrations.ts";
import { recordNames, recordNotifications, recordWorkspaces, recordWindows } from "../data/recorders.ts";
import { DataService } from "../data/service.ts";
import { createPaneOutput, type PaneOutputRecorder } from "../data/sources/pane-output.ts";
import { createSubscriptions, resetOnRoots, type Subscriptions } from "../data/subscriptions.ts";
import { ActivityView } from "../data/views/activity.ts";
import { SessionsView } from "../data/views/sessions.ts";
import { ViewsStore } from "../data/views/views.ts";
import { WidgetTokens } from "../data/widgets.ts";
import type { JournalService } from "../journal/service.ts";
import { createJournal } from "../journal/feature.ts";
import { createWatches } from "../lib/watch.ts";
import { createMagic, type MagicService } from "../magic/service.ts";
import { createNotifications, type NotificationCenter } from "../notifications/center.ts";
import { createRemote, type RemoteService } from "../remote/service.ts";
import { registerBuiltinSources } from "../search/builtin.ts";
import { Search } from "../search/search.ts";
import { locateContext, TranscriptSources, type LocateContext, type TranscriptRoot } from "../search/sources.ts";
import { SqliteService } from "../sqlite/service.ts";
import { createSummaries, type SummaryService } from "../summaries/service.ts";
import { CommandLog, indexCommandOutput } from "../terminals/commands.ts";
import { createPanes, watchPanes, type Inspector, type PaneManager, type PtyFactory } from "../terminals/panes.ts";
import { ProcessSampler, ResourceMonitor, type ProcSampler, type TreeSampler } from "../terminals/resources.ts";
import { restoreSession } from "../terminals/restore.ts";
import type { TermBackend } from "../terminals/types.ts";
import { WidgetLibrary } from "../widgets/library.ts";
import type { Previewer } from "../widgets/preview.ts";
import { PreviewBroker } from "../widgets/previews.ts";
import { createClosed } from "../windows/closed.ts";
import { registerBuiltins, WindowTypes, type ClosedWindows, type WindowManager } from "../windows/index.ts";
import { createWindows } from "../windows/manager.ts";
import { WindowOps } from "../windows/ops.ts";
import { createTimers, type TimerAlarms } from "../windows/timers.ts";
import { createWorkspaces, type WorkspaceManager } from "../workspaces/manager.ts";
import type { Connection, Served } from "./connection.ts";
import { contextOf, type CoreContext } from "./context.ts";
import { ALL, createStats, featureHandlers } from "./features.ts";
import { sliceHandlers } from "./slices.ts";
import { IN_CORE, type Call, type Handlers } from "./handlers.ts";
import { coreHello } from "./hello.ts";
import { createScheduler, type Scheduler } from "./scheduler.ts";
import { createSecrets, type DevKeys, type SecretsService } from "./secrets.ts";
import { CoreServer, widgetsSocketPath, type ServerOptions } from "./server.ts";
import { createSettings, type SettingsService } from "./settings.ts";
import { Store } from "./store.ts";
import { createUsage, type UsageStats } from "./usage.ts";

export { SOCKET_PATH_MAX, widgetsSocketPath } from "./server.ts";
export type { Methods };

const log = logger("core");

/** socketCheckMs, onHomeGone: the server's (server.ts). */
export interface CoreOptions extends Pick<ServerOptions, "socketCheckMs" | "onHomeGone"> {
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
  /** Tests: what downloads Deno (default: installDeno). */
  magicInstallDeno?: (stateDir: string) => Promise<string>;
}

export class Core {
  /** What services and features get (context.ts). */
  readonly #ctx: CoreContext = contextOf(this, {
    broadcast: (e) => this.server.broadcast(e),
    place: (p, o) => this.#place(p, o),
    opened: (w) => this.#opened(w),
    watched: () => this.server.watched(),
    serve: (conn) => this.server.serve(conn), call: (m, p) => this.call(m, p),
  });

  readonly server: CoreServer;
  readonly scheduler: Scheduler;
  readonly store: Store;
  readonly settings: SettingsService;
  readonly usage: UsageStats;
  readonly windowTypes: WindowTypes;
  /** Where each agent keeps transcripts and how to resume them. */
  readonly transcripts: TranscriptSources;
  readonly panes: PaneManager;
  readonly data: DataService;
  readonly views: ViewsStore;
  readonly sessions: SessionsView;
  readonly search: Search;
  readonly agents: AgentTracker;
  /** Where agents keep their config (agents/homes.ts). */
  readonly homes: AgentHomes;
  readonly agentSetup: AgentSetup;
  readonly notifications: NotificationCenter;
  readonly commands: CommandLog;
  readonly resources: ResourceMonitor | null;
  readonly processes: ProcessSampler | null;
  readonly workspaces: WorkspaceManager;
  readonly subscriptions: Subscriptions;
  readonly windows: WindowManager;
  readonly windowOps: WindowOps;
  readonly timers: TimerAlarms;
  readonly closed: ClosedWindows;
  readonly secrets: SecretsService;
  readonly ai: AiService;
  readonly naming: AgentNaming;
  readonly summaries: SummaryService;
  readonly journal: JournalService;
  readonly library: WidgetLibrary;
  readonly previews: PreviewBroker;
  readonly magic: MagicService;
  /** Workspace Actions: how to run the project in a folder (docs/39). */
  readonly actions: ActionsService;
  readonly remote: RemoteService;
  readonly watches = createWatches(this.#ctx);
  /** SQLite windows' reads, a worker per open database. */
  readonly sqlite = new SqliteService();
  readonly widgetTokens = new WidgetTokens();
  readonly stats = createStats(this.#ctx);
  #opts: CoreOptions;
  #paneOutput: PaneOutputRecorder;
  #workspacesTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(opts: CoreOptions) {
    this.#opts = opts;
    const ctx = this.#ctx;
    const state = opts.stateDir ?? null;
    // First: everything below may tell clients something.
    this.server = new CoreServer(ctx, { socketPath: opts.socketPath, socketCheckMs: opts.socketCheckMs, onHomeGone: opts.onHomeGone, build: opts.build, dispatch: (m, p, call) => this.call(m, p as never, call), policy: () => this.#policy() });
    this.scheduler = createScheduler(ctx, { watchdog: !!state });
    this.store = new Store(opts.dbPath ?? ":memory:");
    this.settings = createSettings(ctx, opts.settingsPath ?? null);
    // Before anything that counts (windows, terminals, agents): services may use it from their first call.
    this.usage = createUsage(ctx, { url: opts.usageUrl ?? null, key: opts.usageKey ?? null, id: machineId, version: process.env.CMD_APP_VERSION ?? "source" });
    // Window types (built-ins now; plugins register more through the same API).
    this.windowTypes = new WindowTypes();
    registerBuiltins(this.windowTypes);
    this.transcripts = registerBuiltinSources(new TranscriptSources());
    const hooks = state && opts.statusRoot ? writeAgentHooks(ctx, state) : null;
    this.panes = createPanes(ctx, opts.terminals, { binDir: hooks?.bin ?? null, socketPath: opts.socketPath, pollMs: opts.pollMs, inspector: opts.inspector ?? null, rulesFile: opts.shellRulesFile ?? null, historyDir: state ? path.join(state, "history") : null });
    this.server.onClosed((conn) => this.panes.releaseAll(conn));
    // Every event says which cmd recorded it: the app's version, or the checkout's build.
    // A real core opens the log now (an older one is migrated first: data/migrations.ts) and imports and rebuilds views in start(), once it answers.
    this.data = this.scheduler.unwatched(() => new DataService({ file: state ? path.join(state, "data", "events.sqlite") : null, recordedBy: process.env.CMD_APP_VERSION || (opts.build ? `source+${opts.build.slice(0, 8)}` : "source"), settings: () => this.settings.settings, maintenance: !!state }));
    this.views = new ViewsStore(state ? path.join(state, "data", "views.sqlite") : null);
    const activity = new ActivityView(this.data, this.views, { deferRebuild: !!state, pace: this.scheduler, workspaceOf: (paneId) => this.panes.get(paneId)?.workspaceId ?? null });
    this.sessions = new SessionsView(this.views, this.data, { deferRebuild: !!state, pace: this.scheduler });
    this.search = new Search(ctx, { transcriptRoots: opts.transcriptRoots, ingestInline: opts.ingestInline });
    this.agents = createAgents(ctx, { statusRoot: opts.statusRoot ?? null, activity, git: !!state });
    this.#paneOutput = createPaneOutput(ctx, activity);
    this.homes = createHomes(ctx, opts.homesContext ?? locateContext);
    this.agentSetup = new AgentSetup(ctx, hooks, { auto: !!opts.autoHooks, rediscover: !!(state && opts.statusRoot) });
    this.notifications = createNotifications(ctx);
    this.commands = new CommandLog(this.panes, this.data);
    this.resources = opts.sampler ? new ResourceMonitor(this.panes, opts.sampler, 2000, ctx.watched) : null;
    this.processes = opts.procSampler ? new ProcessSampler(opts.procSampler) : null;
    this.workspaces = createWorkspaces(ctx, opts.home);
    this.subscriptions = createSubscriptions(ctx, activity);
    resetOnRoots(ctx);
    this.windows = createWindows(ctx);
    this.windowOps = new WindowOps(ctx);
    this.windowOps.homeless();
    this.timers = createTimers(ctx);
    this.closed = createClosed(ctx);
    this.windowOps.watchWindows();
    this.secrets = createSecrets(ctx, opts.secretsPath ?? null, opts.devKeys);
    this.ai = createAi(ctx, { stateDir: state, listModels: opts.aiListModels });
    if (state) this.ai.start();
    this.naming = createNaming(ctx);
    this.summaries = createSummaries(ctx, state ? path.join(state, "summaries") : null);
    this.journal = createJournal(ctx);
    recordWindows(this.data, this.windows);
    recordWorkspaces(this.data, this.workspaces);
    recordNotifications(this.data, this.notifications);
    this.library = new WidgetLibrary(ctx, { stateDir: state, socket: path.isAbsolute(opts.socketPath) ? widgetsSocketPath(opts.socketPath) : null });
    this.previews = new PreviewBroker(opts.magicPreviewer);
    this.server.onClosed((conn) => this.previews.closed(conn));
    this.magic = createMagic(ctx, { widgetSocket: path.isAbsolute(opts.socketPath) ? widgetsSocketPath(opts.socketPath) : null, backend: opts.magicBackend, stateDir: state, deno: opts.magicDeno, installDeno: opts.magicInstallDeno });
    this.actions = createActions(ctx);
    // What clients and the log hear about terminals and agents, after the services above took a change in.
    this.windowOps.watchShells();
    watchPanes(ctx);
    this.windowOps.watchTerminals();
    watchAgents(ctx, Date.now());
    recordNames(this.data, this.agents, this.sessions);
    this.remote = createRemote(ctx, state);
  }

  readonly handlers: Handlers = {
    "core.hello": (_p, { conn } = IN_CORE) => coreHello(this.handlers, this.#opts, conn),
    "core.info": async () => {
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();
      return {
        pid: process.pid, protocol: PROTOCOL,
        build: this.#opts.build ?? "",
        root: path.resolve(import.meta.dirname, "../../../.."),
        node: process.versions.node,
        startedAt: Date.now() - process.uptime() * 1000,
        rssBytes: mem.rss,
        heapBytes: mem.heapUsed,
        cpuSeconds: (cpu.user + cpu.system) / 1e6,
        panes: this.panes.list().length,
        connections: this.server.connections,
        socket: this.#opts.socketPath,
        dbPath: this.#opts.dbPath,
        settingsPath: this.#opts.settingsPath ?? null,
        startup: this.scheduler.status(),
        stalls: this.scheduler.stalls(),
        ptyHost: this.panes.backend.info?.() ?? null,
      };
    },
    "events.subscribe": (p, { conn } = IN_CORE) => {
      const state = { panes: this.panes.list(), agents: this.agents.list(), windows: this.windows.others(), workspaces: this.workspaces.list(), windowTypes: this.windowTypes.info(), settings: this.settings.snapshot(), ui: this.store.uiState() };
      if (conn) {
        const types = Array.isArray(p.types) ? new Set<string>(p.types) : null;
        if (!this.server.watched()) this.resources?.soon(); // samples aren't taken while nobody watches
        this.server.subscribe(conn, types ? (e) => types.has(e.type) : () => true);
        this.magic.resume();
      }
      return state;
    },
    ...sliceHandlers(this.#ctx),
    ...featureHandlers(this.#ctx),
  };

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
      // What older cmds kept in cmd.sqlite comes along once, then its tables go: their readers read the log now.
      s.startup("legacy", "Bringing over older data", () => {
        this.data.importLegacy(this.store.db);
        this.store.db.exec(`DROP TABLE IF EXISTS agent_events; DROP TABLE IF EXISTS agent_turns; DROP TABLE IF EXISTS journal_events;`);
        this.data.importRemoteLog(this.store.db);
        this.store.db.exec(`DROP TABLE IF EXISTS remote_log;`);
        // The transcript index of cmd ≤ 0.15: the log and the sessions view replace it.
        for (const f of ["search.sqlite", "search.sqlite-wal", "search.sqlite-shm"]) fs.rmSync(path.join(o.stateDir!, f), { force: true });
      });
    }
    // Views whose rules changed: from the log again (after the import, which they read).
    if (this.agents.activity.needsRebuild) s.startup("turns", "Catching up on agent turns", async () => void (await this.agents.activity.rebuild((done, total) => s.progress("turns", done, total))));
    if (this.sessions.needsRebuild) s.startup("sessions", "Indexing sessions", () => this.sessions.rebuild((done, total) => s.progress("sessions", done, total)).then(() => this.search.view.invalidate()));
    // Transcripts are read in a worker and recorded here in paced steps; the reading's own progress is search.status.
    if (o.transcripts || o.transcriptRoots) s.startup("transcripts", "Reading agent sessions", () => void this.settings.bind(["data.record.transcripts", "search.archiveDirs"], () => this.search.restart()));
    if (o.stateDir) s.startup("search", "Warming up search", () => this.search.view.warm());
    // Commands from before their output was searchable: once, from what they printed.
    if (o.stateDir) s.startup("command-output", "Reading command output", () => void indexCommandOutput(this.data, s).then((n) => n && log.info("command output indexed", { commands: n })));
    if (o.stateDir && o.statusRoot) s.startup("homes", "Looking for agents", () => this.agentSetup.discover());
    if (o.stateDir) s.startup("retention", "Planning cleanup", () => this.data.start());
    // The event log's copy aside from a migration is the way back for a week (migrations.ts), then it goes.
    if (o.stateDir) s.startup("log-backups", "Removing old backups", () => void removeOldBackups(path.join(o.stateDir!, "data", "events.sqlite")));
    // Workspaces whose folder was removed (a worktree after its merge) say so.
    if (o.stateDir)
      s.startup("workspaces", "Checking workspaces", () => {
        this.workspaces.check();
        this.#workspacesTimer = setInterval(() => this.workspaces.check(), 30_000);
        this.#workspacesTimer.unref();
      });
    // Last, the jobs that wait for long work (the stats build, the full-text index): retention mustn't queue behind them.
    if (o.stateDir) for (const f of ALL) if (f.startup) s.startup(f.id, f.startup.label, () => f.startup!.run(this.#ctx));
    // A full-text index older than fts.ts's format: built again beside it in paced steps, the old one serving meanwhile.
    if (o.stateDir && this.data.store.needsFtsRebuild) s.startup("fts", "Building the search index", () => this.search.rebuildFts());
    s.ready();
  }

  /**
   * Where something new goes (see Placement): an explicit workspace, the calling
   * pane's, the parent agent's, the open workspace whose root most deeply contains
   * the path, else Home.
   */
  #place(p: Placement, o: { parentId?: AgentId | null; path?: string } = {}): Workspace {
    if (p.workspaceId) return this.workspaces.mustOpen(p.workspaceId);
    const caller = p.callerPaneId ? this.panes.get(p.callerPaneId) : null;
    if (caller) return this.workspaces.mustOpen(caller.workspaceId);
    const parent = o.parentId ? this.agents.get(o.parentId) : null;
    if (parent) return this.workspaces.mustOpen(parent.workspaceId);
    return o.path ? this.workspaces.match(o.path) : this.workspaces.home();
  }

  /** Count a window someone opened (not restored ones) for usage stats; a widget changes the library. */
  #opened<W extends AppWindow | null>(w: W): W {
    if (w) this.usage.window(w.kind);
    if (w && this.windowTypes.get(w.kind)?.role === "widget") this.library.changed();
    return w;
  }

  /** What remote/policy.ts checks arguments against: agent homes and transcript folders are private. */
  #policy() {
    const priv = () => [...this.homes.all().map((h) => h.dir), ...this.search.roots().map((r) => r.dir)];
    return { panes: this.panes, agents: this.agents, workspaces: this.workspaces, windows: this.windows, windowTypes: this.windowTypes, home: this.#opts.home, private: priv };
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
    const backend = this.panes.backend;
    backend.onLost?.(() => void this.#backendLost(backend));
    backend.onReplaced?.(() => this.panes.backend === backend && !this.#closed && this.#opts.onReplaced?.());
  }

  #hostRestarts = 0;

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
    this.server.disconnectAll();
  }

  /** A method, as a caller inside the core (or the server, for a connection) calls it. */
  async call<M extends Method>(method: M, params: Params<M>, call: Call = IN_CORE): Promise<Result<M>> {
    const h = this.handlers[method] as (p: Params<M>, call: Call) => Result<M> | Promise<Result<M>>;
    if (!h) throw new RpcError(UNKNOWN_METHOD, `unknown method: ${method}`);
    return h(params, call);
  }

  /** JSON-RPC over a connection (a remote session's, remote/service.ts). */
  serve(conn: Connection): Served {
    return this.server.serve(conn);
  }

  async listen(): Promise<void> {
    await this.server.listen();
    this.settings.watch();
    this.start();
  }

  async close(): Promise<void> {
    this.library.dispose();
    this.agentSetup.dispose();
    clearInterval(this.#workspacesTimer);
    this.scheduler.dispose(); // a startup job still running fails on the closed stores, quietly
    this.agents.close();
    this.usage.close();
    this.ai.dispose();
    for (const f of ALL) f.dispose?.(this.#ctx);
    this.#closed = true;
    this.#paneOutput.dispose();
    this.subscriptions.dispose();
    // The transcript reader first: its worker's last batches must not land on closed stores.
    await this.search.close();
    this.data.dispose();
    this.views.close();
    await this.usage.flush();
    this.magic.dispose();
    this.remote.close();
    await this.panes.shutdown();
    await this.server.close();
    this.resources?.close();
    this.watches.close();
    this.sqlite.close();
    this.store.close();
    this.settings.close();
  }
}
