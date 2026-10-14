// Magic making widget packages in the app (docs/56, "Magic on V3"): a request in a Magic window
// is built into a package in the packages folder (widgetsHome(), named from the request), the
// agent's steps streamed to the window as MagicService streams them. When the package asks for
// permissions, the build pauses on a step and the grants sheet asks (widget.ask; one sheet,
// shown for the Library's entry), and the build goes on with the answer. A finished package is
// marked as made with Magic (package.json's cmd.magic), kept as a revision in the instance's
// widget-packages/<name>/revisions, and the window becomes the package's widget in place
// ("pkg:<name>/<id>", drawn by the kit). Edit with Magic and Fix open a Magic window beside a
// package window and build the change into the same package; its windows reload once at the end.
// Requests that aren't packages stay MagicService's: the fast paths (pasted JSON, a command)
// and changes to widgets made before packages.

import fs from "node:fs";
import path from "node:path";
import { parsePackageKind, type AppWindow, type CoreEvent, type MagicPackageBuild, type MagicState, type MagicStep, type WidgetPermissions, type WindowId } from "@cmd/protocol";
import { logger, widgetPackageData, widgetsHome } from "@cmd/protocol/node";
import type { Backend } from "../../ai/backends.ts";
import type { CoreContext } from "../../kernel/context.ts";
import { magicDenyPaths } from "../../lib/paths-deny.ts";
import { cmdVersion, type WidgetPackage } from "../../widgets/package.ts";
import { fastRoute, type BuildEvent } from "../build.ts";
import { sandboxAvailable, type SandboxMode } from "../sandbox.ts";
import { buildPackage, type PackageBuildResult } from "./build.ts";
import { readMark, writeMark } from "./files.ts";
import { PackageRevisions } from "./revisions.ts";
import { scriptFromEnv, scriptedBackend } from "./scripted.ts";
import { checkoutToolchain, type Toolchain } from "./toolchain.ts";
import { permissionLines } from "./words.ts";

const log = logger("magic");

type Ctx = Pick<CoreContext, "windows" | "windowTypes" | "workspaces" | "settings" | "ai" | "broadcast" | "library" | "previews" | "magic" | "opened" | "place">;

export interface MagicPackagesOptions {
  /** The instance's state folder (revisions; grants are the host's). null: a temporary one (tests). */
  stateDir: string | null;
  /** Tests: the model (default: MagicService's, else the AI service's smart tier). */
  backend?: () => Backend;
  /** Tests: the toolchain (default: the checkout's). */
  toolchain?: Toolchain | null;
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

function detailOf(tool: string, input: Record<string, unknown>): string {
  const v = input.command ?? input.path ?? input.url ?? "";
  return String(v).replace(/\s+/g, " ").slice(0, 160) || tool;
}

/** Cores whose new requests build widgets of the format before packages, as MagicService did: the tests of that path, until phase 2b removes it. */
const cmd2 = new WeakSet<object>();
export const buildCmd2Widgets = (magic: object): void => void cmd2.add(magic);

export class MagicPackages {
  #c: Ctx;
  #o: MagicPackagesOptions;
  #runs = new Map<WindowId, AbortController>();
  #stateDir: string;

  constructor(c: Ctx, o: MagicPackagesOptions) {
    this.#c = c;
    this.#o = o;
    this.#stateDir = o.stateDir ?? fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "cmd-magic-pkg-state-"));
    c.library.shotOf = (name) => new PackageRevisions(this.#stateDir, name).latest()?.shot;
  }

  /** The packages folder the core reads (widgetsHome() when it was made). */
  #home(): string {
    return this.#o.home?.() ?? this.#c.library.packages.home ?? widgetsHome();
  }

  #window(id: WindowId): AppWindow | null {
    return this.#c.windows.others().find((w) => w.id === id) ?? null;
  }

  /** Whether a Magic window's request is a package build: not a fast path, not a change to a widget made before packages. */
  takes(id: WindowId, prompt: string): boolean {
    const w = this.#window(id);
    // A core without a state folder (tests) has nowhere to keep a package's grant and versions: it writes no package.
    if (cmd2.has(this.#c.magic) || !this.#c.magic.made().stateDir || !w || w.kind !== "magic") return false;
    const s = stateOf(w);
    if (s.pkg) return true;
    const changing = !!s.prompt && (s.phase === "ready" || s.phase === "error") && !!(s.widgetId || s.html || s.command);
    return !changing && !fastRoute(prompt);
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
    return this.#o.backend?.() ?? this.#c.magic.made().backend?.(this.#c.settings.settings) ?? this.#c.ai.backend({ tier: "smart", purpose: "magic" });
  }

  #sandbox(): SandboxMode {
    return this.#c.magic.made().sandbox ?? (process.env.CMD_MAGIC_UNSANDBOXED === "1" && !sandboxAvailable() ? "off" : "required");
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
    const ac = new AbortController();
    this.#runs.set(id, ac);
    fs.mkdirSync(dir, { recursive: true });
    const { library } = this.#c;
    library.building.add(name);
    library.reloader.paused.add(name);
    const pkg: MagicPackageBuild = { name, ...(editing ? { editing } : {}) };
    this.#c.windows.update(id, { title: fresh ? "Magic Widget" : w.title, state: { prompt: original, phase: "working", error: undefined, steps: [], history, pkg } });

    const steps: MagicStep[] = [];
    const send = (progress: Extract<CoreEvent, { type: "magic.stream" }>["progress"]) => this.#c.broadcast({ type: "magic.stream", id, progress });
    const stepEvent = (step: MagicStep) => send({ type: "step", step: { ...step } });
    const onEvent = (e: BuildEvent) => {
      if (e.type === "step-start") {
        const step: MagicStep = { id: e.id, tool: e.tool, why: e.why, detail: detailOf(e.tool, e.input) };
        steps.push(step);
        stepEvent(step);
      } else if (e.type === "step-end") {
        const step = steps.find((s) => s.id === e.id);
        if (!step) return;
        Object.assign(step, { ms: e.ms, isError: e.isError, output: e.output.slice(0, 4000) });
        stepEvent(step);
      } else if (e.type === "title") {
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
        steps.push(step);
        stepEvent(step);
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
    buildPackage({
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
      noFast: true,
      toolchain: this.#o.toolchain === undefined ? checkoutToolchain() : this.#o.toolchain,
      previewer: () => this.#c.previews.previewer(),
      ask,
      granted: () => library.host.granted(name)?.permissions ?? null,
      cmdVersion: cmdVersion(),
      signal: ac.signal,
      onEvent,
    }).then(
      (r) => this.#finish(id, name, ac, r, { fresh, text, original, history, steps, editing }),
      (e: Error) => this.#end(id, name, ac, { error: ac.signal.aborted ? "Stopped." : e.message, fresh }),
    );
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
    const why = r.stopped ?? (r.ending?.kind === "needs-program" ? `${r.ending.reason} (It would need to run ${r.ending.programs.join(", ")}, which widgets can't do yet.)` : !v.usable ? (v.problems[0]?.split("\n")[0] ?? "The widget couldn't be built.") : null);
    if (why || !v.pkg) return this.#end(id, name, ac, { error: why ?? "The widget couldn't be built.", fresh: o.fresh });

    const revs = new PackageRevisions(this.#stateDir, name);
    const rev = revs.snapshot(dir, { prompt: o.text, ok: v.ok, ...(v.ok ? {} : { problems: v.problems.slice(0, 10) }), model: r.model }, v.shot ? Buffer.from(v.shot, "base64") : undefined);
    writeMark(dir, { request: o.original, madeAt: readMark(dir)?.madeAt ?? new Date().toISOString(), revisions: rev.n });
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

  /** A package made with Magic deleted from the Library: its folder, revisions and the instance's data about it. */
  remove(name: string): void {
    const entry = this.#c.library.packages.list().find((e) => e.folder === name);
    if (!entry || !entry.ok || !entry.pkg.magic || entry.builtin || entry.dir !== path.join(this.#home(), name)) throw new Error(`${name} isn't a widget made with Magic`);
    for (const w of this.#c.windows.others()) if (parsePackageKind(w.kind)?.name === name) this.#c.windows.close(w.id);
    fs.rmSync(entry.dir, { recursive: true, force: true });
    fs.rmSync(widgetPackageData(this.#stateDir, name), { recursive: true, force: true });
    this.#c.library.packages.scan();
    this.#c.library.changed();
  }
}

// ── one per core ─────────────────────────────────────────

const instances = new WeakMap<object, MagicPackages>();

/** The core's MagicPackages (made on first use, with MagicService's state dir and backend). */
export function magicPackages(core: Ctx): MagicPackages {
  let m = instances.get(core.magic);
  if (!m) {
    m = new MagicPackages(core, { stateDir: core.magic.made().stateDir ?? null });
    instances.set(core.magic, m);
  }
  return m;
}
