// The core process: owns panes and agents, serves JSON-RPC on a Unix socket.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ActivityExportHeader, Agent, AgentHome, AgentId, AiModel, AiProvider, AppWindow, HookTarget, CoreEvent, Method, Methods, Params, Placement, RemoteScope, Result, Settings, Space, SpaceId, WidgetEntry, WindowId } from "@cmd/protocol";
import { EXPORT_FORMAT, lineSplitter, TURN_FORMAT } from "@cmd/protocol";
import { ipcPath, logger, machineId, recordCrash } from "@cmd/protocol/node";
import { AgentTracker } from "./agents/tracker.ts";
import { ActivityLog } from "./agents/activity/log.ts";
import { rewrite } from "./agents/activity/fixture.ts";
import { AgentHomes } from "./agents/homes.ts";
import { cleanAiBody, NOTICE_SYSTEM, noticeContext, type NoticeKind } from "./agents/notice.ts";
import { hookFiles, hookState, hookTargets, installHooks, removeHooks, setBriefingFlag, writeHookFiles, type HookFiles } from "./agents/hooks.ts";
import { hookEventName } from "./agents/state.ts";
import { NotificationCenter } from "./notifications.ts";
import { CommandLog } from "./commands.ts";
import { TimerAlarms } from "./timers.ts";
import { PaneManager, type Inspector, type PtyFactory } from "./panes.ts";
import { restoreSession } from "./restore.ts";
import type { TermBackend } from "./terminals/types.ts";
import { ProcessSampler, ResourceMonitor, type ProcSampler, type TreeSampler } from "./resources.ts";
import type { SearchService } from "./search/service.ts";
import { registerBuiltinSources } from "./search/builtin.ts";
import { locateContext, TranscriptSources, type LocateContext } from "./search/sources.ts";
import { listDir, parseOverrides, readText, resolvePaths, registerBuiltins, shellOpenEnv, terminalWindow, WindowManager, WindowTypes, writeText } from "./windows/index.ts";
import { WatchService } from "./watch.ts";
import { gitDiff, gitStatus } from "./git.ts";
import { createPath, duplicatePath, renamePath, transferPaths } from "./fileops.ts";
import { Store } from "./store.ts";
import { SettingsService } from "./settings.ts";
import { SpaceManager } from "./spaces/manager.ts";
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
  /** The fork's (legacyStatusRoot()), also read. */
  legacyStatusRoot?: string | null;
  /**
   * Transcript search (runs its own indexing worker) for the current settings and
   * transcript sources; called again when search.* changes. Returns null when search is off.
   */
  search?: ((settings: Settings, sources: TranscriptSources) => SearchService | null) | null;
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

export class Core {
  readonly panes: PaneManager;
  readonly agents: AgentTracker;
  readonly notifications: NotificationCenter;
  readonly commands: CommandLog;
  readonly timers: TimerAlarms;
  readonly store: Store;
  readonly settings: SettingsService;
  readonly resources: ResourceMonitor | null;
  readonly processes: ProcessSampler | null;
  readonly windows: WindowManager;
  readonly windowTypes: WindowTypes;
  /** Where each agent keeps transcripts and how to resume them. */
  readonly transcripts: TranscriptSources;
  readonly spaces: SpaceManager;
  readonly magic: MagicService;
  readonly secrets: SecretsService;
  readonly ai: AiService;
  readonly summaries: SummaryService;
  readonly remote: RemoteService;
  readonly usage: UsageStats;
  /** Agents already counted for usage stats. */
  #countedAgents = new Set<AgentId>();
  #startedAt = Date.now();
  /** cmd's agent hook files, when this core writes them (a state dir and status files). */
  #hooks: HookFiles | null = null;
  /** Where agents keep their config (agents/homes.ts). */
  readonly homes: AgentHomes;
  #homesDiscovered = false;
  #homesTimer: NodeJS.Timeout | undefined;
  #pruneTimer: NodeJS.Timeout | undefined;
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
  /** fs.watch subscriptions per connection, released when it closes. */
  #connWatches = new Map<Connection, string[]>();
  /** Windows each connection shows (window.follow); remote sessions get output only for these. */
  #follows = new Map<Connection, Set<string>>();
  /** Connections that render widget previews (the app's main process), newest last. */
  #previewers: Connection[] = [];
  #previewSeq = 0;
  #previewWaits = new Map<string, { resolve: (s: MagicPreviewShot[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #playwright: Promise<Previewer | null> | null = null;
  #opts: CoreOptions;
  #search: SearchService | null = null;
  #closed = false;
  /** Restarts are chained so two workers never index at once. */
  #searchSwap: Promise<void> = Promise.resolve();
  #searchGen = 0;

  constructor(opts: CoreOptions) {
    this.#opts = opts;
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
    this.settings.bind(["shell.openFolders", "shell.openFiles", "shell.openUrls", "open.handlers"], () => {
      try {
        this.panes.writeShellRules();
      } catch (err) {
        log.error(`could not write shell rules: ${(err as Error).message}`);
      }
    });
    // Every event says which cmd recorded it: the app's version, or the checkout's build.
    const activity = new ActivityLog(this.store.db, { recordedBy: process.env.CMD_APP_VERSION || (opts.build ? `source+${opts.build.slice(0, 8)}` : null) });
    activity.prune();
    this.#pruneTimer = setInterval(() => activity.prune(), 6 * 3600_000);
    this.#pruneTimer.unref();
    this.agents = new AgentTracker(this.panes, {
      store: this.store,
      settings,
      statusRoot: opts.statusRoot ?? null,
      legacyStatusRoot: opts.legacyStatusRoot ?? null,
      sources: this.transcripts,
      activity,
      git: !!opts.stateDir,
    });
    this.homes = new AgentHomes(this.store.db, opts.homesContext ?? locateContext, () => splitList(this.settings.settings["agents.homes"]));
    this.agents.on("activity", (event) => this.#broadcast({ type: "agent.activity", event }));
    this.agents.on("home", (agent, dir) => this.#newHome(this.homes.learn(agent, dir, "hook")));
    this.agents.on("transcript", (agent, file) => {
      const dir = this.homes.homeOfTranscript(agent, file);
      if (dir) this.#newHome(this.homes.learn(agent, dir, "transcript"));
    });
    // Real cores look for agent homes now, again every few hours and when agents.homes changes.
    if (opts.stateDir && opts.statusRoot) {
      setImmediate(() => this.#discoverHomes());
      this.#homesTimer = setInterval(() => this.#discoverHomes(), 6 * 3600_000);
      this.#homesTimer.unref();
      // (bind also runs once now: these wait for the startup discovery instead)
      this.settings.bind(["agents.homes"], () => this.#homesDiscovered && this.#discoverHomes());
      this.settings.bind(["agents.hooks.auto"], () => this.#homesDiscovered && this.#autoHooks());
    }
    this.notifications = new NotificationCenter(this.panes, this.agents, settings, (a, kind, signal) => this.#writeNotice(a, kind, signal));
    this.notifications.on("notification", (notification) => this.#broadcast({ type: "notification", notification }));
    this.notifications.on("cleared", () => this.#broadcast({ type: "notifications.cleared" }));
    this.commands = new CommandLog(this.panes);
    this.commands.on("updated", (run) => this.#broadcast({ type: "command.updated", run }));
    this.resources = opts.sampler ? new ResourceMonitor(this.panes, opts.sampler, 2000, () => this.#subscribers.size > 0) : null;
    this.processes = opts.procSampler ? new ProcessSampler(opts.procSampler) : null;
    this.spaces = new SpaceManager(this.store, opts.home);
    this.spaces.on("updated", (space) => this.#broadcast({ type: "space.updated", space }));
    this.spaces.on("removed", (id) => this.#broadcast({ type: "space.removed", id }));
    this.windows = new WindowManager(this.panes, this.store, this.windowTypes, overrides);
    // Windows of a Space that is gone or closed (e.g. the core died mid-close) go Home.
    for (const w of this.windows.others()) {
      if (this.spaces.get(w.spaceId)?.closedAt !== null) this.windows.move(w.id, this.spaces.home().id);
    }
    this.windows.on("updated", (window) => this.#broadcast({ type: "window.updated", window }));
    this.timers = new TimerAlarms(this.windows, (w, title, body) => this.notifications.window(w.id, "timer", title, body));
    this.windows.on("removed", (id) => {
      this.store.deleteUiStateOf(id);
      this.#broadcast({ type: "window.removed", id });
      this.#libraryChanged();
    });
    this.secrets = new SecretsService(opts.secretsPath ?? null);
    this.secrets.on("updated", (status) => this.#broadcast({ type: "secrets.updated", status }));
    this.ai = new AiService({ settings, secrets: this.secrets, stateDir: opts.stateDir ?? null, listModels: opts.aiListModels });
    this.ai.on("updated", (status) => this.#broadcast({ type: "ai.updated", status }));
    this.settings.bind(["ai.provider", "ai.anthropic.model", "ai.anthropic.fastModel", "ai.openai.model", "ai.openai.fastModel"], () => this.ai.settingsChanged());
    if (opts.stateDir) this.ai.start();
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
      agentTitle: (kind) => this.transcripts.get(kind)?.title ?? kind,
      dir: opts.stateDir ? path.join(opts.stateDir, "summaries") : null,
      show: (file, spaceId) => {
        const open = this.windows.others().find((w) => (w.kind === "markdown" || w.kind === "text") && w.state.path === file);
        if (open) return this.#broadcast({ type: "window.focus", id: open.id }), open.id;
        return this.#opened(this.windows.open("markdown", { path: file }, this.spaces.mustOpen(spaceId))).id;
      },
      notify: (id, title, body) => this.notifications.window(id, "summary", title, body),
    });
    this.magic = new MagicService({
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
      cwdFor: (w) => this.spaces.get(w.spaceId)?.root ?? this.spaces.home().root,
      workspaceFor: (w) => {
        const sp = this.spaces.get(w.spaceId);
        return sp && !sp.home ? { name: sp.name, root: sp.root } : null;
      },
    });
    this.panes.on("request", (paneId, action, arg) => this.#onShellRequest(paneId, action, arg));
    this.watches.on("changed", (path) => this.#broadcast({ type: "fs.changed", path }));
    this.settings.on("updated", (snapshot) => this.#broadcast({ type: "settings.updated", snapshot }));
    if (opts.search) this.settings.bind(["search.enabled", "search.archiveDirs"], () => this.#restartSearch());

    this.panes.on("output", (paneId, data) => this.#broadcast({ type: "pane.output", paneId, data }));
    this.panes.on("updated", (pane) => this.#broadcast({ type: "pane.updated", pane }));
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
      this.#broadcast({ type: "agent.updated", agent });
      this.#countAgent(agent);
      // Hooks report where the transcript is: picks up folders discovery doesn't know.
      if (agent.native.transcriptPath) this.#search?.learn(agent.kind, agent.native.transcriptPath);
    });
    this.agents.on("removed", (agentId) => {
      this.#countedAgents.delete(agentId);
      this.#broadcast({ type: "agent.removed", agentId });
    });
    this.remote = new RemoteService({
      store: this.store,
      settings: this.settings,
      stateDir: opts.stateDir ?? null,
      serve: (conn) => this.serve(conn),
      broadcast: (e) => this.#broadcast(e),
    });
  }

  readonly handlers: Handlers = {
    "core.hello": () => ({ version: VERSION, pid: process.pid, socket: this.#opts.socketPath, build: this.#opts.build ?? "", stateDir: this.#opts.stateDir }),
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
      const space = this.#place(p, { path: p.cwd });
      const pane = this.panes.create({ ...p, cwd: p.cwd ?? space.root, spaceId: space.id });
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
    "notify.list": () => this.notifications.list(),
    "notify.clear": () => (this.notifications.clear(), null),
    "command.list": (p) => this.commands.list(p.spaceId),
    "pane.snapshot": (p) => this.panes.snapshot(p.paneId),
    "pane.read": async (p) => ({ text: await this.panes.read(p.paneId, p.lines) }),
    "pane.reset": async (p) => (await this.panes.resetState(p.paneId), null),
    "agent.list": () => this.agents.list(),
    "agent.spawn": (p) => {
      const space = this.#place(p, { parentId: p.parentId, path: p.cwd });
      const parent = p.parentId ? this.agents.get(p.parentId) : null;
      return this.agents.spawn({ ...p, spaceId: space.id, cwd: p.cwd ?? parent?.cwd ?? space.root });
    },
    "agent.send": async (p) => (await this.agents.send(p.agentId, p.text, p.submit), null),
    "agent.wait": (p) => this.agents.wait(p.agentIds, p.until, p.mode, p.timeoutMs),
    "agent.kill": (p) => ({ killed: this.agents.kill(p.agentId, p.tree) }),
    "agent.markSeen": (p) => (this.agents.markSeen(p.agentId), null),
    "agent.events": (p) => this.agents.activity.events(p),
    "agent.turns": (p) => this.agents.activity.turns(p.agentId, p.limit),
    "agent.summarize": async (p) => {
      const s = await this.summaries.start(p.agentId, { open: p.open });
      return { path: s.path, windowId: s.windowId, markdown: p.wait ? await s.done : null };
    },
    "agents.coverage": (p) => this.agents.activity.coverage(p.days),
    "agents.export": (p) => {
      const log = this.agents.activity;
      const since = Date.now() - (p.days ?? 14) * 86400_000;
      const limit = Math.min(p.limit ?? 2000, 10_000);
      const events = log.events({ since, afterId: p.afterId, limit: limit + 1, raw: true, oldest: true });
      const more = events.length > limit;
      const page = more ? events.slice(0, limit) : events;
      const turns = p.afterId ? [] : log.turnsSince(since);
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
      return this.#openWindow({ ...p, kind: r.kind, input: r.widgetId ? { widgetId: r.widgetId } : {} });
    },
    "widget.rename": (p) => (this.magic.renameWidget(magicRef(p.ref), p.title), null),
    "widget.duplicate": (p) => {
      const id = this.magic.duplicateWidget(magicRef(p.ref));
      return this.#widgets().find((e) => e.ref === `magic:${id}`)!;
    },
    "widget.delete": (p) => (this.magic.deleteWidget(magicRef(p.ref)), null),
    "window.openTarget": (p) =>
      this.#opened(this.windows.openTarget(p.target, this.#place(p, { path: /^[a-z][\w+.-]+:/i.test(p.target) ? undefined : p.target }))),
    "window.move": (p) => this.#moveWindow(p.id, p.spaceId),
    "space.list": (p) => this.spaces.list(p.closed),
    "space.open": (p) => {
      const r = this.spaces.open(p.path, p);
      if (p.show) this.#broadcast({ type: "space.show", spaceId: r.space.id, newWindow: !!p.newWindow });
      return r;
    },
    "space.match": (p) => this.spaces.match(p.path, p.cwd),
    "space.update": (p) => this.spaces.update(p.id, p),
    "space.close": (p) => (this.#closeSpace(p.id), null),
    "space.forget": (p) => (this.spaces.forget(p.id), null),
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
    "git.status": (p) => gitStatus(p.path),
    "git.diff": (p) => gitDiff(p.path, p.file),
    // Connection-aware; handled in #serve. These run for in-process callers.
    "fs.watch": (p) => ({ watching: this.watches.watch(p.path) }),
    "fs.unwatch": (p) => (this.watches.unwatch(p.path), null),
    "search.query": (p) => this.#search?.search(p.text, p.limit) ?? [],
    "search.recent": (p) => this.#search?.recent(Math.min(p.limit ?? 5, 50), p.exclude) ?? [],
    "search.status": () => this.#search?.status() ?? NO_SEARCH,
    "search.reindex": () => {
      if (!this.#search) throw new Error("transcript search is off (search.enabled)");
      this.#search.reindex();
      return null;
    },
    "agent.resumeCommand": (p) => this.agents.resumeCommand(p.agentId),
    "agent.resume": (p) => this.agents.resume({ ...p, spaceId: this.#place(p, { path: p.cwd ?? undefined }).id }),
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
      spaces: this.spaces.list(),
      windowTypes: this.windowTypes.info(),
      device: null,
      host: { name: computerName() },
    }),
    "window.follow": () => null,
    "events.subscribe": () => ({
      panes: this.panes.list(),
      agents: this.agents.list(),
      windows: this.windows.others(),
      spaces: this.spaces.list(),
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
      for (const h of this.homes.discover()) this.#search?.learnHome(h.agent, h.dir);
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
    const res = await this.ai.complete({ tier: "fast", purpose: `notify.${kind}`, system: NOTICE_SYSTEM, prompt: JSON.stringify(noticeContext(a, kind)), effort: "minimal", maxOutputTokens: 800, signal });
    return cleanAiBody(res.value);
  }

  #discoverHomes(): void {
    if (this.#closed) return;
    this.#homesDiscovered = true;
    try {
      for (const h of this.homes.discover()) this.#search?.learnHome(h.agent, h.dir);
    } catch (err) {
      log.error(`looking for agent homes: ${(err as Error).message}`);
    }
    this.#autoHooks();
  }

  /** A home cmd didn't know: its transcripts are indexed, and it may get the hook. */
  #newHome(h: AgentHome | null): void {
    if (!h) return;
    this.#search?.learnHome(h.agent, h.dir);
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
   * (the fork's, `cmd hook`) or a broken one (its script gone). Never over
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

  #restartSearch(): void {
    const gen = ++this.#searchGen;
    this.#searchSwap = this.#searchSwap.then(async () => {
      const old = this.#search;
      this.#search = null;
      await old?.close();
      if (gen !== this.#searchGen || this.#closed) return; // a newer restart replaces this one
      const next = this.#opts.search!(this.settings.settings, this.transcripts);
      this.#search = next;
      for (const h of this.homes.all()) next?.learnHome(h.agent, h.dir);
      next?.on("status", (status) => this.#broadcast({ type: "search.status", status }));
      this.#broadcast({ type: "search.status", status: next?.status() ?? NO_SEARCH });
    });
  }

  /**
   * Where something new goes (see Placement): an explicit Space, the calling
   * pane's, the parent agent's, the open Space whose root most deeply contains
   * the path, else Home.
   */
  #place(p: Placement, o: { parentId?: AgentId | null; path?: string } = {}): Space {
    if (p.spaceId) return this.spaces.mustOpen(p.spaceId);
    const caller = p.callerPaneId ? this.panes.get(p.callerPaneId) : null;
    if (caller) return this.spaces.mustOpen(caller.spaceId);
    const parent = o.parentId ? this.agents.get(o.parentId) : null;
    if (parent) return this.spaces.mustOpen(parent.spaceId);
    return o.path ? this.spaces.match(o.path) : this.spaces.home();
  }

  #moveWindow(id: WindowId, spaceId: SpaceId): AppWindow {
    this.spaces.mustOpen(spaceId);
    const pane = this.panes.get(id);
    if (!pane) return this.windows.move(id, spaceId);
    const agent = pane.agentId ? this.agents.get(pane.agentId) : null;
    if (agent) this.agents.moveTree(agent.id, spaceId);
    else this.panes.setSpace(id, spaceId);
    return terminalWindow(this.panes.get(id)!);
  }

  /** Kill the Space's terminals (their agents go with them) and remove its windows; keep it as a recent Space. */
  #closeSpace(id: SpaceId): void {
    const space = this.spaces.mustOpen(id);
    if (space.home) throw new Error("Home can't be closed");
    for (const p of this.panes.list()) if (p.spaceId === id) this.panes.kill(p.id);
    for (const a of this.agents.list()) if (a.spaceId === id && !a.paneId) this.agents.kill(a.id);
    for (const w of this.windows.inSpace(id)) this.windows.close(w.id);
    this.spaces.markClosed(id);
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
      .filter((t) => t.role === "widget" && t.kind !== "magic")
      .map((t): WidgetEntry => ({ ref: `type:${t.kind}`, source: "builtin", kind: t.kind, title: t.title, description: t.description, icon: t.icon, windows: others.filter((w) => w.kind === t.kind).map((w) => w.id) }));
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

  /** Tell UIs the library changed; changes in a burst (a build, closing a Space) go out once. */
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

  /** Requests from a pane's shell integration, e.g. `open .` → file window in the pane's Space. */
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
      restoreSession({ panes: this.panes, agents: this.agents, spaces: this.spaces, store: this.store, settings: () => this.settings.settings });
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
    }
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
  #serveSocket(sock: net.Socket): void {
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    this.#sockets.add(sock);
    rpcLog.debug("connection opened");
    const served = this.serve({
      access: "local",
      send: (line) => void (sock.writable && sock.write(line)),
      close: () => sock.destroy(),
    });
    sock.on("close", () => {
      this.#sockets.delete(sock);
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
      if (conn.access !== "local") checkRemoteCall(req.method, params, conn.access, this.#policy);
      const result =
        req.method === "pane.fitOverride"
          ? (this.#fitOverride(conn, conn.access === "local" ? "this Mac" : this.remote.nameOf(conn), params), null)
          : await this.call(req.method, params);
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
    return { panes: this.panes, agents: this.agents, spaces: this.spaces, windows: this.windows, home: this.#opts.home };
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
    clearInterval(this.#pruneTimer);
    clearInterval(this.#homesTimer);
    this.agents.close();
    this.usage.close();
    this.ai.dispose();
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
    this.#closed = true;
    this.resources?.close();
    this.timers.close();
    await this.#searchSwap;
    await this.#search?.close();
    this.watches.close();
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
