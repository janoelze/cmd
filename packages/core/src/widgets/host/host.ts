// Package widgets' processes (docs/56, "The runtime: a widget process"): one long-lived process
// per window of a package widget ("pkg:<package>/<widget>"), started when the window opens
// (with declared ∩ granted; a package asking for more than its grant waits, nothing started)
// and stopped a minute after the window closes. Its connection carries the widget wire: hello
// picks the API adapter for its major (api/v1.ts), the tree and patches go to the window as
// widget.tree events (the last whole tree kept, so a window drawn later gets it), and the
// window's interactions come back. Lifecycle is a contract: a loop stuck for 20 s or a heap
// over the limit stops it with the reason; a crash restarts it, three in five minutes stop it
// ("crashed"); Restart (widget.restart) starts it again. A widget whose code doesn't load (a
// syntax error: an `error` on the wire, then an exit before hello) stops with "didn't load" and
// the error, no strike, until the next save. A save in a package (reload(), widgets/reload.ts)
// restarts its windows once. The window sees each state as a widget.tree status. A package
// waiting for a grant is asked once, not per window (asking(), widget.ask: the grants sheet).

import { SUPPORTED_API, WIDGET_API, WIDGET_API_MINOR, parsePackageKind, type AppWindow, type WidgetEnv, type WidgetHostStatus, type WidgetIn, type WidgetOut, type WidgetPermissions, type WindowId, type WireValue } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import fs from "node:fs";
import type { CoreContext } from "../../kernel/context.ts";
import { ApiRefusal } from "../api/access.ts";
import { AiUsage } from "../api/ai.ts";
import { apiV1, type ApiAdapter } from "../api/v1.ts";
import { effective, needsGrant, readGrants, writeGrants, type Grants } from "../grants.ts";
import { cmdVersion, type PackageWidget, type WidgetPackage } from "../package.ts";
import type { WidgetPackages } from "../packages.ts";
import { PackageConfig } from "../config.ts";
import { HostConnection, type ConnectionTimes } from "./connection.ts";
import type { ExitInfo, RuntimeProcess, WidgetRuntime } from "./runtime.ts";
import { TreeState } from "./tree.ts";

const log = logger("widgets");

export interface HostTimes extends ConnectionTimes {
  /** A closed window's process lives on this long (a reopen finds it running). */
  stopAfterMs: number;
  /** A started process that doesn't say hello within this is stopped. */
  helloMs: number;
  /** Crashes within this window count toward the three that stop it. */
  crashWindowMs: number;
  maxCrashes: number;
  /** After a crash, the restart waits this long. */
  restartMs: number;
}

export const HOST_TIMES: HostTimes = { pingMs: 5000, stallMs: 20_000, stopAfterMs: 60_000, helloMs: 20_000, crashWindowMs: 5 * 60_000, maxCrashes: 3, restartMs: 1000 };
/** The heap limit of a widget process (MB). */
export const WIDGET_MEMORY_MB = 256;

type HostCore = Pick<CoreContext, "windows" | "windowTypes" | "workspaces" | "widgetTokens" | "broadcast" | "settings" | "agents" | "panes" | "data" | "actions" | "notifications" | "ai" | "opened">;

export interface HostOptions {
  stateDir: string | null;
  /** The widgets socket; null: none (tests whose fake runtime attaches in-process). */
  socket: string | null;
  packages: WidgetPackages;
  runtime: WidgetRuntime | null;
  times?: Partial<HostTimes>;
  /** What the Library's entries say changed (a package started or stopped waiting for a grant, a secret was set). */
  onAsk?: () => void;
}

interface Instance {
  windowId: WindowId;
  kind: string;
  pkg: WidgetPackage | null;
  widget: PackageWidget | null;
  status: WidgetHostStatus;
  tree: TreeState;
  proc: RuntimeProcess | null;
  token: string | null;
  conn: HostConnection | null;
  adapter: ApiAdapter | null;
  subs: Map<number, () => void>;
  crashes: number[];
  /** Why we're stopping it ourselves (null: an exit is a crash). */
  stopping: string | null;
  timers: { stop?: NodeJS.Timeout; restart?: NodeJS.Timeout; hello?: NodeJS.Timeout };
  env: Pick<WidgetEnv, "theme" | "size" | "placement">;
  config: string;
  pressedAt: number;
  permissions: WidgetPermissions | null;
  /** The widget's error before it said hello (its main didn't import): an exit then is a load failure, not a crash. */
  loadError: string | null;
}

export class WidgetHost {
  #core: HostCore;
  #o: HostOptions;
  #t: HostTimes;
  #all = new Map<WindowId, Instance>();
  /** Grants without a state dir (tests): kept in memory. */
  #grants = new Map<string, Grants>();
  #aiUsage: AiUsage;
  /** Packages the person is asked about with no window waiting (just linked, Allow…). */
  #asked = new Set<string>();
  /** Packages the person declined, with what they asked for then: asking more asks again. */
  #declined = new Map<string, string>();
  /** Who wants to hear the person's answer about a package (a Magic build waiting at its permission step). */
  #answers = new Set<(name: string, allow: boolean) => void>();
  #started = false;
  #disposed = false;
  /** Tests: what net.fetch uses. */
  fetchImpl: typeof fetch | undefined;
  /** Its windows' config values and its packages' secrets (widget.config, widget.secret). */
  readonly config: PackageConfig;

  constructor(core: HostCore, o: HostOptions) {
    this.#core = core;
    this.#o = o;
    this.#t = { ...HOST_TIMES, ...o.times };
    this.#aiUsage = new AiUsage(o.stateDir);
    this.config = new PackageConfig({ windows: core.windows, packages: o.packages, stateDir: o.stateDir, onChange: () => o.onAsk?.() });
  }

  /** Swap the runtime (tests: a fake one; or tighter times). */
  configure(o: { runtime?: WidgetRuntime | null; times?: Partial<HostTimes>; socket?: string | null }): void {
    if (o.runtime !== undefined) this.#o.runtime = o.runtime;
    if (o.socket !== undefined) this.#o.socket = o.socket;
    if (o.times) this.#t = { ...this.#t, ...o.times };
  }

  /** Start the windows open now and follow windows from then on (a startup job, after the packages are read). */
  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#core.windows.on("updated", (w) => this.#updated(w));
    this.#core.windows.on("removed", (id) => this.#removed(id));
    this.reconcile();
  }

  /** The packages changed: windows waiting for one (or a grant) try again; one now asking for more waits. */
  packagesChanged(): void {
    if (!this.#started) return;
    for (const inst of this.#all.values()) {
      if (inst.timers.stop) continue;
      const pkg = this.#o.packages.forKind(inst.kind);
      if (inst.proc) {
        if (!pkg) this.#stop(inst, "isn't installed");
        else if (needsGrant(pkg.permissions, this.#granted(pkg.name)?.permissions)) {
          this.#stop(inst, null);
          this.#status(inst, { kind: "status", state: "waiting-grant" });
        } else if (inst.pkg && JSON.stringify(pkg) !== JSON.stringify(inst.pkg)) this.#relaunch(inst); // its package.json changed
      } else if (inst.status.state === "waiting-grant" || inst.status.reason === "isn't installed") this.#launch(inst);
    }
    this.reconcile();
  }

  /** A process for every package widget window there is. */
  reconcile(): void {
    if (!this.#started || this.#disposed) return;
    for (const w of this.#core.windows.others()) if (parsePackageKind(w.kind) && !this.#all.has(w.id)) this.#open(w);
  }

  /** The window's status now, and its tree if there is one, as widget.tree events. */
  resync(windowId: WindowId): void {
    const inst = this.#must(windowId);
    this.#emit(inst, inst.status);
    if (inst.tree.ready) this.#emit(inst, inst.tree.tree());
    else inst.conn?.send({ kind: "resync" });
  }

  interact(windowId: WindowId, handler: number, event: string, value?: unknown): void {
    const inst = this.#must(windowId);
    if (!inst.conn || !inst.adapter) throw new Error("this widget isn't running");
    if (!Number.isInteger(handler) || typeof event !== "string") throw new Error("an interaction names a handler and its event");
    inst.pressedAt = Date.now();
    inst.conn.send({ kind: "interaction", handler, event, ...(value === undefined ? {} : { value: value as WireValue }) });
  }

  setEnv(windowId: WindowId, env: Pick<WidgetEnv, "theme" | "size" | "placement">): void {
    const inst = this.#must(windowId);
    const next = {
      theme: env.theme === "light" ? ("light" as const) : ("dark" as const),
      size: env.size === "narrow" || env.size === "wide" ? env.size : ("regular" as const),
      placement: env.placement === "sidebar" ? ("sidebar" as const) : ("board" as const),
    };
    if (JSON.stringify(next) === JSON.stringify(inst.env)) return;
    inst.env = next;
    if (inst.adapter) inst.conn?.send({ kind: "env", env: this.#env(inst) });
  }

  restart(windowId: WindowId): void {
    this.#relaunch(this.#must(windowId));
  }

  /**
   * A package's files changed (a save; widgets/reload.ts, once per burst): its package.json is
   * read first, so one that now asks for more waits for the person instead of starting; then
   * each of its windows starts again, a stopped one too (the save may fix what stopped it).
   */
  reload(name: string): void {
    if (!this.#started || this.#disposed) return;
    const procs = new Map([...this.#all.values()].map((i) => [i, i.proc]));
    this.#o.packages.scan(); // a changed package.json restarts (or stops) its windows itself
    for (const inst of this.#all.values()) {
      if (inst.timers.stop || inst.status.state === "waiting-grant" || parsePackageKind(inst.kind)?.name !== name || inst.proc !== procs.get(inst)) continue;
      log.info(`widget ${name} reloading`, { window: inst.windowId });
      this.#relaunch(inst);
    }
  }

  /** Ask the person about a package now (true), or stop asking until asked again (`decline`). */
  ask(name: string, decline = false): void {
    const pkg = this.#package(name);
    if (!pkg) throw new Error(`no widget package ${name}`);
    if (decline) {
      this.#declined.set(name, JSON.stringify(pkg.permissions));
      this.#asked.delete(name);
      for (const fn of [...this.#answers]) fn(name, false);
    } else {
      this.#declined.delete(name);
      if (needsGrant(pkg.permissions, this.#granted(name)?.permissions)) this.#asked.add(name);
    }
    this.#o.onAsk?.();
  }

  /** Whether the person is being asked about a package (it needs a grant, a window waits or it was asked about, not declined), and the grant it has. */
  asking(name: string): { granted: WidgetPermissions | null } | null {
    const pkg = this.#package(name);
    if (!pkg) return null;
    const granted = this.#granted(name)?.permissions ?? null;
    if (!needsGrant(pkg.permissions, granted)) return null;
    if (this.#declined.get(name) === JSON.stringify(pkg.permissions)) return null;
    const waits = [...this.#all.values()].some((i) => !i.timers.stop && i.status.state === "waiting-grant" && parsePackageKind(i.kind)?.name === name);
    return waits || this.#asked.has(name) ? { granted } : null;
  }

  /** Grant a package what it declares (or `permissions`), and start its waiting windows. */
  grant(name: string, permissions?: WidgetPermissions): Grants {
    const pkg = this.#o.packages.list().find((e) => e.ok && e.pkg.name === name);
    if (!pkg?.ok) throw new Error(`no widget package ${name}`);
    const g: Grants = { version: pkg.pkg.version, permissions: effective(pkg.pkg.permissions, permissions ?? pkg.pkg.permissions) };
    if (this.#o.stateDir) writeGrants(this.#o.stateDir, name, g);
    else this.#grants.set(name, g);
    log.info(`widget package ${name} ${g.version} granted`, { permissions: g.permissions });
    this.#asked.delete(name);
    this.#declined.delete(name);
    this.#o.onAsk?.();
    for (const inst of this.#all.values()) if (inst.pkg?.name === name && !inst.proc) this.#launch(inst);
    for (const fn of [...this.#answers]) fn(name, true);
    return g;
  }

  /** The grant a package has (built-in: what it declares), or null. */
  granted(name: string): Grants | null {
    return this.#granted(name);
  }

  /** Hear each answer to the grants sheet (Allow: true, Decline: false) until the returned function is called. */
  onAnswer(fn: (name: string, allow: boolean) => void): () => void {
    this.#answers.add(fn);
    return () => void this.#answers.delete(fn);
  }

  /** Process states by window (tests, diagnostics). */
  status(windowId: WindowId): WidgetHostStatus | null {
    return this.#all.get(windowId)?.status ?? null;
  }

  /** Running processes. */
  running(): number {
    return [...this.#all.values()].filter((i) => i.proc).length;
  }

  dispose(): void {
    this.#disposed = true;
    for (const inst of this.#all.values()) {
      this.#stop(inst, null);
      for (const t of Object.values(inst.timers)) if (t) clearTimeout(t);
    }
    this.#all.clear();
  }

  // ── lifecycle ──────────────────────────────────────────

  #open(w: AppWindow): void {
    const inst: Instance = {
      windowId: w.id,
      kind: w.kind,
      pkg: null,
      widget: null,
      status: { kind: "status", state: "starting" },
      tree: new TreeState(),
      proc: null,
      token: null,
      conn: null,
      adapter: null,
      subs: new Map(),
      crashes: [],
      stopping: null,
      timers: {},
      env: { theme: this.#core.settings.settings["theme.appearance"] === "light" ? "light" : "dark", size: "regular", placement: "board" },
      config: "",
      pressedAt: 0,
      permissions: null,
      loadError: null,
    };
    this.#all.set(w.id, inst);
    this.#launch(inst);
  }

  #granted(name: string): Grants | null {
    return this.#o.packages.builtinGrant(name) ?? (this.#o.stateDir ? readGrants(this.#o.stateDir, name) : (this.#grants.get(name) ?? null));
  }

  #launch(inst: Instance): void {
    if (this.#disposed || inst.proc) return;
    if (inst.timers.restart) clearTimeout(inst.timers.restart);
    const pkg = this.#o.packages.forKind(inst.kind);
    const widget = pkg?.widgets.find((x) => x.kind === inst.kind) ?? null;
    inst.pkg = pkg;
    inst.widget = widget;
    if (!pkg || !widget) return this.#status(inst, { kind: "status", state: "stopped", reason: "isn't installed" });
    const g = this.#granted(pkg.name);
    if (needsGrant(pkg.permissions, g?.permissions)) return this.#status(inst, { kind: "status", state: "waiting-grant" });
    if (!this.#o.runtime) return this.#status(inst, { kind: "status", state: "stopped", reason: "can't run here" });
    inst.permissions = effective(pkg.permissions, g?.permissions);
    const w = this.#core.windows.others().find((x) => x.id === inst.windowId);
    const token = this.#core.widgetTokens.issue(
      { widgetId: inst.windowId, workspaceId: w?.workspaceId ?? null, events: [], attach: (send, close) => this.#attach(inst, token, send, close) },
      365 * 24 * 3600_000,
    );
    inst.token = token;
    inst.stopping = null;
    inst.loadError = null;
    inst.tree.reset();
    this.#status(inst, { kind: "status", state: "starting" });
    try {
      inst.proc = this.#o.runtime.start(
        { name: pkg.name, version: pkg.version, widget: widget.id, dir: pkg.dir, main: widget.main, permissions: inst.permissions, socket: this.#o.socket, token, memoryMb: WIDGET_MEMORY_MB },
        (e) => this.#exited(inst, token, e),
      );
    } catch (e) {
      this.#core.widgetTokens.revoke(token);
      inst.token = null;
      return this.#status(inst, { kind: "status", state: "stopped", reason: (e as Error).message });
    }
    inst.timers.hello = setTimeout(() => {
      if (inst.token === token && !inst.adapter) this.#kill(inst, "didn't start");
    }, this.#t.helloMs);
    inst.timers.hello.unref?.();
  }

  /** The process connected and said widget.hello with its token: the wire from here on. */
  #attach(inst: Instance, token: string, send: (line: string) => void, close: () => void): { receive(line: string): void; closed(): void } {
    if (inst.token !== token || inst.conn) {
      close();
      return { receive: () => {}, closed: () => {} };
    }
    const conn = new HostConnection(send, close, { onMessage: (m) => this.#message(inst, conn, m), onStall: () => this.#kill(inst, "stopped responding"), times: this.#t });
    inst.conn = conn;
    return { receive: (line) => conn.receive(line), closed: () => conn.ended() };
  }

  #message(inst: Instance, conn: HostConnection, m: WidgetOut): void {
    if (conn !== inst.conn) return;
    if (m.kind === "error" && !inst.adapter) inst.loadError = loadError(m.message, m.stack, inst.pkg ? realDir(inst.pkg.dir) : undefined);
    if (m.kind !== "hello" && !inst.adapter) return; // nothing else before hello
    switch (m.kind) {
      case "hello":
        return this.#hello(inst, m);
      case "tree":
        if (!Array.isArray(m.nodes) || typeof m.rev !== "number") return;
        inst.tree.setTree(m);
        return this.#emit(inst, m);
      case "patch":
        if (!Array.isArray(m.ops)) return;
        if (inst.tree.apply(m)) this.#emit(inst, m);
        else conn.send({ kind: "resync" });
        return;
      case "call":
        return void this.#call(inst, m.id, m.method, m.params);
      case "subscribe": {
        inst.subs.get(m.id)?.();
        try {
          inst.subs.set(m.id, inst.adapter!.subscribe(m.topic, m.query, (data) => conn.send({ kind: "event", sub: m.id, data })));
        } catch (e) {
          // The wire has no refusal for a subscription: the widget's log says why, and a result under its id for clients that read one.
          const error = e instanceof ApiRefusal ? e.error : { code: "failed" as const, message: (e as Error).message };
          log.info(`widget ${inst.pkg?.name}: ${m.topic} refused: ${error.message}`);
          conn.send({ kind: "result", id: m.id, ok: false, error });
        }
        return;
      }
      case "unsubscribe":
        inst.subs.get(m.id)?.();
        inst.subs.delete(m.id);
        return;
      case "log":
        return log[m.level === "error" ? "warn" : m.level === "warn" ? "info" : "debug"](`widget ${inst.pkg?.name}/${inst.widget?.id}: ${String(m.message).slice(0, 2000)}`);
      case "error":
        return log.warn(`widget ${inst.pkg?.name}/${inst.widget?.id} error: ${String(m.message).slice(0, 500)}`, { stack: m.stack?.slice(0, 2000) });
    }
  }

  #hello(inst: Instance, m: Extract<WidgetOut, { kind: "hello" }>): void {
    if (inst.adapter) return;
    const pkg = inst.pkg!;
    if (typeof m.api !== "number" || m.api < SUPPORTED_API.min || m.api > SUPPORTED_API.max) return this.#kill(inst, `made for ${m.api > SUPPORTED_API.max ? "a newer" : "an older"} cmd`);
    if (m.package !== pkg.name || m.widget !== inst.widget!.id) return this.#kill(inst, "said it was another widget");
    if (inst.timers.hello) clearTimeout(inst.timers.hello);
    inst.loadError = null; // it loaded: an error before hello didn't stop it, and a later exit is a crash
    inst.adapter = apiV1(this.#core, {
      windowId: inst.windowId,
      workspaceId: () => this.#core.windows.others().find((w) => w.id === inst.windowId)?.workspaceId ?? "",
      pkg,
      widget: inst.widget!,
      permissions: inst.permissions!,
      pressedAt: () => inst.pressedAt,
      secret: (key) => this.config.secrets(pkg.name).get(inst.widget!.id)[key] ?? null,
      aiUsage: this.#aiUsage,
      fetchImpl: this.fetchImpl,
    });
    const w = this.#core.windows.others().find((x) => x.id === inst.windowId);
    const config = this.#config(inst, w);
    inst.config = JSON.stringify(config);
    inst.conn!.send({ kind: "ready", env: this.#env(inst), config, state: ((w?.state.kv as Record<string, WireValue> | undefined) ?? {}) });
    log.info(`widget ${pkg.name} started (api ${m.api})`, { widget: inst.widget!.id, window: inst.windowId, version: pkg.version });
    this.#status(inst, { kind: "status", state: "running" });
  }

  async #call(inst: Instance, id: number, method: string, params: WireValue[]): Promise<void> {
    const adapter = inst.adapter!;
    const conn = inst.conn;
    let msg: WidgetIn;
    try {
      msg = { kind: "result", id, ok: true, value: await adapter.call(method, Array.isArray(params) ? params : []) };
    } catch (e) {
      if (e instanceof ApiRefusal) msg = { kind: "result", id, ok: false, error: e.error };
      else {
        log.warn(`widget ${inst.pkg?.name}: ${method} failed`, { error: (e as Error).message });
        msg = { kind: "result", id, ok: false, error: { code: "failed", message: (e as Error).message.slice(0, 500) } };
      }
    }
    if (conn === inst.conn) conn?.send(msg);
  }

  #exited(inst: Instance, token: string, e: ExitInfo): void {
    if (inst.token !== token) return;
    const intended = inst.stopping;
    const loadFailed = inst.loadError;
    this.#cleanup(inst);
    if (this.#disposed) return;
    if (intended !== null) {
      if (intended) this.#status(inst, { kind: "status", state: "stopped", reason: intended });
      return;
    }
    if (loadFailed !== null) {
      // Its code didn't load (a syntax error, a missing import): starting it again would do the same, so it waits for a save.
      log.warn(`widget ${inst.pkg?.name}/${inst.widget?.id} didn't load: ${loadFailed}`);
      return this.#status(inst, { kind: "status", state: "stopped", reason: "didn't load", ...(loadFailed ? { detail: loadFailed } : {}) });
    }
    if (/out of memory|heap limit/i.test(e.stderr)) return this.#status(inst, { kind: "status", state: "stopped", reason: "used too much memory" });
    const now = Date.now();
    inst.crashes = [...inst.crashes.filter((t) => now - t < this.#t.crashWindowMs), now];
    log.warn(`widget ${inst.pkg?.name}/${inst.widget?.id} crashed`, { code: e.code, signal: e.signal, crashes: inst.crashes.length, stderr: e.stderr.slice(-600) });
    if (inst.crashes.length >= this.#t.maxCrashes) return this.#status(inst, { kind: "status", state: "stopped", reason: "crashed" });
    this.#status(inst, { kind: "status", state: "starting", reason: "crashed" });
    inst.timers.restart = setTimeout(() => this.#launch(inst), this.#t.restartMs);
    inst.timers.restart.unref?.();
  }

  /** Stop it ourselves; the window then says `reason` (null: nothing, it is going away or starting again). */
  #stop(inst: Instance, reason: string | null): void {
    if (!inst.proc) return;
    inst.stopping = reason ?? "";
    const proc = inst.proc;
    const token = inst.token!;
    proc.kill();
    // The exit comes by itself; a process that doesn't report one is done with here anyway.
    if (inst.token === token) this.#cleanup(inst);
    if (reason) this.#status(inst, { kind: "status", state: "stopped", reason });
  }

  #kill(inst: Instance, reason: string): void {
    log.warn(`widget ${inst.pkg?.name}/${inst.widget?.id} stopped: ${reason}`);
    this.#stop(inst, reason);
  }

  #cleanup(inst: Instance): void {
    for (const off of inst.subs.values()) off();
    inst.subs.clear();
    inst.conn?.close();
    inst.conn = null;
    inst.adapter = null;
    if (inst.token) this.#core.widgetTokens.revoke(inst.token);
    inst.token = null;
    inst.proc = null;
    if (inst.timers.hello) clearTimeout(inst.timers.hello);
  }

  #updated(w: AppWindow): void {
    const inst = this.#all.get(w.id);
    // A window that switched to another kind (Edit with Magic) is gone for its package.
    if (!parsePackageKind(w.kind)) return void (inst && inst.kind !== w.kind && this.#removed(w.id));
    if (!inst) return this.#open(w);
    if (inst.timers.stop) {
      clearTimeout(inst.timers.stop);
      delete inst.timers.stop;
      if (!inst.proc && inst.status.state !== "stopped") this.#launch(inst);
    }
    if (!inst.adapter) return;
    const config = this.#config(inst, w);
    const text = JSON.stringify(config);
    if (text !== inst.config) {
      inst.config = text;
      inst.conn?.send({ kind: "config", config });
    }
  }

  #removed(id: WindowId): void {
    const inst = this.#all.get(id);
    if (!inst || inst.timers.stop) return;
    inst.timers.stop = setTimeout(() => {
      this.#stop(inst, null);
      if (inst.timers.restart) clearTimeout(inst.timers.restart);
      this.#all.delete(id);
    }, this.#t.stopAfterMs);
    inst.timers.stop.unref?.();
    if (inst.status.state === "waiting-grant") this.#o.onAsk?.();
  }

  // ── helpers ────────────────────────────────────────────

  #status(inst: Instance, s: WidgetHostStatus): void {
    const was = inst.status.state;
    inst.status = s;
    this.#emit(inst, s);
    if ((was === "waiting-grant") !== (s.state === "waiting-grant")) this.#o.onAsk?.();
  }

  /** Stop it (if running) and start it again, its crashes forgotten. */
  #relaunch(inst: Instance): void {
    this.#stop(inst, null);
    inst.crashes = [];
    this.#launch(inst);
  }

  #package(name: string): WidgetPackage | null {
    const e = this.#o.packages.list().find((x) => x.ok && x.pkg.name === name);
    return e?.ok ? e.pkg : null;
  }

  #emit(inst: Instance, message: Extract<WidgetOut, { kind: "tree" | "patch" }> | WidgetHostStatus): void {
    this.#core.broadcast({ type: "widget.tree", windowId: inst.windowId, message });
  }

  #env(inst: Instance): WidgetEnv {
    return { version: cmdVersion() ?? "0.0.0", api: { major: WIDGET_API, minor: WIDGET_API_MINOR }, verbs: inst.adapter?.verbs ?? [], ...inst.env };
  }

  /** The window's config: the manifest's defaults, then the person's values; never a secret. */
  #config(inst: Instance, w: AppWindow | undefined): Record<string, WireValue> {
    const set = (w?.state.config as Record<string, WireValue> | undefined) ?? {};
    const out: Record<string, WireValue> = {};
    for (const f of inst.widget?.config ?? []) {
      if (f.secret) continue;
      const v = set[f.key];
      if (v !== undefined && v !== null) out[f.key] = v;
      else if (f.default !== undefined) out[f.key] = f.default;
    }
    return out;
  }

  #must(id: WindowId): Instance {
    const inst = this.#all.get(id);
    if (!inst) throw new Error(`not a package widget's window: ${id}`);
    return inst;
  }
}

/**
 * What a load failure shows: the error's first line, then where (the first "at" line of the
 * message or the stack, the package's own path cut to what's in it): "SyntaxError: Expression
 * expected · src/main.tsx:15:1". Deno's code frame under the message is left out.
 */
export function loadError(message: unknown, stack: unknown, dir?: string): string {
  const lines = [String(message ?? ""), typeof stack === "string" ? stack : ""].join("\n").split("\n").map((l) => l.trim());
  const first = lines[0] ?? "";
  let at = lines.find((l) => l.startsWith("at "))?.replace(/^at (async )?/, "").replace(/^file:\/\//, "");
  if (at && dir) {
    const real = dir.endsWith("/") ? dir : dir + "/";
    if (at.startsWith(real)) at = at.slice(real.length);
  }
  return [first, at && !first.includes(at) ? at : null].filter(Boolean).join(" · ").slice(0, 1000);
}

const realDir = (dir: string): string => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
};
