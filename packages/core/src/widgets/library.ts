// The Widget Library (docs/16-widgets.md): built-in widget types, then packages' widgets
// (docs/56), those made with Magic among them; clients get it again when it changes, once per
// burst. It owns what runs them: the packages (packages.ts), their processes (host/), hot reload
// (reload.ts, which also keeps a hand edit of a package Magic made as a version: revisions.ts),
// and Deno (deno.ts).

import fs from "node:fs";
import path from "node:path";
import { parsePackageKind, type WidgetEntry } from "@cmd/protocol";
import { logger, widgetPackageData, widgetsHome } from "@cmd/protocol/node";
import { configFields } from "./config.ts";
import { DenoSetup, findDeno } from "./deno.ts";
import { DEFAULT_ICON } from "./package.ts";
import { WidgetPackages, builtinWidgets } from "./packages.ts";
import type { CoreContext } from "../kernel/context.ts";
import { WidgetHost } from "./host/host.ts";
import { DenoRuntime } from "./host/runtime.ts";
import { sandboxMode } from "../lib/sandbox.ts";
import { toolsOf } from "../tools/feature.ts";
import { PackageReloader } from "./reload.ts";
import { LIBRARY_DEBOUNCE_MS } from "./limits.ts";
import { linkOf, recordHandEdit } from "./revisions.ts";

const log = logger("widgets");

/** A Widget Library ref: "type:<kind>" (a built-in widget) or "pkg:<package>/<widget>" (a package's). */
export function widgetRef(ref: string): { kind: string } {
  if (parsePackageKind(ref)) return { kind: ref };
  const m = /^type:([\w-]+)$/.exec(ref);
  if (!m) throw new Error(`not a widget: ${ref}`);
  return { kind: m[1]! };
}

/** Where package widgets' processes find the instance's grants and the widgets socket, and Deno. */
export interface LibraryOptions {
  stateDir?: string | null;
  socket?: string | null;
  /** Tests: the Deno to use (null: none); default findDeno. */
  deno?: string | null;
  /** Tests: what downloads Deno (default installDeno, unless `deno` is given). */
  installDeno?: (stateDir: string) => Promise<string>;
}

export class WidgetLibrary {
  #core: CoreContext;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Widget packages (docs/56): read and watched from their startup job (widgets/feature.ts). */
  readonly packages: WidgetPackages;
  /** Their widgets' processes (docs/56, "The runtime"; widgets/host/). */
  readonly host: WidgetHost;
  /** Saves in a package's sources restart its windows (hot reload, widgets/reload.ts). */
  readonly reloader: PackageReloader;
  /**
   * Packages Magic is writing (a build, a Restore; magic/package/service.ts): not listed until
   * they are valid, their saves don't reload them (it reloads once at its end), and their changes
   * aren't kept as hand edits.
   */
  readonly writing = new Set<string>();
  /** A Magic package's last screenshot, by name (magic/package/service.ts sets it). */
  shotOf: (name: string) => string | undefined = () => undefined;
  /** The instance's state folder ($CMD_HOME); null in tests without one. */
  readonly stateDir: string | null;
  /** Deno: found, or downloaded when the person says so (magic.installRuntime). */
  readonly deno: DenoSetup;

  constructor(core: CoreContext, o: LibraryOptions = {}) {
    this.#core = core;
    this.stateDir = o.stateDir ?? null;
    const stateDir = this.stateDir;
    this.deno = new DenoSetup({
      stateDir,
      find: () => (o.deno !== undefined ? o.deno : findDeno({ setting: core.settings.settings["magic.deno"], stateDir: stateDir ?? undefined })),
      install: o.installDeno ?? (o.deno === undefined ? undefined : null),
    });
    this.deno.onInstalled = () => this.host.packagesChanged();
    // $CMD_WIDGETS_HOME or ~/.cmd/widgets, and the built-in packages; read from the widgets' startup job (widgets/feature.ts) on.
    this.packages = new WidgetPackages({
      home: widgetsHome(),
      builtin: builtinWidgets(),
      types: () => core.windowTypes,
      quiet: this.writing,
      onChange: () => {
        this.changed();
        this.reloader?.sync(this.packages.list());
        for (const e of this.packages.list()) this.#handEdit(e.folder);
        this.host?.packagesChanged();
      },
    });
    // Deno runs the processes when there is a state dir (else a test sets a runtime); acts ask through
    // the tools' approvals and show on the board as their calls do (made on first use).
    const runtime = stateDir ? new DenoRuntime({ deno: () => this.deno.find(), denoDir: path.join(stateDir, "runtime", "deno-cache"), sandbox: sandboxMode }) : null;
    this.host = new WidgetHost(core, { stateDir, socket: o.socket ?? null, packages: this.packages, runtime, onAsk: () => this.changed(), acts: () => toolsOf(core) });
    this.reloader = new PackageReloader({
      paused: this.writing,
      onReload: (name) => {
        this.#handEdit(name);
        this.host.reload(name);
      },
    });
    // Developer widgets come and go from the library with their setting.
    core.settings.bind(["widgets.developer"], () => this.changed());
  }

  entries(): WidgetEntry[] {
    const { windows, windowTypes, settings } = this.#core;
    const packages = this.packages;
    const others = windows.others();
    const builtin = windowTypes
      .all()
      .filter((t) => t.role === "widget" && t.kind !== "magic" && !parsePackageKind(t.kind) && (!t.tags?.includes("developer") || settings.settings["widgets.developer"]))
      .map((t): WidgetEntry => ({ ref: `type:${t.kind}`, source: "builtin", kind: t.kind, title: t.title, description: t.description, icon: t.icon, ...(t.tags?.length ? { tags: t.tags } : {}), windows: others.filter((w) => w.kind === t.kind).map((w) => w.id) }));
    const pkgs = packages.list().flatMap((e): WidgetEntry[] =>
      e.ok
        ? e.pkg.widgets.map((w) => {
            const ask = this.host.asking(e.pkg.name);
            const link = linkOf(e.dir);
            const config = w.config.length ? { config: configFields(w), secrets: w.config.some((f) => f.secret) ? this.host.config.secretsSet(e.pkg.name, w.id) : [] } : {};
            const magic = e.pkg.magic ? { magic: e.pkg.magic, request: e.pkg.magic.request, createdAt: Date.parse(e.pkg.magic.madeAt) || undefined, shot: this.shotOf(e.pkg.name) } : {};
            return { ref: w.kind, source: "package", kind: w.kind, title: w.title, description: w.description ?? e.pkg.description, icon: w.icon, name: e.pkg.name, version: e.pkg.version, api: e.pkg.api, dir: e.dir, ...(link ? { link } : {}), permissions: e.pkg.permissions, ...(ask ? { ask } : {}), ...(e.builtin ? { builtin: true } : {}), ...config, ...magic, ...(w.surface === "frame" ? { surface: "frame" as const } : {}), windows: others.filter((x) => x.kind === w.kind).map((x) => x.id) };
          })
        : this.writing.has(e.folder)
          ? []
          : [{ ref: `pkg:${e.folder}`, source: "package", kind: `pkg:${e.folder}`, title: e.folder, icon: DEFAULT_ICON, name: e.folder, problem: e.errors.join("; "), dir: e.dir, windows: [] }],
    );
    return [...builtin, ...pkgs];
  }

  /** Tell clients the library changed; changes in a burst (a build, closing a workspace) go out once. */
  changed(): void {
    if (this.#timer || !this.#core.watched()) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#core.broadcast({ type: "widget.library", entries: this.entries() });
    }, LIBRARY_DEBOUNCE_MS);
  }

  /** A package Magic made, changed outside a build: its files become a version ("Edited by hand"). */
  #handEdit(name: string): void {
    const entry = this.packages.list().find((e) => e.folder === name || (e.ok && e.pkg.name === name));
    if (!this.stateDir || !entry?.ok || !entry.pkg.magic) return;
    try {
      if (recordHandEdit(this.stateDir, entry, this.writing)) this.changed();
    } catch (e) {
      log.warn(`keeping a hand edit of ${name} as a version failed: ${(e as Error).message}`);
    }
  }

  /** Delete a package made with Magic from the Library: its windows, its folder, its versions and the instance's data about it. */
  remove(name: string): void {
    const entry = this.packages.list().find((e) => e.folder === name);
    if (!entry || !entry.ok || !entry.pkg.magic || entry.builtin || linkOf(entry.dir) || !this.packages.home || entry.dir !== path.join(this.packages.home, name)) throw new Error(`${name} isn't a widget made with Magic`);
    for (const w of this.#core.windows.others()) if (parsePackageKind(w.kind)?.name === name) this.#core.windows.close(w.id);
    fs.rmSync(entry.dir, { recursive: true, force: true });
    if (this.stateDir) fs.rmSync(widgetPackageData(this.stateDir, name), { recursive: true, force: true });
    this.packages.scan();
    this.changed();
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.reloader.close();
  }
}
