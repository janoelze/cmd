// The core process: owns panes and agents, serves JSON-RPC on a Unix socket.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { AgentId, AppWindow, CoreEvent, Method, Methods, Params, Placement, Result, Settings, Space, SpaceId, WindowId } from "@cmd/protocol";
import { lineSplitter } from "@cmd/protocol";
import { AgentTracker } from "./agents/tracker.ts";
import { NotificationCenter } from "./notifications.ts";
import { PaneManager, type Inspector, type PtyFactory } from "./panes.ts";
import { ResourceMonitor, type TreeSampler } from "./resources.ts";
import type { SearchService } from "./search/service.ts";
import { listDir, parseOverrides, readText, registerBuiltins, shellOpenEnv, terminalWindow, WindowManager, WindowTypes, writeText } from "./windows/index.ts";
import { WatchService } from "./watch.ts";
import { Store } from "./store.ts";
import { SettingsService } from "./settings.ts";
import { SpaceManager } from "./spaces/manager.ts";
import { MagicService } from "./magic/service.ts";
import type { Backend } from "./magic/backends.ts";

export const VERSION = "0.0.1";

export interface CoreOptions {
  socketPath: string;
  /** SQLite file, or null for in-memory (tests). */
  dbPath: string | null;
  /** settings.json, or null for in-memory defaults (tests). */
  settingsPath?: string | null;
  ptyFactory: PtyFactory;
  pollMs?: number;
  /** Foreground-process lookup (ProcInfo); null falls back to process names. */
  inspector?: Inspector | null;
  /** Process-tree usage sampler (ProcInfo.trees); null disables resource monitoring. */
  sampler?: TreeSampler | null;
  /** Hook status directory (statusRoot()); null disables file-based hooks. */
  statusRoot?: string | null;
  /**
   * Transcript search (runs its own indexing worker) for the current settings;
   * called again when search.* changes. Returns null when search is off.
   */
  search?: ((settings: Settings) => SearchService | null) | null;
  /** File that keeps running shells' `open` rules current; null: rules are fixed when a shell starts. */
  shellRulesFile?: string | null;
  /** Source hash this core was started from (see sourceBuildId). */
  build?: string;
  /** Home's root (default: the user's home folder); tests use a temp dir. */
  home?: string;
  /** Tests: the model backend for Magic windows (default: from the magic.* settings). */
  magicBackend?: (settings: Settings) => Backend;
}

const NO_SEARCH = { sessions: 0, files: 0, indexing: false, done: 0, total: 0 };

type Handlers = { [M in Method]: (params: Params<M>) => Result<M> | Promise<Result<M>> };

export class Core {
  readonly panes: PaneManager;
  readonly agents: AgentTracker;
  readonly notifications: NotificationCenter;
  readonly store: Store;
  readonly settings: SettingsService;
  readonly resources: ResourceMonitor | null;
  readonly windows: WindowManager;
  readonly windowTypes: WindowTypes;
  readonly spaces: SpaceManager;
  readonly magic: MagicService;
  #server: net.Server | null = null;
  /** Subscribed connections and the event types they want (null = all). */
  #subscribers = new Map<net.Socket, Set<string> | null>();
  readonly watches = new WatchService();
  /** fs.watch subscriptions per connection, released when it closes. */
  #connWatches = new Map<net.Socket, string[]>();
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
    const overrides = () => parseOverrides(this.settings.settings["open.handlers"]);
    this.panes = new PaneManager(opts.ptyFactory, {
      socketPath: opts.socketPath,
      pollMs: opts.pollMs,
      settings,
      inspector: opts.inspector ?? null,
      // The zsh `open` function learns what cmd can open from the registry.
      shellEnv: () => shellOpenEnv(this.windowTypes, overrides()),
      rulesFile: opts.shellRulesFile ?? null,
    });
    this.settings.bind(["shell.openFolders", "shell.openFiles", "shell.openUrls", "open.handlers"], () => {
      try {
        this.panes.writeShellRules();
      } catch (err) {
        console.error(`cmd core: could not write shell rules: ${(err as Error).message}`);
      }
    });
    this.agents = new AgentTracker(this.panes, { store: this.store, settings, statusRoot: opts.statusRoot ?? null });
    this.notifications = new NotificationCenter(this.panes, this.agents, settings);
    this.notifications.on("notification", (notification) => this.#broadcast({ type: "notification", notification }));
    this.resources = opts.sampler ? new ResourceMonitor(this.panes, opts.sampler) : null;
    this.spaces = new SpaceManager(this.store, opts.home);
    this.spaces.on("updated", (space) => this.#broadcast({ type: "space.updated", space }));
    this.spaces.on("removed", (id) => this.#broadcast({ type: "space.removed", id }));
    this.windows = new WindowManager(this.panes, this.store, this.windowTypes, overrides);
    // Windows of a Space that is gone or closed (e.g. the core died mid-close) go Home.
    for (const w of this.windows.others()) {
      if (this.spaces.get(w.spaceId)?.closedAt !== null) this.windows.move(w.id, this.spaces.home().id);
    }
    this.windows.on("updated", (window) => this.#broadcast({ type: "window.updated", window }));
    this.windows.on("removed", (id) => this.#broadcast({ type: "window.removed", id }));
    this.magic = new MagicService({ windows: this.windows, settings, broadcast: (e) => this.#broadcast(e), backend: opts.magicBackend, cwdFor: (w) => this.spaces.get(w.spaceId)?.root ?? this.spaces.home().root });
    this.panes.on("request", (paneId, action, arg) => this.#onShellRequest(paneId, action, arg));
    this.watches.on("changed", (path) => this.#broadcast({ type: "fs.changed", path }));
    this.settings.on("updated", (snapshot) => this.#broadcast({ type: "settings.updated", snapshot }));
    if (opts.search) this.settings.bind(["search.enabled", "search.archiveDirs"], () => this.#restartSearch());

    this.panes.on("output", (paneId, data) => this.#broadcast({ type: "pane.output", paneId, data }));
    this.panes.on("updated", (pane) => this.#broadcast({ type: "pane.updated", pane }));
    this.panes.on("removed", (paneId) => this.#broadcast({ type: "pane.removed", paneId }));
    this.agents.on("updated", (agent) => this.#broadcast({ type: "agent.updated", agent }));
    this.agents.on("removed", (agentId) => this.#broadcast({ type: "agent.removed", agentId }));
  }

  readonly handlers: Handlers = {
    "core.hello": () => ({ version: VERSION, pid: process.pid, socket: this.#opts.socketPath, build: this.#opts.build ?? "" }),
    "pane.create": (p) => {
      const space = this.#place(p, { path: p.cwd });
      return this.panes.create({ ...p, cwd: p.cwd ?? space.root, spaceId: space.id });
    },
    "pane.list": () => this.panes.list(),
    "pane.write": (p) => (this.panes.write(p.paneId, p.data), null),
    "pane.resize": (p) => (this.panes.resize(p.paneId, p.cols, p.rows), null),
    "pane.kill": (p) => (this.panes.kill(p.paneId), null),
    "pane.setMuted": (p) => (this.notifications.setMuted(p.paneId, p.muted), null),
    "pane.clearAttention": (p) => (this.notifications.clearAttention(p.paneId), null),
    "notify.send": (p) => (this.notifications.send(p.paneId ?? null, p.title, p.body), null),
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
    "hook.ingest": (p) => ({
      agentId: this.agents.ingestHook(p.paneId, p.agent, p.event, p.payload)?.id ?? null,
    }),
    identify: (p) => {
      const pane = this.panes.get(p.paneId);
      return { pane, agent: pane?.agentId ? this.agents.get(pane.agentId) : null };
    },
    "settings.get": () => this.settings.snapshot(),
    "settings.set": (p) => this.settings.set(p.key, p.value),
    "settings.reset": (p) => this.settings.reset(p.key),
    "window.open": (p) => {
      const input = p.input ?? {};
      const at = [input.cwd, input.path].find((v): v is string => typeof v === "string");
      return this.windows.open(p.kind, input, this.#place(p, { path: at }));
    },
    "window.update": (p) => this.windows.update(p.id, p),
    "window.types": () => this.windowTypes.info(),
    "window.close": (p) => (this.windows.close(p.id), null),
    "window.list": () => this.windows.list(),
    "window.openTarget": (p) =>
      this.windows.openTarget(p.target, this.#place(p, { path: /^[a-z][\w+.-]+:/i.test(p.target) ? undefined : p.target })),
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
    "magic.media": (p) => (this.magic.media(p.id, p.allow), null),
    "fs.list": (p) => listDir(p.path),
    "fs.read": (p) => readText(p.path),
    "fs.write": (p) => writeText(p.path, p.text, p.expectMtime),
    // Connection-aware; handled in #serve. These run for in-process callers.
    "fs.watch": (p) => ({ watching: this.watches.watch(p.path) }),
    "fs.unwatch": (p) => (this.watches.unwatch(p.path), null),
    "search.query": (p) => this.#search?.search(p.text, p.limit) ?? [],
    "search.recent": (p) => this.#search?.recent(Math.min(p.limit ?? 5, 50), p.exclude) ?? [],
    "search.status": () => this.#search?.status() ?? NO_SEARCH,
    "agent.resume": (p) => this.agents.resume({ ...p, spaceId: this.#place(p, { path: p.cwd ?? undefined }).id }),
    "ui.get": () => this.store.uiState(),
    "ui.set": (p) => {
      if (typeof p.key !== "string" || !p.key || p.key.length > 200) throw new Error("ui.set: invalid key");
      if (JSON.stringify(p.value ?? null).length > 64 * 1024) throw new Error("ui.set: value too large");
      this.store.setUiState(p.key, p.value);
      return null;
    },
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

  #restartSearch(): void {
    const gen = ++this.#searchGen;
    this.#searchSwap = this.#searchSwap.then(async () => {
      const old = this.#search;
      this.#search = null;
      await old?.close();
      if (gen !== this.#searchGen || this.#closed) return; // a newer restart replaces this one
      const next = this.#opts.search!(this.settings.settings);
      this.#search = next;
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

  /** Requests from a pane's shell integration, e.g. `open .` → file window in the pane's Space. */
  #onShellRequest(paneId: string, action: string, arg: string): void {
    if (action !== "open" || !arg) return;
    try {
      const w = this.windows.openTarget(arg, this.#place({ callerPaneId: paneId }));
      if (w) this.#broadcast({ type: "window.focus", id: w.id });
    } catch {
      // not a folder / URL: ignore
    }
  }

  async call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    const h = this.handlers[method] as (p: Params<M>) => Result<M> | Promise<Result<M>>;
    if (!h) throw new Error(`unknown method: ${method}`);
    return h(params);
  }

  async listen(): Promise<void> {
    const sock = this.#opts.socketPath;
    fs.mkdirSync(path.dirname(sock), { recursive: true });
    await removeStaleSocket(sock);
    this.#server = net.createServer((conn) => this.#serve(conn));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(sock, () => resolve());
    });
    fs.chmodSync(sock, 0o600);
    this.settings.watch();
  }

  #serve(conn: net.Socket): void {
    conn.setEncoding("utf8");
    conn.on("error", () => {});
    conn.on("close", () => {
      this.#subscribers.delete(conn);
      for (const p of this.#connWatches.get(conn) ?? []) this.watches.unwatch(p);
      this.#connWatches.delete(conn);
    });
    conn.on(
      "data",
      lineSplitter(async (line) => {
        if (!line.trim()) return;
        let req: { id: number; method: Method; params?: unknown };
        try {
          req = JSON.parse(line);
        } catch {
          return;
        }
        try {
          const result = await this.call(req.method, (req.params ?? {}) as never);
          // Remember per-connection watches so a closed UI doesn't leak them.
          const wp = (req.params as { path?: string } | undefined)?.path;
          if (req.method === "fs.watch" && wp && (result as { watching: boolean }).watching) {
            this.#connWatches.set(conn, [...(this.#connWatches.get(conn) ?? []), wp]);
          } else if (req.method === "fs.unwatch" && wp) {
            const list = this.#connWatches.get(conn) ?? [];
            const i = list.indexOf(wp);
            if (i >= 0) list.splice(i, 1);
          }
          if (req.method === "events.subscribe") {
            const types = (req.params as Params<"events.subscribe"> | undefined)?.types;
            this.#subscribers.set(conn, Array.isArray(types) ? new Set(types) : null);
          }
          send(conn, { jsonrpc: "2.0", id: req.id, result: result ?? null });
        } catch (err) {
          send(conn, { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: (err as Error).message } });
        }
      }),
    );
  }

  #broadcast(event: CoreEvent): void {
    if (this.#subscribers.size === 0) return;
    const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: event }) + "\n";
    for (const [s, types] of this.#subscribers) if (s.writable && (!types || types.has(event.type))) s.write(line);
  }

  async close(): Promise<void> {
    this.magic.dispose();
    this.panes.dispose();
    for (const s of this.#subscribers.keys()) s.destroy();
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
    try {
      fs.unlinkSync(this.#opts.socketPath);
    } catch {}
    this.#closed = true;
    this.resources?.close();
    await this.#searchSwap;
    await this.#search?.close();
    this.watches.close();
    this.agents.close();
    this.store.close();
    this.settings.close();
  }
}

function send(conn: net.Socket, msg: unknown): void {
  if (conn.writable) conn.write(JSON.stringify(msg) + "\n");
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
