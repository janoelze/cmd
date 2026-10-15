// Package widgets' processes (docs/56, "The runtime: a widget process"): one long-lived process
// per window of a package widget ("pkg:<package>/<widget>"), started when the window opens
// (with declared ∩ granted; a package asking for more than its grant waits, nothing started)
// and stopped a minute after the window closes. Its connection carries the widget wire: hello
// checks its API major and starts the API (api/adapter.ts), the tree and patches go to the window as
// widget.tree events (the last whole tree kept, so a window drawn later gets it), and the
// window's interactions come back. Lifecycle is a contract: a loop stuck for 20 s or a heap
// over the limit stops it with the reason; a crash restarts it, three in five minutes stop it
// ("crashed"); Restart (widget.restart) starts it again. A widget whose code doesn't load (a
// syntax error: an `error` on the wire, then an exit before hello) stops with "didn't load" and
// the error, no strike, until the next save. A save in a package (reload(), widgets/reload.ts)
// restarts its windows once. The window sees each state as a widget.tree status. A package
// waiting for a grant is asked once, not per window (asking(), widget.ask: the grants sheet).
// The window's API (api/adapter.ts) is made at its start with a grant, before hello, so a frame's
// page (frame.ts) uses the process's adapter, Deno or not; it ends with the process or the window.
// Ready waits for the window's storage (1.3): each of its places (package, workspace, window)
// whose data is older than its code is migrated by it, under that place's lock: `migrate` lists
// them, the process answers `migrated` for each (one that throws stops it); others wait. A window
// moved to a workspace whose data is older starts again, to migrate it.

import { API_ELEMENT_NAMES, WIDGET_API, WIDGET_API_MINOR, configValues, parsePackageKind, roundBox, type AppWindow, type WidgetEnv, type WidgetHostStatus, type WidgetIn, type WidgetOut, type WidgetPermissions, type WindowId, type WireValue } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import type { CoreContext } from "../../kernel/context.ts";
import { ApiRefusal } from "../api/access.ts";
import { AiUsage } from "../api/ai.ts";
import { widgetApi, type WidgetApi } from "../api/adapter.ts";
import { effective, needsGrant, readGrants, writeGrants, type Grants } from "../grants.ts";
import { cmdVersion, type PackageWidget, type WidgetPackage } from "../package.ts";
import type { WidgetPackages } from "../packages.ts";
import { PackageConfig } from "../config.ts";
import { HostConnection, type ConnectionTimes } from "./connection.ts";
import type { ExitInfo, WidgetRuntime } from "./runtime.ts";
import { HOST_TIMES, WIDGET_MEMORY_MB } from "../limits.ts";
import { loadError, realDir } from "./load-error.ts";
import type { ActDeps } from "../api/act.ts";
import { newInstance, type Instance } from "./instance.ts";
import { WidgetFrames } from "./frame.ts";
import type { WidgetStorage } from "../storage.ts";

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


type HostCore = Pick<CoreContext, "windows" | "windowTypes" | "workspaces" | "widgetTokens" | "broadcast" | "settings" | "agents" | "panes" | "data" | "actions" | "notifications" | "ai" | "opened" | "call" | "server" | "resources" | "stats" | "journal" | "processes" | "commands">;

export interface HostOptions {
  stateDir: string | null;
  /** The widgets socket; null: none (tests whose fake runtime attaches in-process). */
  socket: string | null;
  packages: WidgetPackages;
  runtime: WidgetRuntime | null;
  times?: Partial<HostTimes>;
  /** What the Library's entries say changed (a package started or stopped waiting for a grant, a secret was set). */
  onAsk?: () => void;
  /** The tools' approvals and board marks, which widgets' acts ask and show through (none: acts are refused). */
  acts?: () => ActDeps | null;
  /** Packages' storage (widgets/storage.ts) and whose rows a package's are (library.ts storageOwner); none: each window's in memory. */
  storage?: { store: WidgetStorage; owner: (pkg: WidgetPackage) => string };
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
  /** Frame widgets' pages: what they load, their calls and live topics (frame.ts). */
  readonly frames: WidgetFrames;

  constructor(core: HostCore, o: HostOptions) {
    this.#core = core;
    this.#o = o;
    this.#t = { ...HOST_TIMES, ...o.times };
    this.#aiUsage = new AiUsage(o.stateDir);
    this.config = new PackageConfig({ windows: core.windows, packages: o.packages, stateDir: o.stateDir, onChange: () => o.onAsk?.() });
    this.frames = new WidgetFrames({ windows: () => core.windows.others(), packages: o.packages, granted: (name) => this.#granted(name), api: (id) => this.api(id), hasFrame: (id) => !!this.#all.get(id)?.tree.has("Frame"), send: (conn, e) => core.server.send(conn, e) });
  }

  /** The window's API while its widget may use it (a frame's page, frame.ts), or null: not started, waiting for a grant, stopped, closed. */
  api(windowId: WindowId): WidgetApi | null {
    const inst = this.#all.get(windowId);
    return inst && !inst.timers.stop ? inst.adapter : null;
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

  /** The packages changed, or Deno came: windows waiting for one (a grant, Deno) try again; one now asking for more waits. */
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
        } else if (inst.pkg && JSON.stringify({ ...pkg, magic: 0 }) !== JSON.stringify({ ...inst.pkg, magic: 0 })) this.#relaunch(inst); // its package.json changed (not only cmd's mark)
      } else if (inst.status.state === "waiting-grant" || inst.status.reason === "isn't installed" || /Deno/.test(inst.status.reason ?? "")) this.#launch(inst);
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

  /** What the person did in the window; `remote`: on a paired device (an act it leads to asks on the Mac). */
  interact(windowId: WindowId, handler: number, event: string, value?: unknown, remote = false): void {
    const inst = this.#must(windowId);
    if (!inst.conn || !inst.hello) throw new Error("this widget isn't running");
    if (!Number.isInteger(handler) || typeof event !== "string") throw new Error("an interaction names a handler and its event");
    if (!inst.press.interaction(inst.tree, handler, event, value, remote)) return;
    inst.conn.send({ kind: "interaction", handler, event, ...(value === undefined ? {} : { value: value as WireValue }) });
  }

  setEnv(windowId: WindowId, env: Pick<WidgetEnv, "theme" | "size" | "placement" | "box">): void {
    const inst = this.#must(windowId);
    const next = {
      theme: env.theme === "light" ? ("light" as const) : ("dark" as const),
      size: env.size === "narrow" || env.size === "wide" ? env.size : ("regular" as const),
      // 1.3: the content's box, rounded as the widget gets it (an older renderer sends none: the last one stays).
      box: roundBox(env.box) ?? inst.env.box ?? null,
      placement: env.placement === "sidebar" ? ("sidebar" as const) : ("board" as const),
    };
    if (JSON.stringify(next) === JSON.stringify(inst.env)) return;
    inst.env = next;
    if (inst.hello) inst.conn?.send({ kind: "env", env: this.#env(inst) });
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
      this.#endApi(inst);
      for (const t of Object.values(inst.timers)) if (t) clearTimeout(t);
    }
    this.#all.clear();
  }

  // ── lifecycle ──────────────────────────────────────────

  #open(w: AppWindow): void {
    const inst = newInstance(w, this.#core.settings.settings["theme.appearance"] === "light" ? "light" : "dark", (l) => this.#core.broadcast({ type: "widget.log", windowId: w.id, ...l }));
    this.#all.set(w.id, inst);
    this.#launch(inst);
  }

  #granted(name: string): Grants | null {
    return this.#o.packages.builtinGrant(name) ?? (this.#o.stateDir ? readGrants(this.#o.stateDir, name) : (this.#grants.get(name) ?? null));
  }

  #launch(inst: Instance): void {
    if (this.#disposed || inst.proc) return;
    if (inst.timers.restart) clearTimeout(inst.timers.restart);
    this.#endApi(inst); // one without a process (no runtime) is made again with the grant as it is now
    const pkg = this.#o.packages.forKind(inst.kind);
    const widget = pkg?.widgets.find((x) => x.kind === inst.kind) ?? null;
    inst.pkg = pkg;
    inst.widget = widget;
    if (!pkg || !widget) return this.#status(inst, { kind: "status", state: "stopped", reason: "isn't installed" });
    const g = this.#granted(pkg.name);
    if (needsGrant(pkg.permissions, g?.permissions)) return this.#status(inst, { kind: "status", state: "waiting-grant" });
    inst.permissions = effective(pkg.permissions, g?.permissions);
    inst.adapter = this.#api(inst, pkg, widget, inst.permissions);
    if (!this.#o.runtime) return this.#status(inst, { kind: "status", state: "stopped", reason: "can't run here" });
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
      this.#endApi(inst);
      return this.#status(inst, { kind: "status", state: "stopped", reason: (e as Error).message });
    }
    inst.timers.hello = setTimeout(() => {
      if (inst.token === token && !inst.hello) this.#kill(inst, "didn't start");
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
    if (m.kind === "error" && !inst.hello) inst.loadError = loadError(m.message, m.stack, inst.pkg ? realDir(inst.pkg.dir) : undefined);
    if (m.kind !== "hello" && !inst.hello) return; // nothing else before hello
    switch (m.kind) {
      case "hello":
        return this.#hello(inst, m);
      case "migrated":
        return this.#migrated(inst, m);
      case "tree":
        if (!Array.isArray(m.nodes) || typeof m.rev !== "number") return;
        inst.tree.setTree(m);
        return void (this.#emit(inst, m), this.#pages(inst));
      case "patch":
        if (!Array.isArray(m.ops)) return;
        return void (inst.tree.apply(m) ? (this.#emit(inst, m), this.#pages(inst)) : conn.send({ kind: "resync" }));
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
        if (!inst.logs.push({ level: m.level, message: String(m.message).slice(0, 2000) })) return;
        return log[m.level === "error" ? "warn" : m.level === "warn" ? "info" : "debug"](`widget ${inst.pkg?.name}/${inst.widget?.id}: ${String(m.message).slice(0, 2000)}`);
      case "error":
        if (!inst.logs.push({ level: "error", message: String(m.message).slice(0, 2000), stack: [m.stack, m.componentStack].filter(Boolean).join("\n").slice(0, 4000) || null })) return;
        return log.warn(`widget ${inst.pkg?.name}/${inst.widget?.id} error: ${String(m.message).slice(0, 500)}`, { stack: m.stack?.slice(0, 2000) });
    }
  }

  #hello(inst: Instance, m: Extract<WidgetOut, { kind: "hello" }>): void {
    if (inst.hello || !inst.adapter) return;
    const pkg = inst.pkg!;
    if (typeof m.api !== "number" || m.api !== WIDGET_API) return this.#kill(inst, `made for ${m.api > WIDGET_API ? "a newer" : "an older"} cmd`);
    if (m.package !== pkg.name || m.widget !== inst.widget!.id) return this.#kill(inst, "said it was another widget");
    if (inst.timers.hello) clearTimeout(inst.timers.hello);
    inst.loadError = null; // it loaded: an error before hello didn't stop it, and a later exit is a crash
    inst.hello = true;
    const conn = inst.conn;
    void inst.adapter.migrateStart().then((migrate) => {
      if (inst.conn !== conn || !conn) return; // it stopped while another window migrated
      const w = this.#core.windows.others().find((x) => x.id === inst.windowId);
      const config = this.#config(inst, w);
      inst.config = JSON.stringify(config);
      conn.send({ kind: "ready", env: this.#env(inst), config, state: (w?.state.kv as Record<string, WireValue> | undefined) ?? {}, ...(migrate.length ? { migrate } : {}) });
      log.info(`widget ${pkg.name} started (api ${m.api})`, { widget: inst.widget!.id, window: inst.windowId, version: pkg.version, ...(migrate.length ? { migrate } : {}) });
      this.#status(inst, { kind: "status", state: "running" });
    });
  }

  /** A place's migration ended: kept, or it threw (or keeping it failed) and the window stops, that place's data as it was. */
  #migrated(inst: Instance, m: Extract<WidgetOut, { kind: "migrated" }>): void {
    const error = inst.adapter?.migrateEnd(m.scope, m.ok === true) ?? null;
    if (m.ok === true && !error) return;
    const detail = `${String(m.message ?? error ?? "").slice(0, 500) || "The migration failed."} Its stored data is as it was.`;
    log.warn(`widget ${inst.pkg?.name}: migrating its storage failed: ${detail}`);
    this.#stop(inst, null);
    this.#status(inst, { kind: "status", state: "stopped", reason: "couldn't update its stored data", detail });
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
    this.#endApi(inst);
    for (const off of inst.subs.values()) off();
    inst.subs.clear();
    inst.conn?.close();
    inst.conn = null;
    inst.hello = false;
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
    if (!inst.hello) return;
    if (inst.adapter?.storageBehind()) return this.#relaunch(inst);
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
    this.frames.ended(id, { code: "failed", message: "This widget's window is closed." });
    inst.timers.stop = setTimeout(() => {
      this.#stop(inst, null);
      this.#endApi(inst);
      if (inst.timers.restart) clearTimeout(inst.timers.restart);
      this.#all.delete(id);
    }, this.#t.stopAfterMs);
    inst.timers.stop.unref?.();
    if (inst.status.state === "waiting-grant") this.#o.onAsk?.();
  }

  // ── helpers ────────────────────────────────────────────

  /** The window's API under `permissions` (declared ∩ granted). */
  #api(inst: Instance, pkg: WidgetPackage, widget: PackageWidget, permissions: WidgetPermissions): WidgetApi {
    const workspaceId = () => this.#core.windows.others().find((w) => w.id === inst.windowId)?.workspaceId ?? "";
    const host = this; // tests set fetchImpl late
    const st = this.#o.storage;
    const storage = st ? { store: st.store, owner: st.owner(pkg), declared: pkg.storage?.version ?? 1 } : undefined;
    return widgetApi(this.#core, { windowId: inst.windowId, workspaceId, pkg, widget, permissions, press: inst.press, acts: () => this.#o.acts?.() ?? null, secret: (key) => this.config.secrets(pkg.name).get(widget.id)[key] ?? null, aiUsage: this.#aiUsage, storage, get fetchImpl() { return host.fetchImpl; } });
  }

  /** A Frame page the tree names that isn't in the package: one line in the widget's log. */
  #pages = (inst: Instance) => this.frames.pages(inst.windowId, inst.pkg?.dir, inst.tree, (message) => inst.logs.push({ level: "warn", message }) && log.info(`widget ${inst.pkg?.name}: ${message}`));
  /** The window's API ends: its acts waiting for the person are a no, its frames' subscriptions end. */
  #endApi(inst: Instance): void {
    if (!inst.adapter) return;
    inst.adapter.dispose();
    inst.adapter = null;
    this.frames.ended(inst.windowId);
  }

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
    return { version: cmdVersion() ?? "0.0.0", api: { major: WIDGET_API, minor: WIDGET_API_MINOR }, verbs: inst.adapter?.verbs ?? [], elements: [...API_ELEMENT_NAMES], ...inst.env };
  }

  /** The window's config: the manifest's defaults, then the person's values; never a secret. */
  #config(inst: Instance, w: AppWindow | undefined): Record<string, WireValue> {
    return configValues(inst.widget?.config, w?.state.config as Record<string, WireValue> | undefined);
  }

  #must(id: WindowId): Instance {
    const inst = this.#all.get(id);
    if (!inst) throw new Error(`not a package widget's window: ${id}`);
    return inst;
  }
}
