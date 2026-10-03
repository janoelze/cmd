// The core process: owns panes and agents, serves JSON-RPC on a Unix socket.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { CoreEvent, Method, Methods, Params, Result } from "@cmd/protocol";
import { lineSplitter } from "@cmd/protocol";
import { AgentTracker } from "./agents/tracker.ts";
import { PaneManager, type Inspector, type PtyFactory } from "./panes.ts";
import { ResourceMonitor, type TreeSampler } from "./resources.ts";
import type { SearchService } from "./search/service.ts";
import { listDir, WindowManager } from "./windows.ts";
import { Store } from "./store.ts";
import { SettingsService } from "./settings.ts";

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
  /** Transcript search (runs its own indexing worker); null disables search. */
  search?: SearchService | null;
  /** Source hash this core was started from (see sourceBuildId). */
  build?: string;
}

type Handlers = { [M in Method]: (params: Params<M>) => Result<M> | Promise<Result<M>> };

export class Core {
  readonly panes: PaneManager;
  readonly agents: AgentTracker;
  readonly store: Store;
  readonly settings: SettingsService;
  readonly resources: ResourceMonitor | null;
  readonly windows: WindowManager;
  #server: net.Server | null = null;
  #subscribers = new Set<net.Socket>();
  #opts: CoreOptions;

  constructor(opts: CoreOptions) {
    this.#opts = opts;
    this.store = new Store(opts.dbPath ?? ":memory:");
    this.settings = new SettingsService(opts.settingsPath ?? null);
    const settings = () => this.settings.settings;
    this.panes = new PaneManager(opts.ptyFactory, {
      socketPath: opts.socketPath,
      pollMs: opts.pollMs,
      settings,
      inspector: opts.inspector ?? null,
    });
    this.agents = new AgentTracker(this.panes, { store: this.store, settings, statusRoot: opts.statusRoot ?? null });
    this.resources = opts.sampler ? new ResourceMonitor(this.panes, opts.sampler) : null;
    this.windows = new WindowManager(this.panes, this.store);
    this.windows.on("updated", (window) => this.#broadcast({ type: "window.updated", window }));
    this.windows.on("removed", (id) => this.#broadcast({ type: "window.removed", id }));
    opts.search?.on("status", (status) => this.#broadcast({ type: "search.status", status }));
    this.settings.on("updated", (snapshot) => this.#broadcast({ type: "settings.updated", snapshot }));

    this.panes.on("output", (paneId, data) => this.#broadcast({ type: "pane.output", paneId, data }));
    this.panes.on("updated", (pane) => this.#broadcast({ type: "pane.updated", pane }));
    this.panes.on("removed", (paneId) => this.#broadcast({ type: "pane.removed", paneId }));
    this.agents.on("updated", (agent) => this.#broadcast({ type: "agent.updated", agent }));
    this.agents.on("removed", (agentId) => this.#broadcast({ type: "agent.removed", agentId }));
  }

  readonly handlers: Handlers = {
    "core.hello": () => ({ version: VERSION, pid: process.pid, socket: this.#opts.socketPath, build: this.#opts.build ?? "" }),
    "pane.create": (p) => this.panes.create(p),
    "pane.list": () => this.panes.list(),
    "pane.write": (p) => (this.panes.write(p.paneId, p.data), null),
    "pane.resize": (p) => (this.panes.resize(p.paneId, p.cols, p.rows), null),
    "pane.kill": (p) => (this.panes.kill(p.paneId), null),
    "pane.snapshot": (p) => ({ data: this.panes.snapshot(p.paneId) }),
    "pane.read": (p) => ({ text: this.panes.read(p.paneId, p.lines) }),
    "agent.list": () => this.agents.list(),
    "agent.spawn": (p) => this.agents.spawn(p),
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
    "window.open": (p) => this.windows.open(p),
    "window.update": (p) => this.windows.update(p.id, p),
    "window.close": (p) => (this.windows.close(p.id), null),
    "window.list": () => this.windows.list(),
    "fs.list": (p) => listDir(p.path),
    "search.query": (p) => this.#opts.search?.search(p.text, p.limit) ?? [],
    "search.status": () =>
      this.#opts.search?.status() ?? { sessions: 0, files: 0, indexing: false, done: 0, total: 0 },
    "agent.resume": (p) => this.agents.resume(p),
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
      settings: this.settings.snapshot(),
      ui: this.store.uiState(),
    }),
  };

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
    conn.on("close", () => this.#subscribers.delete(conn));
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
          if (req.method === "events.subscribe") this.#subscribers.add(conn);
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
    for (const s of this.#subscribers) if (s.writable) s.write(line);
  }

  async close(): Promise<void> {
    this.panes.dispose();
    for (const s of this.#subscribers) s.destroy();
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
    try {
      fs.unlinkSync(this.#opts.socketPath);
    } catch {}
    this.resources?.close();
    this.#opts.search?.close();
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
