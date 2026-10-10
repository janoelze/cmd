// Magic widgets in the core (docs/14-magic-v2.md, docs/16-widgets.md). A
// widget is a folder ($CMD_HOME/widgets/<widget id>) with an id of its own:
// the agent builds it there (buildWidget), every build and hand edit is kept
// as a revision, and it stays in the library when its windows close. Windows
// are copies of a widget: each has its own config, cmd.state and data runs,
// and its state holds what it needs to draw (the composed view, the last
// data, health); a change to the widget reaches every copy. The core then runs the widget's data.ts on its interval,
// validated against its schema, and streams the data to the UI (magic.data);
// failures keep the last good data on screen, are shown with their reason,
// and wait as long as the server asks. The agent is never involved in a
// refresh. v1 windows (a source in their state) keep refreshing that source
// until they are changed, which rebuilds them as widgets.

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { logger } from "@cmd/protocol/node";
import {
  requestedMedia,
  type AppWindow,
  type CoreEvent,
  type MagicHealth,
  type MagicLibraryEntry,
  type MagicNotify,
  type MagicRuntime,
  type MagicState,
  type MagicStatus,
  type MagicStep,
  type MagicWidgetInfo,
  type Settings,
  type WindowId,
} from "@cmd/protocol";
import type { Backend } from "../ai/backends.ts";
import type { AiService } from "../ai/service.ts";
import { magicDenyPaths } from "../paths-deny.ts";
import { buildWidget, type BuildEvent } from "./build.ts";
import type { Workspace } from "./prompt.ts";
import { sandboxAvailable, type SandboxMode } from "./sandbox.ts";
import { runSource } from "./sources.ts";
import { WidgetStore } from "../widgets/store.ts";
import { configValues, type WidgetManifest } from "../widgets/manifest.ts";
import { denoVersion, describeDataError, findDeno, installDeno, runData, type DenoEnv } from "../widgets/deno.ts";
import type { Previewer } from "../widgets/preview.ts";
import { WidgetSecrets } from "../widgets/secrets.ts";
import type { VerifyContext } from "../widgets/verify.ts";

const log = logger("magic");

/** What the service needs from the core's window manager. */
export interface MagicWindows {
  others(): AppWindow[];
  update(id: WindowId, patch: { title?: string; state?: Record<string, unknown> }): AppWindow;
  on(event: "removed", fn: (id: WindowId) => void): unknown;
}

/** A widget's notification, for the core's NotificationCenter (the window's attention marker is set here). */
export interface WidgetNotification {
  windowId: WindowId;
  title: string;
  body: string;
  urgent: boolean;
  muted: boolean;
}

export interface MagicServiceOptions {
  /** The core's widgets socket and a token per data.ts run, so widgets can read the event log (docs/28 §4). */
  widgetSocket?: { path: string; token: (widgetId: string, workspaceId: string | null, events: string[]) => string } | null;
  windows: MagicWindows;
  settings: () => Settings;
  /** Show a widget's notification (data.ts notify()). */
  notify?: (n: WidgetNotification) => void;
  /** Models: the agent runs on the smart tier of the provider in use. */
  ai: AiService;
  broadcast: (e: CoreEvent) => void;
  /** Tests inject a fake; default: the AI service's smart tier. */
  backend?: (s: Settings) => Backend;
  sandbox?: SandboxMode;
  /** Where a window's agent and data.ts run (its workspace's root); default: home. */
  cwdFor?: (w: AppWindow) => string;
  /** The window's workspace, unless it is Home: named in the request, so "this project" means its folder. */
  workspaceFor?: (w: AppWindow) => Workspace | null;
  /** $CMD_HOME: widgets, Deno's cache and cmd's own Deno live here; null: a temp folder (tests). */
  stateDir?: string | null;
  /** Who renders previews (the app, else Playwright); null: none. */
  previewer?: () => Promise<Previewer | null>;
  /** Tests: the Deno to use (default: findDeno). */
  deno?: string | null;
  /** Whether any UI could show the data (default: always); refreshes wait while none can (see resume). */
  watched?: () => boolean;
  /** The library changed: a widget made, changed, renamed, duplicated or deleted, or a window showing one opened or closed. */
  libraryChanged?: () => void;
}

const PERSIST_DATA_MS = 60_000;
/** The shortest interval data runs at. */
const MIN_REFRESH_S = 2;
/** Failures in a row before magic.autoFix asks the agent. */
const AUTO_FIX_AFTER = 3;

const stateOf = (w: AppWindow) => w.state as MagicState;

function detailOf(tool: string, input: Record<string, unknown>): string {
  const v = input.command ?? input.path ?? input.url ?? "";
  return String(v).replace(/\s+/g, " ").slice(0, 160) || tool;
}

export class MagicService {
  #o: MagicServiceOptions;
  readonly store: WidgetStore;
  readonly widgetSecrets: WidgetSecrets;
  #stateDir: string;
  #runs = new Map<WindowId, AbortController>();
  #timers = new Map<WindowId, ReturnType<typeof setTimeout>>();
  #failures = new Map<WindowId, number>();
  #persistedAt = new Map<WindowId, number>();
  /** Per widget id: its folder's watcher, and the hand edit waiting to settle. */
  #watchers = new Map<string, fs.FSWatcher>();
  #editTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The widget each Magic window shows (kept here: a closed window's state is gone by "removed"). */
  #widgetOf = new Map<WindowId, string>();
  /** Widgets being made or changed, and the window doing it. */
  #building = new Map<string, WindowId>();
  /** Windows magic.autoFix already tried to fix (per revision). */
  #autoFixed = new Map<WindowId, number>();
  /** Refreshes that came due while no UI was connected: run on resume. */
  #parked = new Set<WindowId>();
  #disposed = false;

  constructor(o: MagicServiceOptions) {
    this.#o = o;
    this.#stateDir = o.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "cmd-magic-"));
    this.store = new WidgetStore(path.join(this.#stateDir, "widgets"));
    this.widgetSecrets = new WidgetSecrets(o.stateDir ? path.join(o.stateDir, "widget-secrets.json") : null);
    o.windows.on("removed", (id) => this.#removed(id));
    this.#migrateClosed();
    for (const w of o.windows.others()) {
      if (w.kind !== "magic") continue;
      const s = stateOf(w);
      if (s.widgetId) this.#widgetOf.set(w.id, s.widgetId);
      // A run can't survive the core; say so instead of spinning forever.
      if (s.phase === "working") o.windows.update(w.id, { state: { phase: s.html || s.command ? "ready" : "error", error: "Interrupted: cmd restarted while this was being made." } });
      const now = stateOf(this.#window(w.id));
      if (now.phase === "ready") {
        this.#schedule(w.id, 0);
        if (now.widgetId) this.#watch(now.widgetId);
      }
    }
  }

  #window(id: WindowId): AppWindow {
    const w = this.#o.windows.others().find((x) => x.id === id);
    if (!w || w.kind !== "magic") throw new Error(`not a Magic widget: ${id}`);
    return w;
  }

  /** The Magic windows showing a widget. */
  #copies(widgetId: string): AppWindow[] {
    return this.#o.windows.others().filter((w) => w.kind === "magic" && stateOf(w).widgetId === widgetId);
  }

  #cwd(w: AppWindow): string {
    return this.#o.cwdFor?.(w) ?? os.homedir();
  }

  #sandbox(): SandboxMode {
    if (this.#o.sandbox) return this.#o.sandbox;
    return process.env.CMD_MAGIC_UNSANDBOXED === "1" && !sandboxAvailable() ? "off" : "required";
  }

  #deno(): DenoEnv | null {
    const deno = this.#o.deno !== undefined ? this.#o.deno : findDeno({ setting: this.#o.settings()["magic.deno"], stateDir: this.#o.stateDir ?? undefined });
    if (!deno) return null;
    return { deno, denoDir: path.join(this.#stateDir, "runtime", "deno-cache"), sandbox: this.#sandbox() };
  }

  async #verifyContext(w: AppWindow, widgetId: string, signal?: AbortSignal): Promise<VerifyContext> {
    const s = stateOf(w);
    return {
      store: this.store,
      id: widgetId,
      deno: this.#deno(),
      previewer: (await this.#o.previewer?.().catch(() => null)) ?? null,
      cwd: this.#cwd(w),
      config: s.config,
      secrets: this.widgetSecrets.get(widgetId),
      signal,
    };
  }

  // ── building ───────────────────────────────────────────

  /** Make (or, for a window that already shows something, change) the window's widget from a request. */
  run(id: WindowId, prompt: string): void {
    const text = prompt.trim();
    if (!text) throw new Error("magic.run: empty request");
    const w = this.#window(id);
    const prev = stateOf(w);

    let widgetId = prev.widgetId ?? randomUUID();
    const hasWidget = !!this.store.latest(widgetId);
    const legacy = !prev.widgetId && !!(prev.html || prev.command);
    const refining = !!prev.prompt && (prev.phase === "ready" || prev.phase === "error") && (hasWidget || legacy);
    // A new request never overwrites a widget in the library: it makes another.
    if (!refining && hasWidget) widgetId = randomUUID();
    const busy = this.#building.get(widgetId);
    if (busy && busy !== id) throw new Error("This widget is being changed in another window.");
    this.#runs.get(id)?.abort();
    this.stop(id);
    const ac = new AbortController();
    this.#runs.set(id, ac);
    // A draft that never built starts over.
    if (!refining) for (const f of fs.existsSync(this.store.dir(widgetId)) ? this.store.files(widgetId) : []) this.store.remove(widgetId, f);
    this.#building.set(widgetId, id);
    this.#widgetOf.set(id, widgetId);
    const done = () => {
      if (this.#building.get(widgetId) === id) this.#building.delete(widgetId);
    };
    const original = refining ? prev.prompt : text;
    const history = refining ? [...(prev.history ?? [prev.prompt]), text] : [text];
    this.#o.windows.update(id, { title: refining ? w.title : "Magic Widget", state: { prompt: original, phase: "working", error: undefined, steps: [], history, widgetId } });

    const steps: MagicStep[] = [];
    const send = (progress: Extract<CoreEvent, { type: "magic.stream" }>["progress"]) => this.#o.broadcast({ type: "magic.stream", id, progress });
    const onEvent = (e: BuildEvent) => {
      switch (e.type) {
        case "step-start": {
          const step: MagicStep = { id: e.id, tool: e.tool, why: e.why, detail: detailOf(e.tool, e.input) };
          steps.push(step);
          log.debug(`run ${id.slice(0, 8)} ${e.tool}: ${e.why}`, step.detail);
          send({ type: "step", step });
          break;
        }
        case "step-end": {
          const step = steps.find((s) => s.id === e.id);
          if (!step) break;
          step.ms = e.ms;
          step.isError = e.isError;
          step.output = e.output.slice(0, 4000);
          log.debug(`run ${id.slice(0, 8)} ${step.tool} done`, { ms: e.ms, error: e.isError });
          send({ type: "step", step: { ...step } });
          break;
        }
        case "title":
          if (!refining) this.#o.windows.update(id, { title: e.title });
          if (e.icon) this.#o.windows.update(id, { state: { icon: e.icon } });
          send({ type: "title", title: e.title });
          break;
        case "verify":
          send({ type: "verify" });
          break;
        case "repair":
          log.info(`run ${id.slice(0, 8)} repairing: ${e.reason.split("\n")[0]}`);
          send({ type: "repair", reason: e.reason.split("\n")[0]! });
          break;
      }
    };

    const s = this.#o.settings();
    let backend: Backend;
    try {
      backend = this.#o.backend?.(s) ?? this.#o.ai.backend({ tier: "smart", purpose: "magic" });
    } catch (e) {
      done();
      this.#fail(id, prev, (e as Error).message);
      return;
    }
    log.info(`run ${id.slice(0, 8)}${refining ? " (change)" : ""}`, { provider: backend.name, model: backend.model });
    void (async () => {
      // The first widget on a Mac without Deno: get cmd's own copy before building.
      if (!this.#deno() && this.#o.stateDir && this.#o.deno === undefined) {
        const step: MagicStep = { id: 0, tool: "install", why: "Installing Deno for widgets (once)", detail: "deno.com" };
        send({ type: "step", step });
        const t0 = Date.now();
        try {
          await installDeno(this.#o.stateDir);
          send({ type: "step", step: { ...step, ms: Date.now() - t0 } });
        } catch (e) {
          send({ type: "step", step: { ...step, ms: Date.now() - t0, isError: true, output: (e as Error).message } });
          log.warn(`installing Deno failed: ${(e as Error).message}`);
        }
      }
      const ctx = await this.#verifyContext(this.#window(id), widgetId, ac.signal);
      return buildWidget({
        prompt: refining ? refineRequest(prev, text) : text,
        backend,
        widget: ctx,
        workspace: this.#o.workspaceFor?.(w) ?? null,
        explore: s["magic.explore"],
        sandbox: this.#sandbox(),
        deny: magicDenyPaths(),
        noFast: refining,
        signal: ac.signal,
        onEvent,
      });
    })()
      .then((r) => {
        if (this.#runs.get(id) !== ac) return; // superseded
        this.#runs.delete(id);
        done();
        const v = r.verdict;
        log.info(`run ${id.slice(0, 8)} finished`, {
          ok: r.ok,
          usable: v.usable,
          route: r.route,
          kind: v.manifest?.kind ?? null,
          model: r.model,
          ms: r.timings.done,
          steps: steps.length,
          repairs: r.repairs.length,
          tokens: { in: r.usage.input, out: r.usage.output, cacheRead: r.usage.cacheRead, cacheWrite: r.usage.cacheWrite },
          ...(v.problems.length ? { problems: v.problems.length, firstProblem: v.problems[0]!.split("\n")[0] } : {}),
        });
        if (!v.usable || !v.manifest) {
          // Back to the last version that worked, if there is one.
          const last = this.store.latest(widgetId);
          if (last) this.store.checkout(widgetId, last.n);
          return this.#fail(id, prev, v.problems[0]?.split("\n")[0] ?? "The widget couldn't be built.");
        }
        const rev = this.store.snapshot(widgetId, { prompt: text, ok: v.ok, problems: v.ok ? undefined : v.problems.slice(0, 10), model: r.model }, v.shot ? Buffer.from(v.shot, "base64") : undefined);
        const summary = r.summary || undefined;
        this.store.setInfo(widgetId, { ...(this.store.info(widgetId)?.named ? {} : { title: v.manifest.title }), history, summary, usedAt: Date.now(), ...(rev.n === 1 ? { createdAt: Date.now() } : {}) });
        this.#o.libraryChanged?.();
        const keepRefresh = refining && !!prev.refreshByUser;
        const shared: Partial<MagicState> = { revision: rev.n, problems: v.ok ? undefined : v.problems.slice(0, 10), steps, summary, prompt: original, history };
        this.#apply(id, v.manifest, v.html, {
          ...shared,
          refresh: keepRefresh ? (prev.refresh ?? 0) : v.manifest.refresh,
          refreshByUser: keepRefresh || undefined,
          lastData: v.data !== undefined ? { data: v.data, at: Date.now() } : null,
          health: v.data !== undefined ? { ok: true, lastOk: Date.now(), failures: 0 } : undefined,
          answer: undefined,
          source: undefined,
        });
        send({ type: "done" });
        this.#failures.delete(id);
        this.#persistedAt.set(id, Date.now());
        this.#watch(widgetId);
        const st = stateOf(this.#window(id));
        if (st.hasData && st.refresh) this.#schedule(id, st.refresh * 1000);
        // The other windows showing this widget get the change too.
        for (const c of this.#copies(widgetId)) if (c.id !== id) this.#reload(c.id, shared);
      })
      .catch((e: Error) => {
        if (this.#runs.get(id) !== ac) return;
        this.#runs.delete(id);
        done();
        const last = this.store.latest(widgetId);
        if (last) this.store.checkout(widgetId, last.n);
        this.#fail(id, prev, ac.signal.aborted ? "Stopped." : e.message);
      });
  }

  /** The window's state from a widget's manifest and composed view. */
  #apply(id: WindowId, m: WidgetManifest, html: string, extra: Partial<MagicState> = {}): void {
    const s = stateOf(this.#window(id));
    const widgetId = s.widgetId ?? id;
    if (s.widgetId) this.#widgetOf.set(id, s.widgetId);
    const info = this.store.info(widgetId);
    this.#o.windows.update(id, {
      title: info?.named ? info.title : m.title,
      state: {
        phase: "ready",
        kind: m.kind,
        icon: m.icon,
        html: m.kind === "widget" ? html : undefined,
        command: m.command,
        size: m.size,
        refresh: s.refreshByUser && extra.refresh === undefined ? s.refresh : m.refresh,
        hasData: m.kind === "widget" && this.store.read(widgetId, "data.ts") !== null,
        media: m.media,
        kit: m.kit,
        error: undefined,
        ...extra,
      },
    });
  }

  #fail(id: WindowId, prev: MagicState, message: string): void {
    log.warn(`run ${id.slice(0, 8)} failed: ${message}`);
    this.#runs.delete(id);
    // A failed change keeps the widget that worked.
    if (prev.phase === "ready" && (prev.html || prev.command)) {
      this.#o.windows.update(id, { state: { phase: "ready", error: message } });
      this.#schedule(id, 0);
    } else {
      // The request being run is in the state by now (prev is from before it).
      const asked = this.#o.windows.others().find((x) => x.id === id);
      const prompt = asked ? stateOf(asked).prompt : prev.prompt;
      this.#o.windows.update(id, { state: { phase: prompt ? "error" : "empty", error: message } });
    }
    this.#o.broadcast({ type: "magic.stream", id, progress: { type: "error", message } });
  }

  /** Ask the agent to fix what is wrong: the data's last error, or what the checks left. */
  fix(id: WindowId): void {
    const s = stateOf(this.#window(id));
    const what = [s.health && !s.health.ok && s.health.error ? `Its data fails: ${s.health.error}` : "", s.problems?.length ? `The checks found:\n- ${s.problems.join("\n- ")}` : "", s.error ? `Last error: ${s.error}` : ""].filter(Boolean);
    this.run(id, what.length ? `Fix the widget. ${what.join("\n")}` : "Check that the widget still works and fix anything that doesn't.");
  }

  // ── the edit view ──────────────────────────────────────

  widget(id: WindowId): MagicWidgetInfo | null {
    const s = stateOf(this.#window(id));
    if (!s.widgetId || !fs.existsSync(this.store.dir(s.widgetId))) return null;
    const wid = s.widgetId;
    const m = this.store.manifest(wid);
    return {
      dir: this.store.dir(wid),
      files: this.store.files(wid),
      revisions: this.store.revisions(wid).map((r) => ({ n: r.n, at: r.at, prompt: r.prompt, ok: r.ok, problems: r.problems, model: r.model, shot: r.shot ? this.store.shotPath(wid, r.n) : undefined })),
      manifest: m.ok ? { title: m.manifest.title, description: m.manifest.description, refresh: m.manifest.refresh, permissions: m.manifest.permissions, config: m.manifest.config } : null,
      secrets: this.widgetSecrets.status(wid),
      edited: this.store.changedSinceLatest(wid),
    };
  }

  /** Bring back revision n (kept as a new revision). */
  restore(id: WindowId, n: number): void {
    const s = stateOf(this.#window(id));
    if (!s.widgetId) throw new Error("this window has no widget");
    if (this.#building.has(s.widgetId)) throw new Error("the widget is being made");
    const meta = this.store.revisions(s.widgetId).find((r) => r.n === n);
    if (!meta) throw new Error(`no revision ${n}`);
    this.store.checkout(s.widgetId, n);
    const rev = this.store.snapshot(s.widgetId, { prompt: `Back to version ${n}: ${meta.prompt}`.slice(0, 300), ok: meta.ok, problems: meta.problems, model: meta.model });
    for (const c of this.#copies(s.widgetId)) this.#reload(c.id, { revision: rev.n, problems: meta.ok ? undefined : meta.problems });
    this.#o.libraryChanged?.();
  }

  /** The working files changed (a restore, an edit outside cmd): show them and run the data. */
  #reload(id: WindowId, extra: Partial<MagicState> = {}): void {
    const s = stateOf(this.#window(id));
    if (!s.widgetId) return;
    const c = this.store.compose(s.widgetId);
    if (!c.manifest) {
      this.#o.windows.update(id, { state: { error: `The widget's files have a problem: ${c.errors[0]}` } });
      return;
    }
    this.#apply(id, c.manifest, c.html, { ...extra, ...(c.errors.length ? { error: c.errors[0] } : {}) });
    this.#schedule(id, 0);
  }

  /** The person's config values (null or "" resets a field to its default). */
  setConfig(id: WindowId, values: Record<string, unknown>): void {
    const s = stateOf(this.#window(id));
    const next: Record<string, unknown> = { ...s.config };
    for (const [k, v] of Object.entries(values)) {
      if (v === null || v === "" || v === undefined) delete next[k];
      else if (["string", "number", "boolean"].includes(typeof v)) next[k] = v;
    }
    this.#o.windows.update(id, { state: { config: next } });
    this.#schedule(id, 0);
  }

  /** A secret config value; kept per widget, so every copy (and a later one) has it. */
  setSecret(id: WindowId, key: string, value: string | null): void {
    const s = stateOf(this.#window(id));
    if (!s.widgetId) throw new Error("this window has no widget");
    if (!/^[A-Za-z_]\w*$/.test(key)) throw new Error(`bad key: ${key}`);
    this.widgetSecrets.set(s.widgetId, key, value);
    for (const c of this.#copies(s.widgetId)) this.#schedule(c.id, 0);
  }

  /** The widget's cmd.state.set. */
  setState(id: WindowId, key: string, value: unknown): void {
    const s = stateOf(this.#window(id));
    if (typeof key !== "string" || !key || key.length > 200) throw new Error("bad key");
    const kv = { ...s.kv };
    if (value === null || value === undefined) delete kv[key];
    else kv[key] = value;
    if (JSON.stringify(kv).length > 256 * 1024) throw new Error("cmd.state is full (256 KB)");
    this.#o.windows.update(id, { state: { kv } });
  }

  /** The person's answer to the widget's media request: allow or decline the origins it asks for. */
  media(id: WindowId, allow: boolean): void {
    const s = stateOf(this.#window(id));
    const asked = requestedMedia(s);
    const allowed = s.mediaAllowed ?? [];
    const denied = s.mediaDenied ?? [];
    const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
    this.#o.windows.update(id, {
      state: allow
        ? { mediaAllowed: union(allowed, asked), mediaDenied: denied.filter((o) => !asked.includes(o)) }
        : { mediaDenied: union(denied, asked.filter((o) => !allowed.includes(o))) },
    });
  }

  async runtime(): Promise<MagicRuntime> {
    const env = this.#deno();
    const p = await this.#o.previewer?.().catch(() => null);
    return { deno: env?.deno ?? null, version: env ? denoVersion(env.deno) : null, sandbox: process.platform === "darwin" && sandboxAvailable(), previewer: p?.name ?? null };
  }

  async installRuntime(): Promise<MagicRuntime> {
    if (!this.#o.stateDir) throw new Error("no state folder to install Deno into");
    log.info("installing Deno");
    await installDeno(this.#o.stateDir);
    // Windows waiting for Deno can run now.
    for (const w of this.#o.windows.others()) if (w.kind === "magic" && stateOf(w).phase === "ready") this.#schedule(w.id, 0);
    return this.runtime();
  }

  cancel(id: WindowId): void {
    this.#runs.get(id)?.abort();
  }

  // ── refreshing ─────────────────────────────────────────

  /** Run the data now (Refresh Now), then continue on the interval. */
  refresh(id: WindowId): void {
    this.#window(id);
    this.#schedule(id, 0);
  }

  /** The person's interval (Refresh Every); 0 runs the data only on Refresh Now. */
  setRefresh(id: WindowId, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`magic.setRefresh: bad interval ${seconds}`);
    const refresh = seconds === 0 ? 0 : Math.max(MIN_REFRESH_S, Math.round(seconds));
    const s = stateOf(this.#window(id));
    this.#o.windows.update(id, { state: { refresh, refreshByUser: true } });
    if (s.phase !== "ready" || !(s.source || s.hasData)) return;
    if (refresh) this.#schedule(id, refresh * 1000);
    else this.stop(id);
  }

  stop(id: WindowId): void {
    clearTimeout(this.#timers.get(id));
    this.#timers.delete(id);
    this.#parked.delete(id);
  }

  dispose(): void {
    this.#disposed = true;
    for (const ac of this.#runs.values()) ac.abort();
    for (const t of this.#timers.values()) clearTimeout(t);
    for (const t of this.#editTimers.values()) clearTimeout(t);
    for (const wt of this.#watchers.values()) wt.close();
    this.#runs.clear();
    this.#timers.clear();
    this.#watchers.clear();
  }

  #schedule(id: WindowId, delay: number): void {
    if (this.#disposed) return;
    this.stop(id);
    this.#timers.set(
      id,
      setTimeout(() => {
        // Nobody to show it to: no data run every few seconds while the app is closed.
        if (this.#o.watched && !this.#o.watched()) return void (this.#timers.delete(id), this.#parked.add(id));
        void this.#tick(id);
      }, delay),
    );
  }

  /** A UI connected: refresh what came due meanwhile, now. */
  resume(): void {
    const ids = [...this.#parked];
    this.#parked.clear();
    for (const id of ids) this.#schedule(id, 0);
  }

  async #tick(id: WindowId): Promise<void> {
    let w: AppWindow;
    try {
      w = this.#window(id);
    } catch {
      return this.stop(id);
    }
    const s = stateOf(w);
    if (s.phase !== "ready" || this.#runs.has(id)) return;
    if (s.widgetId) return this.#tickWidget(w, s);
    if (s.source) return this.#tickLegacy(w, s);
  }

  async #tickWidget(w: AppWindow, s: MagicState): Promise<void> {
    const id = w.id;
    if (!s.hasData) return;
    const m = this.store.manifest(s.widgetId!);
    const deno = this.#deno();
    const t0 = Date.now();
    let ok = false;
    let data: unknown;
    let error = "";
    let retryAfter: number | undefined;
    let permission = false;
    let statusLine: MagicStatus | null = null;
    let notify: MagicNotify[] = [];
    if (!m.ok) error = `manifest.json: ${m.errors[0]}`;
    else if (!deno) error = "Deno isn't installed (the widget's Health tab installs it)";
    else {
      const secrets = this.widgetSecrets.get(s.widgetId!);
      const sock = this.#o.widgetSocket;
      const r = await runData(this.store.dir(s.widgetId!), m.manifest, { ...deno, cwd: this.#cwd(w), config: { ...configValues(m.manifest, s.config), ...secrets }, socket: sock ? { path: sock.path, token: sock.token(s.widgetId!, w.workspaceId ?? null, m.manifest.permissions.events) } : null });
      ok = r.ok;
      data = r.data;
      retryAfter = r.retryAfter;
      permission = !!r.permission;
      statusLine = r.statusLine ?? null;
      notify = r.notify ?? [];
      if (!r.ok) error = describeDataError(r, Object.values(secrets));
    }
    if (this.#disposed || !this.#o.windows.others().some((x) => x.id === id) || this.#runs.has(id)) return;
    this.#afterRun(id, { ok, data, error, retryAfter, permission, ms: Date.now() - t0 });
    if (ok) this.#signals(id, statusLine, notify);
  }

  async #tickLegacy(w: AppWindow, s: MagicState): Promise<void> {
    const t0 = Date.now();
    const r = await runSource(s.source!, { cwd: this.#cwd(w), deny: magicDenyPaths(), sandbox: this.#sandbox() });
    if (!this.#o.windows.others().some((x) => x.id === w.id)) return;
    this.#afterRun(w.id, { ok: r.ok, data: r.data, error: r.error ?? "failed", ms: Date.now() - t0 });
  }

  /** A data run finished: broadcast it, keep health, and decide when to run next. */
  #afterRun(id: WindowId, r: { ok: boolean; data?: unknown; error?: string; retryAfter?: number; permission?: boolean; ms: number }): void {
    const s = stateOf(this.#window(id));
    const at = Date.now();
    const prevHealth = s.health;
    if (r.ok) {
      log.debug(`data ${id.slice(0, 8)} refreshed`, { ms: r.ms });
      this.#failures.delete(id);
      this.#o.broadcast({ type: "magic.data", id, data: r.data, at });
      const recovered = prevHealth && !prevHealth.ok;
      if (recovered || at - (this.#persistedAt.get(id) ?? 0) >= PERSIST_DATA_MS) {
        this.#persistedAt.set(id, at);
        const health: MagicHealth = { ok: true, lastOk: at, failures: 0 };
        this.#o.windows.update(id, { state: { lastData: { data: r.data, at }, health, ...(s.error?.startsWith("Interrupted") ? { error: undefined } : {}) } });
      }
    } else {
      const failures = (this.#failures.get(id) ?? 0) + 1;
      this.#failures.set(id, failures);
      log.warn(`data ${id.slice(0, 8)} failed (${failures} in a row): ${(r.error ?? "failed").split("\n")[0]}`, { ms: r.ms });
      this.#o.broadcast({ type: "magic.data", id, data: null, at, error: r.error ?? "failed" });
    }
    // Next run: the interval; after failures, back off (up to 10×), and never before the server allows.
    const refresh = Math.max(MIN_REFRESH_S, s.refresh ?? 0);
    const failures = this.#failures.get(id) ?? 0;
    let delay = s.refresh ? refresh * 1000 * Math.min(10, 2 ** failures) : 0;
    if (!r.ok && r.retryAfter) delay = Math.max(delay, (r.retryAfter + 1) * 1000);
    if (!r.ok) {
      const health: MagicHealth = { ok: false, lastOk: prevHealth?.lastOk ?? s.lastData?.at, error: r.error, errorAt: at, failures, retryAt: delay ? at + delay : undefined, permission: r.permission || undefined };
      if (!prevHealth || prevHealth.ok || prevHealth.error !== health.error || failures === 1 || failures % 5 === 0) this.#o.windows.update(id, { state: { health } });
      this.#maybeAutoFix(id, failures, r);
    }
    if (delay) this.#schedule(id, delay);
  }

  /**
   * What a successful run reported besides its data: the status line, and
   * notifications for keys the previous run didn't report (the first run of a
   * widget only records them, so making or restoring one doesn't notify).
   */
  #signals(id: WindowId, status: MagicStatus | null, notify: MagicNotify[]): void {
    const w = this.#window(id);
    const s = stateOf(w);
    const patch: Partial<MagicState> = {};
    if (JSON.stringify(s.status ?? null) !== JSON.stringify(status)) patch.status = status;
    const keys = notify.map((n) => n.key);
    const fresh = s.notified ? notify.filter((n) => !s.notified!.includes(n.key)) : [];
    if (!s.notified || keys.join("\n") !== s.notified.join("\n")) patch.notified = keys;
    if (fresh.length) {
      const latest = fresh.at(-1)!;
      const urgent = fresh.some((n) => n.urgent !== false);
      patch.attention = { kind: "notify", text: latest.title || latest.body, urgent, at: Date.now() };
      for (const n of fresh) this.#o.notify?.({ windowId: id, title: n.title || w.title, body: n.title ? n.body : "", urgent: n.urgent !== false, muted: !!s.muted });
    }
    if (Object.keys(patch).length) this.#o.windows.update(id, { state: patch });
  }

  /** magic.mute: notifications only mark the window. */
  setMuted(id: WindowId, muted: boolean): void {
    this.#window(id);
    this.#o.windows.update(id, { state: { muted: muted || undefined } });
  }

  /** magic.autoFix: data that keeps failing for reasons other than a busy server gets one agent fix per revision. */
  #maybeAutoFix(id: WindowId, failures: number, r: { retryAfter?: number; error?: string }): void {
    if (!this.#o.settings()["magic.autoFix"] || failures < AUTO_FIX_AFTER || r.retryAfter) return;
    if (/timed out|fetch failed|ENOTFOUND|ECONN|network|HTTP 5\d\d|HTTP 429|rate limit|Deno isn't installed/i.test(r.error ?? "")) return;
    const s = stateOf(this.#window(id));
    if (this.#autoFixed.get(id) === s.revision) return;
    this.#autoFixed.set(id, s.revision ?? 0);
    log.info(`data ${id.slice(0, 8)} keeps failing; asking the agent to fix it`);
    try {
      this.fix(id);
    } catch (e) {
      log.warn(`auto fix of ${id.slice(0, 8)} didn't start: ${(e as Error).message}`);
    }
  }

  // ── hand edits ─────────────────────────────────────────

  /** Watch a widget folder: files edited outside cmd (an editor, Claude Code) show up and become a revision. */
  #watch(widgetId: string): void {
    if (this.#watchers.has(widgetId) || this.#disposed) return;
    try {
      const wt = fs.watch(this.store.dir(widgetId), { persistent: false }, (_ev, name) => {
        if (!name || !/^(manifest\.json|data\.ts|view\.html|view\.ts|static\.json)$/.test(String(name))) return;
        clearTimeout(this.#editTimers.get(widgetId));
        this.#editTimers.set(widgetId, setTimeout(() => this.#edited(widgetId), 400));
      });
      wt.on("error", () => this.#watchers.delete(widgetId));
      this.#watchers.set(widgetId, wt);
    } catch {}
  }

  #unwatch(widgetId: string): void {
    this.#watchers.get(widgetId)?.close();
    this.#watchers.delete(widgetId);
    clearTimeout(this.#editTimers.get(widgetId));
    this.#editTimers.delete(widgetId);
  }

  #edited(widgetId: string): void {
    if (this.#building.has(widgetId)) return; // the agent is writing
    const copies = this.#copies(widgetId).filter((w) => stateOf(w).phase === "ready");
    if (!copies.length || !this.store.changedSinceLatest(widgetId)) return;
    const c = this.store.compose(widgetId);
    if (!c.manifest) {
      for (const w of copies) this.#o.windows.update(w.id, { state: { error: `The widget's files have a problem: ${c.errors[0]}` } });
      return;
    }
    const rev = this.store.snapshot(widgetId, { prompt: "Edited by hand", ok: !c.errors.length, problems: c.errors.length ? c.errors : undefined });
    if (!this.store.info(widgetId)?.named) this.store.setInfo(widgetId, { title: c.manifest.title });
    log.info(`widget ${widgetId.slice(0, 8)} edited by hand (revision ${rev.n})`);
    for (const w of copies) this.#reload(w.id, { revision: rev.n, problems: undefined });
    this.#o.libraryChanged?.();
  }

  // ── the library ────────────────────────────────────────

  /** Every widget that was built, most recently used first, with the windows showing it. */
  library(): MagicLibraryEntry[] {
    const shown = new Map<string, WindowId[]>();
    for (const w of this.#o.windows.others()) {
      const wid = w.kind === "magic" ? stateOf(w).widgetId : undefined;
      if (wid) shown.set(wid, [...(shown.get(wid) ?? []), w.id]);
    }
    return this.store
      .ids()
      .flatMap((id) => {
        const info = this.store.info(id);
        const last = this.store.latest(id);
        if (!info || !last) return [];
        const m = this.store.manifest(id);
        return [{ id, ...info, description: m.ok ? m.manifest.description : undefined, revision: last.n, shot: last.shot ? this.store.shotPath(id, last.n) : undefined, windows: shown.get(id) ?? [] }];
      })
      .sort((a, b) => b.usedAt - a.usedAt);
  }

  /**
   * A Magic window was opened for a widget already in the library
   * (window.open { kind: "magic", input: { widgetId } }): show it and run its data.
   */
  opened(id: WindowId): void {
    const s = stateOf(this.#window(id));
    if (!s.widgetId || s.phase !== "empty") return;
    const info = this.store.info(s.widgetId);
    if (!info) return void this.#o.windows.update(id, { state: { widgetId: undefined } });
    this.#widgetOf.set(id, s.widgetId);
    this.store.setInfo(s.widgetId, { usedAt: Date.now() });
    this.#o.windows.update(id, { state: { prompt: info.history[0] ?? "", history: info.history, summary: info.summary } });
    this.#reload(id, { revision: this.store.latest(s.widgetId)?.n });
    this.#watch(s.widgetId);
    this.#o.libraryChanged?.();
  }

  /** Name a widget; the name sticks across changes and hand edits. */
  renameWidget(widgetId: string, title: string): void {
    const t = title.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!t) throw new Error("a widget needs a name");
    if (!this.store.info(widgetId)) throw new Error(`no such widget: ${widgetId}`);
    this.store.setInfo(widgetId, { title: t, named: true });
    for (const w of this.#copies(widgetId)) this.#o.windows.update(w.id, { title: t });
    this.#o.libraryChanged?.();
  }

  /** A separate widget with the same files, revisions and secrets, to change on its own. Returns its id. */
  duplicateWidget(widgetId: string): string {
    const info = this.store.info(widgetId);
    if (!info) throw new Error(`no such widget: ${widgetId}`);
    const id = randomUUID();
    fs.cpSync(this.store.dir(widgetId), this.store.dir(id), { recursive: true });
    const now = Date.now();
    this.store.setInfo(id, { title: `${info.title} copy`, named: true, createdAt: now, usedAt: now });
    for (const [k, v] of Object.entries(this.widgetSecrets.get(widgetId))) this.widgetSecrets.set(id, k, v);
    this.#o.libraryChanged?.();
    return id;
  }

  /** Delete a widget from the library: its folder, revisions and secrets. Not while a window shows it. */
  deleteWidget(widgetId: string): void {
    if (!this.store.info(widgetId)) throw new Error(`no such widget: ${widgetId}`);
    if (this.#copies(widgetId).length) throw new Error("This widget is in a workspace; remove it from there first.");
    this.#unwatch(widgetId);
    this.widgetSecrets.forget(widgetId);
    this.store.delete(widgetId);
    this.#o.libraryChanged?.();
  }

  // ── closing ────────────────────────────────────────────

  /** A window closed: its widget stays in the library, unless it never got built (a draft). */
  #removed(id: WindowId): void {
    this.cancel(id);
    this.stop(id);
    const widgetId = this.#widgetOf.get(id);
    this.#widgetOf.delete(id);
    if (!widgetId) return;
    if (this.#building.get(widgetId) === id) this.#building.delete(widgetId);
    const shown = [...this.#widgetOf.values()].includes(widgetId);
    if (!shown) this.#unwatch(widgetId);
    if (this.store.latest(widgetId)) {
      this.store.setInfo(widgetId, { usedAt: Date.now() });
      this.#o.libraryChanged?.();
    } else if (!shown) this.store.delete(widgetId);
  }

  /** Before the library, closed windows' widgets went to widgets/closed/<id>-<time>; they belong in the library. */
  #migrateClosed(): void {
    const closed = path.join(this.store.root, "closed");
    let names: string[];
    try {
      names = fs.readdirSync(closed);
    } catch {
      return;
    }
    for (const name of names) {
      const from = path.join(closed, name);
      try {
        const id = name.replace(/-\d+$/, "");
        const to = [id, name].map((n) => path.join(this.store.root, n)).find((d) => /^[\w-]+$/.test(path.basename(d)) && !fs.existsSync(d));
        if (to && fs.existsSync(path.join(from, "revisions"))) fs.renameSync(from, to);
        else fs.rmSync(from, { recursive: true, force: true });
      } catch (e) {
        log.warn(`could not move ${name} into the library: ${(e as Error).message}`);
      }
    }
    fs.rmSync(closed, { recursive: true, force: true });
  }
}

/**
 * A change's request: everything the person asked so far (the first request
 * and each change, in order, so details from any of them survive) and the new
 * change. The widget's current files go into the request separately. A v1
 * window (no widget folder yet) brings its old view, to be rebuilt as a widget.
 */
export function refineRequest(prev: MagicState, change: string): string {
  const asked = prev.history?.length ? prev.history : [prev.prompt];
  const earlier = asked.length === 1 ? `The window was made from this request:\n${asked[0]}` : `The window was made from these requests, in order (the first, then changes):\n${asked.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;
  const legacy = !prev.widgetId
    ? prev.kind === "terminal" && prev.command
      ? `It currently offers the terminal command: ${prev.command}`
      : prev.html
        ? `It was made before widgets had files of their own: rebuild it as a widget (manifest.json, data.ts, view.html, view.ts).${prev.source ? `\nIts data came from ${prev.source.type === "fetch" ? `GET ${prev.source.url}` : `the command: ${prev.source.command}`}` : ""}\nIts old view:\n${prev.html}`
        : ""
    : "";
  return [earlier, `Change it as asked, keeping what still fits and everything those requests asked for that the change doesn't override: ${change}`, legacy].filter(Boolean).join("\n\n");
}
