// Magic in the app (docs/56, "Magic on V3"; core.magic): a request in a Magic window is built
// into a package in the packages folder (widgetsHome(), named from the request), the agent's
// steps streamed to the window (magic.stream). A Mac without Deno is asked once whether to
// download it first. When the package asks for permissions, the build pauses on a step and the
// grants sheet asks (widget.ask; one sheet, shown for the Library's entry), and the build goes
// on with the answer. A finished package is marked as made with Magic (package.json's
// cmd.magic), kept as a version in the instance's widget-packages/<name>/revisions, and the
// window becomes the package's widget in place ("pkg:<name>/<id>", drawn by the kit); an
// obvious command, or a request a program answers better, ends as a terminal to open instead.
// Edit with Magic and Fix open a Magic window beside a package window and build the change into
// the same package; its windows reload once at the end. The edit view (⌘E) lists the versions
// and brings one back (Restore, never into a linked package's own folder).

import fs from "node:fs";
import path from "node:path";
import { parsePackageKind, type AppWindow, type CoreEvent, type MagicPackageBuild, type MagicPackageInfo, type MagicState, type MagicStep, type Settings, type WidgetPermissions, type WindowId } from "@cmd/protocol";
import { logger, widgetPackageData, widgetsHome } from "@cmd/protocol/node";
import type { Backend } from "../../ai/backends.ts";
import type { CoreContext } from "../../kernel/context.ts";
import { magicDenyPaths } from "../../lib/paths-deny.ts";
import { cmdVersion, type WidgetPackage } from "../../widgets/package.ts";
import { linkOf, listFiles, PackageRevisions } from "../../widgets/revisions.ts";
import { DENO_VERSION } from "../../widgets/deno.ts";
import { RELOAD_DEBOUNCE_MS } from "../../widgets/reload.ts";
import { sandboxAvailable, type SandboxMode } from "../../lib/sandbox.ts";
import { buildPackage, stepLog, type BuildEvent, type PackageBuildResult } from "./build.ts";
import { readMark, writeMark } from "./files.ts";
import { scriptFromEnv, scriptedBackend } from "./scripted.ts";
import type { Toolchain } from "./toolchain.ts";
import { permissionLines } from "./words.ts";

const log = logger("magic");

type Ctx = Pick<CoreContext, "windows" | "windowTypes" | "workspaces" | "settings" | "ai" | "broadcast" | "library" | "previews" | "opened" | "closed">;

export interface MagicPackagesOptions {
  /** The instance's state folder (revisions; grants are the host's). null: a temporary one (tests). */
  stateDir: string | null;
  /** Tests: the model (default: the AI service's smart tier). */
  backend?: (s: Settings) => Backend;
  sandbox?: SandboxMode;
  /** Tests: the toolchain (default: the checkout's, else package.json only). */
  toolchain?: Toolchain;
  /** Where packages are made (default: widgetsHome()). */
  home?: () => string;
}

const STOP = new Set("a an the of in on at to for from with and or my me our this that these those is are was be it its show shows showing what which who how many much me please live latest current i want see give list widget".split(" "));

/** A package name from a request: its first few words that say something, lowercase, dashed. */
export function slugOf(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w));
  return (words.slice(0, 4).join("-") || "widget").slice(0, 40).replace(/-+$/, "");
}

/** "Wants to reach api.github.com and see this workspace": the permission step's words. */
export function wantsText(p: WidgetPermissions): string {
  const lines = permissionLines(p);
  if (!lines.length) return "Wants nothing";
  return `Wants to ${lines.length === 1 ? lines[0] : `${lines.slice(0, -1).join(", ")} and ${lines.at(-1)}`}`;
}

const stateOf = (w: AppWindow) => w.state as MagicState;

export class MagicPackages {
  #c: Ctx;
  #o: MagicPackagesOptions;
  #runs = new Map<WindowId, AbortController>();
  #stateDir: string;

  constructor(c: Ctx, o: MagicPackagesOptions) {
    this.#c = c;
    this.#o = o;
    this.#stateDir = o.stateDir ?? fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "cmd-magic-pkg-state-"));
    // A core without a state folder (tests) never writes into the person's packages folder.
    if (!o.stateDir && !o.home) {
      const home = path.join(this.#stateDir, "widgets");
      this.#o = { ...o, home: () => home };
    }
    c.library.shotOf = (name) => new PackageRevisions(this.#stateDir, name).latest()?.shot;
    c.windows.on("removed", (id) => this.cancel(id));
    for (const w of c.windows.others()) if (w.kind === "magic" && stateOf(w).phase === "working") this.#interrupted(w);
  }

  /** A build can't survive the core: what it left goes (a new package) or back to its last version, and the window says so. */
  #interrupted(w: AppWindow): void {
    const pkg = stateOf(w).pkg;
    if (pkg) {
      const dir = path.join(this.#home(), pkg.name);
      const last = new PackageRevisions(this.#stateDir, pkg.name).latest();
      if (last) new PackageRevisions(this.#stateDir, pkg.name).checkout(dir, last.n);
      else if (!pkg.editing) fs.rmSync(dir, { recursive: true, force: true });
    }
    this.#c.windows.update(w.id, { state: { phase: stateOf(w).command ? "ready" : "error", askRuntime: undefined, pkg: pkg ? { name: pkg.name, ...(pkg.editing ? { editing: pkg.editing } : {}) } : undefined, error: "Interrupted: cmd restarted while this was being made." } });
  }

  /** The packages folder the core reads (widgetsHome() when it was made). */
  #home(): string {
    return this.#o.home?.() ?? this.#c.library.packages.home ?? widgetsHome();
  }

  #window(id: WindowId): AppWindow | null {
    return this.#c.windows.others().find((w) => w.id === id) ?? null;
  }

  building(id: WindowId): boolean {
    return this.#runs.has(id);
  }

  cancel(id: WindowId): void {
    this.#runs.get(id)?.abort();
  }

  dispose(): void {
    for (const ac of this.#runs.values()) ac.abort();
    this.#runs.clear();
  }

  /** A free package name for a request. */
  #name(prompt: string): string {
    const base = slugOf(prompt);
    const taken = (n: string) => fs.existsSync(path.join(this.#home(), n)) || this.#c.library.packages.list().some((e) => e.folder === n);
    let n = base;
    for (let i = 2; taken(n); i++) n = `${base}-${i}`;
    return n;
  }

  #backend(): Backend {
    const script = scriptFromEnv();
    if (script) return scriptedBackend(script);
    return this.#o.backend?.(this.#c.settings.settings) ?? this.#c.ai.backend({ tier: "smart", purpose: "magic" });
  }

  #sandbox(): SandboxMode {
    return this.#o.sandbox ?? (process.env.CMD_MAGIC_UNSANDBOXED === "1" && !sandboxAvailable() ? "off" : "required");
  }

  /** Build the window's request into a package (new, or the one it edits). */
  run(id: WindowId, prompt: string): void {
    const text = prompt.trim();
    if (!text) throw new Error("magic.run: empty request");
    const w = this.#window(id);
    if (!w) throw new Error(`not a Magic window: ${id}`);
    const prev = stateOf(w);
    if (this.#runs.has(id)) throw new Error("This window is making a widget already.");
    const editing = prev.pkg?.editing;
    const name = editing && prev.pkg ? prev.pkg.name : this.#name(text);
    const dir = path.join(this.#home(), name);
    const fresh = !fs.existsSync(path.join(dir, "package.json"));
    const mark = readMark(dir);
    const original = mark?.request ?? (fresh ? text : prev.prompt || text);
    const history = [...(prev.history?.length && !fresh ? prev.history : mark ? [mark.request] : []), text].slice(-20);
    fs.mkdirSync(dir, { recursive: true });
    const ac = new AbortController();
    this.#runs.set(id, ac);
    const { library } = this.#c;
    library.building.add(name);
    library.reloader.paused.add(name);
    const pkg: MagicPackageBuild = { name, ...(editing ? { editing } : {}) };
    this.#c.windows.update(id, { title: fresh ? "Magic Widget" : w.title, state: { prompt: original, phase: "working", error: undefined, steps: [], history, pkg } });

    const send = (progress: Extract<CoreEvent, { type: "magic.stream" }>["progress"]) => this.#c.broadcast({ type: "magic.stream", id, progress });
    const stepEvent = (step: MagicStep) => send({ type: "step", step: { ...step } });
    const trail = stepLog(stepEvent);
    const onEvent = (e: BuildEvent) => {
      trail.take(e);
      if (e.type === "title") {
        if (fresh && this.#window(id)) this.#c.windows.update(id, { title: e.title, state: e.icon ? { icon: e.icon } : {} });
        send({ type: "title", title: e.title });
      } else if (e.type === "verify") send({ type: "verify" });
      else if (e.type === "repair") send({ type: "repair", reason: e.reason.split("\n")[0]! });
    };

    // The permission step: a step in the build view while the grants sheet asks.
    let askSeq = 1_000_000;
    const ask = (p: WidgetPackage): Promise<{ allow: boolean; reason?: string }> =>
      new Promise((resolve) => {
        const step: MagicStep = { id: ++askSeq, tool: "permissions", why: wantsText(p.permissions), detail: name };
        trail.add(step);
        const t0 = Date.now();
        library.packages.scan();
        const done = (allow: boolean, reason?: string) => {
          off();
          ac.signal.removeEventListener("abort", stopped);
          Object.assign(step, { ms: Date.now() - t0, isError: !allow, output: allow ? "Allowed" : (reason ?? "Declined") });
          stepEvent(step);
          if (this.#window(id)) this.#c.windows.update(id, { state: { pkg: { ...pkg, asking: false } } });
          log.info(`run ${id.slice(0, 8)} ${name}: permissions ${allow ? "allowed" : "declined"}`);
          resolve({ allow, ...(reason ? { reason } : {}) });
        };
        const off = library.host.onAnswer((n, allow) => n === name && done(allow));
        const stopped = () => done(false, "Stopped");
        ac.signal.addEventListener("abort", stopped, { once: true });
        if (this.#window(id)) this.#c.windows.update(id, { state: { pkg: { ...pkg, asking: true } } });
        try {
          library.host.ask(name);
        } catch (e) {
          done(false, (e as Error).message);
        }
      });

    const space = this.#c.workspaces.get(w.workspaceId);
    const s = this.#c.settings.settings;
    let backend: Backend;
    try {
      backend = this.#backend();
    } catch (e) {
      return this.#end(id, name, ac, { error: (e as Error).message, fresh });
    }
    log.info(`run ${id.slice(0, 8)} package ${name}${fresh ? "" : " (change)"}`, { provider: backend.name, model: backend.model });
    const change = fresh ? text : `The widget was made for: ${original}\n\nChange it as asked, keeping what still fits: ${text}`;
    this.#deno(id, ac.signal, stepEvent).then(() => buildPackage({
      prompt: change,
      backend,
      dir,
      name,
      cwd: space?.root ?? this.#c.workspaces.home().root,
      workspace: space && !space.home ? { name: space.name, root: space.root } : null,
      explore: s["magic.explore"],
      maxTokens: s["magic.maxTokens"] || undefined,
      sandbox: this.#sandbox(),
      deny: magicDenyPaths(),
      noFast: !fresh,
      toolchain: this.#o.toolchain,
      previewer: () => this.#c.previews.previewer(),
      ask,
      granted: () => library.host.granted(name)?.permissions ?? null,
      cmdVersion: cmdVersion(),
      signal: ac.signal,
      onEvent,
    })).then(
      (r) => this.#finish(id, name, ac, r, { fresh, text, original, history, steps: trail.steps, editing }),
      (e: Error) => this.#end(id, name, ac, { error: ac.signal.aborted ? "Stopped." : e.message, fresh }),
    );
  }

  /**
   * On a Mac without Deno (what a widget's process runs on), the first build asks whether to
   * download it (MagicState.askRuntime: magic.installRuntime is yes, magic.skipRuntime not now)
   * and waits for the answer; the download is a step.
   */
  async #deno(id: WindowId, signal: AbortSignal, step: (s: MagicStep) => void): Promise<void> {
    const deno = this.#c.library.deno;
    if (deno.find() || !deno.canInstall) return;
    const asked = () => {
      log.info(`run ${id.slice(0, 8)} asks to download Deno`);
      this.#c.windows.update(id, { state: { askRuntime: true } });
    };
    const yes = await deno.ask(signal, asked);
    if (this.#window(id)?.state.askRuntime) this.#c.windows.update(id, { state: { askRuntime: undefined } });
    if (signal.aborted) throw new Error("Stopped.");
    if (!yes) return;
    const s: MagicStep = { id: 0, tool: "install", why: "Installing Deno for widgets (once)", detail: `Deno ${DENO_VERSION}` };
    step(s);
    const t0 = Date.now();
    try {
      await yes.install;
      step({ ...s, ms: Date.now() - t0 });
    } catch (e) {
      step({ ...s, ms: Date.now() - t0, isError: true, output: (e as Error).message });
    }
  }

  /** The build's result into the window: the package's widget, a terminal, or why not. */
  #finish(id: WindowId, name: string, ac: AbortController, r: PackageBuildResult, o: { fresh: boolean; text: string; original: string; history: string[]; steps: MagicStep[]; editing?: WindowId }): void {
    if (this.#runs.get(id) !== ac) return;
    const dir = path.join(this.#home(), name);
    const v = r.verdict;
    log.info(`run ${id.slice(0, 8)} ${name} finished`, { ok: r.ok, usable: v.usable, ending: r.ending?.kind ?? null, stopped: r.stopped ?? null, model: r.model, ms: r.timings.done, steps: r.trace.length, repairs: r.repairs.length, tokens: { in: r.usage.input, out: r.usage.output, cacheRead: r.usage.cacheRead }, prompt: r.promptHash, ...(v.problems.length ? { firstProblem: v.problems[0]!.split("\n")[0] } : {}) });
    if (r.ending?.kind === "terminal") {
      const t = r.ending;
      this.#end(id, name, ac, { fresh: o.fresh, keep: false });
      this.#c.windows.update(id, { title: t.title, state: { phase: "ready", kind: "terminal", command: t.command, icon: t.icon ?? "terminal", size: "m", pkg: undefined, steps: o.steps, summary: r.summary || undefined } });
      return void this.#c.broadcast({ type: "magic.stream", id, progress: { type: "done" } });
    }
    const why = r.stopped ?? (r.ending?.kind === "needs-program" ? `${r.ending.reason} (It would need ${r.ending.programs.join(", ")} in a way widgets can't run: only read-only commands.)` : !v.usable ? (v.problems[0]?.split("\n")[0] ?? "The widget couldn't be built.") : null);
    if (why || !v.pkg) return this.#end(id, name, ac, { error: why ?? "The widget couldn't be built.", fresh: o.fresh });

    const revs = new PackageRevisions(this.#stateDir, name);
    // The mark first, so the version keeps it (Restore brings back a package Magic made).
    writeMark(dir, { request: o.original, madeAt: readMark(dir)?.madeAt ?? new Date().toISOString(), revisions: (revs.latest()?.n ?? 0) + 1 });
    const rev = revs.snapshot(dir, { prompt: o.text, ok: v.ok, ...(v.ok ? {} : { problems: v.problems.slice(0, 10) }), model: r.model }, v.shot ? Buffer.from(v.shot, "base64") : undefined);
    this.#end(id, name, ac, { fresh: o.fresh, keep: true });
    const { library } = this.#c;
    library.packages.scan();
    const widget = library.packages.list().find((e) => e.ok && e.pkg.name === name);
    const kind = widget?.ok ? widget.pkg.widgets[0]?.kind : undefined;
    if (!kind || !this.#c.windowTypes.get(kind)) return this.#fail(id, "The package was made, but cmd can't read it.");
    library.host.reload(name);
    this.#c.broadcast({ type: "magic.stream", id, progress: { type: "done" } });
    if (o.editing && this.#c.windows.others().some((x) => x.id === o.editing)) {
      // The edited window shows the change (it reloaded); this one's job is done.
      this.#c.windows.close(id);
    } else if (this.#window(id)) {
      this.#c.windows.update(id, { kind });
      this.#c.windows.update(id, { state: { magic: { problems: v.ok ? undefined : v.problems.slice(0, 10), summary: r.summary || undefined, revision: rev.n } } });
    }
    library.changed();
  }

  /** The run is over: forget it, let the package be listed and reloaded; a new package that didn't come to be is removed. */
  #end(id: WindowId, name: string, ac: AbortController, o: { fresh: boolean; keep?: boolean; error?: string }): void {
    if (this.#runs.get(id) === ac) this.#runs.delete(id);
    const { library } = this.#c;
    library.building.delete(name);
    library.reloader.paused.delete(name);
    const dir = path.join(this.#home(), name);
    if (!o.keep) {
      if (o.fresh) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(widgetPackageData(this.#stateDir, name), { recursive: true, force: true });
      } else {
        // A change that failed: back to the version that worked.
        const revs = new PackageRevisions(this.#stateDir, name);
        const last = revs.latest();
        if (last) revs.checkout(dir, last.n);
      }
      library.packages.scan();
    }
    if (o.error) this.#fail(id, o.error);
  }

  #fail(id: WindowId, message: string): void {
    log.warn(`run ${id.slice(0, 8)} failed: ${message}`);
    const w = this.#window(id);
    if (!w) return;
    this.#c.windows.update(id, { state: { phase: stateOf(w).prompt ? "error" : "empty", error: message } });
    this.#c.broadcast({ type: "magic.stream", id, progress: { type: "error", message } });
  }

  /** Edit with Magic (and Fix): a Magic window beside a package window made with Magic, building into its package. */
  edit(windowId: WindowId, o: { prompt?: string; fix?: boolean }): AppWindow {
    const target = this.#c.windows.others().find((w) => w.id === windowId);
    const ref = target && parsePackageKind(target.kind);
    if (!target || !ref) throw new Error("Only a widget's window can be changed with Magic.");
    const entry = this.#c.library.packages.list().find((e) => e.ok && e.pkg.name === ref.name);
    if (!entry?.ok || !entry.pkg.magic || entry.builtin) throw new Error(`${target.title} wasn't made with Magic, so Magic can't change it.`);
    const status = this.#c.library.host.status(windowId);
    const fix = o.fix ? `Fix the widget.${status?.state === "stopped" ? ` It stopped: ${status.reason ?? "stopped"}${status.detail ? `: ${status.detail}` : ""}.` : ""} Check, test and preview it, and fix anything that doesn't work.` : undefined;
    const ws = this.#c.workspaces.get(target.workspaceId);
    const w = this.#c.opened(this.#c.windows.open("magic", {}, ws ?? this.#c.workspaces.home()));
    this.#c.windows.update(w.id, { title: target.title, state: { prompt: entry.pkg.magic.request, phase: "empty", icon: entry.pkg.widgets[0]?.icon, history: [entry.pkg.magic.request], pkg: { name: ref.name, editing: windowId } } });
    const request = o.prompt?.trim() || fix;
    if (request) this.run(w.id, request);
    return this.#window(w.id) ?? w;
  }

  /** The package a window shows, when Magic made it: its folder, files and versions (the edit view, ⌘E). */
  info(windowId: WindowId): MagicPackageInfo | null {
    const e = this.#made(windowId);
    if (!e) return null;
    const revs = new PackageRevisions(this.#stateDir, e.name);
    const link = linkOf(e.dir);
    return {
      name: e.name,
      dir: e.dir,
      ...(link ? { link } : {}),
      files: listFiles(e.dir),
      revisions: revs.list(),
      edited: revs.differs(e.dir),
      building: this.#c.library.building.has(e.name),
    };
  }

  /**
   * Bring back version n of the package a window shows, as a new version: its files go back
   * into the package folder, and the package watcher reloads its windows. Refused while a build
   * writes it, and for a linked package, whose folder is the person's own.
   */
  restore(windowId: WindowId, n: number): void {
    const e = this.#made(windowId);
    if (!e) throw new Error("Only a widget made with Magic has versions.");
    if (this.#c.library.building.has(e.name)) throw new Error("Wait for the change being made to finish.");
    const link = linkOf(e.dir);
    if (link) throw new Error(`This widget is linked from ${link}, your own folder: cmd doesn't write versions into it.`);
    const revs = new PackageRevisions(this.#stateDir, e.name);
    const meta = revs.list().find((r) => r.n === n);
    if (!meta) throw new Error(`There's no version ${n}.`);
    // One reload, now: the saves below don't reload it again a moment later.
    const { reloader, host } = this.#c.library;
    reloader.paused.add(e.name);
    const mark = readMark(e.dir);
    revs.checkout(e.dir, n);
    const rev = revs.snapshot(e.dir, { prompt: `Back to version ${n}: ${meta.prompt}`.slice(0, 300), ok: meta.ok, ...(meta.problems ? { problems: meta.problems } : {}), ...(meta.model ? { model: meta.model } : {}), ...(meta.hand ? { hand: true } : {}) }, revs.shotOf(n));
    // cmd's mark as it is now (an older version may have none), counting this version.
    if (mark) writeMark(e.dir, { ...mark, revisions: rev.n });
    log.info(`package ${e.name} back to version ${n} (version ${rev.n})`);
    host.reload(e.name);
    setTimeout(() => this.#c.library.building.has(e.name) || reloader.paused.delete(e.name), RELOAD_DEBOUNCE_MS).unref();
    this.#c.library.changed();
  }

  /** The package entry of a window's widget, when Magic made it (not a built-in one). */
  #made(windowId: WindowId): { name: string; dir: string } | null {
    const w = this.#c.windows.others().find((x) => x.id === windowId);
    const ref = w && parsePackageKind(w.kind);
    const entry = ref && this.#c.library.packages.list().find((e) => e.ok && e.pkg.name === ref.name);
    return entry?.ok && entry.pkg.magic && !entry.builtin ? { name: entry.pkg.name, dir: entry.dir } : null;
  }
}
