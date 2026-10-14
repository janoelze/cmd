// The Widget Library (docs/16-widgets.md): built-in widget types, then packages' widgets
// (docs/56), then the widgets made with Magic by last use; clients get it again when it
// changes, once per burst.

import fs from "node:fs";
import { parsePackageKind, type WidgetEntry } from "@cmd/protocol";
import { configFields } from "./config.ts";
import { DEFAULT_ICON } from "./package.ts";
import { createPackages } from "./feature.ts";
import type { WidgetPackages } from "./packages.ts";
import type { CoreContext } from "../kernel/context.ts";
import { createWidgetHost } from "./host/feature.ts";
import type { WidgetHost } from "./host/host.ts";
import { PackageReloader } from "./reload.ts";

/** A Widget Library ref: "magic:<widget id>" (made with Magic), "type:<kind>" (a built-in widget) or "pkg:<package>/<widget>" (a package's). */
export function widgetRef(ref: string): { kind: string; widgetId?: string } {
  if (parsePackageKind(ref)) return { kind: ref };
  const m = /^(magic|type):([\w-]+)$/.exec(ref);
  if (!m) throw new Error(`not a widget: ${ref}`);
  return m[1] === "magic" ? { kind: "magic", widgetId: m[2] } : { kind: m[2]! };
}

/** The widget id of a Magic widget's ref; built-in widgets aren't the library's to change. */
export function magicRef(ref: string): string {
  const r = widgetRef(ref);
  if (!r.widgetId) throw new Error(`built-in widgets can't be renamed, duplicated or deleted: ${ref}`);
  return r.widgetId;
}

/** Where package widgets' processes find the instance's grants and the widgets socket. */
export interface LibraryOptions {
  stateDir?: string | null;
  socket?: string | null;
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
  /** Packages a Magic build is writing (magic/package/service.ts): not listed until they are valid. */
  readonly building = new Set<string>();
  /** A Magic package's last screenshot, by name (magic/package/service.ts sets it). */
  shotOf: (name: string) => string | undefined = () => undefined;

  constructor(core: CoreContext, o: LibraryOptions = {}) {
    this.#core = core;
    this.packages = createPackages(core, () => {
      this.changed();
      this.reloader?.sync(this.packages.list());
      this.host?.packagesChanged();
    });
    this.host = createWidgetHost(core, this.packages, { stateDir: o.stateDir ?? null, socket: o.socket ?? null, onAsk: () => this.changed() });
    this.reloader = new PackageReloader({ onReload: (name) => this.host.reload(name) });
    // Developer widgets come and go from the library with their setting.
    core.settings.bind(["widgets.developer"], () => this.changed());
  }

  entries(): WidgetEntry[] {
    const { windows, windowTypes, magic, settings } = this.#core;
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
            return { ref: w.kind, source: "package", kind: w.kind, title: w.title, description: w.description ?? e.pkg.description, icon: w.icon, name: e.pkg.name, version: e.pkg.version, api: e.pkg.api, dir: e.dir, ...(link ? { link } : {}), permissions: e.pkg.permissions, ...(ask ? { ask } : {}), ...(e.builtin ? { builtin: true } : {}), ...config, ...magic, windows: others.filter((x) => x.kind === w.kind).map((x) => x.id) };
          })
        : this.building.has(e.folder)
          ? []
          : [{ ref: `pkg:${e.folder}`, source: "package", kind: `pkg:${e.folder}`, title: e.folder, icon: DEFAULT_ICON, name: e.folder, problem: e.errors.join("; "), dir: e.dir, windows: [] }],
    );
    const type = windowTypes.get("magic")!;
    const yours = magic.library().map((e): WidgetEntry => ({
      ref: `magic:${e.id}`,
      source: "yours",
      kind: "magic",
      title: e.title,
      description: e.description,
      icon: type.icon,
      request: e.history[0],
      shot: e.shot,
      dir: magic.store.dir(e.id),
      createdAt: e.createdAt,
      usedAt: e.usedAt,
      windows: e.windows,
    }));
    return [...builtin, ...pkgs, ...yours];
  }

  /** Tell clients the library changed; changes in a burst (a build, closing a workspace) go out once. */
  changed(): void {
    if (this.#timer || !this.#core.watched()) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#core.broadcast({ type: "widget.library", entries: this.entries() });
    }, 50);
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.reloader.close();
  }
}

/** The folder a linked package is (its link resolved), or null for a folder of its own. */
function linkOf(dir: string): string | null {
  try {
    return fs.lstatSync(dir).isSymbolicLink() ? fs.realpathSync(dir) : null;
  } catch {
    return null;
  }
}
