// The widget packages this cmd has (docs/56, "Where packages live"): each folder (or link
// to one) in ~/.cmd/widgets, or $CMD_WIDGETS_HOME, read and validated (package.ts), each
// of its widgets a window type "pkg:<package>/<widget>" with role "widget". The folder is
// watched, through links to the real folders, so a package added, removed or changed by
// hand reaches the Widget Library within a second, once per burst. Reads only: nothing is
// ever written into the packages folder. A second root holds the built-in packages, those
// that ship with cmd (packages/widgets/<name> in the repo and the staged runtime).

import fs from "node:fs";
import path from "node:path";
import { logger } from "@cmd/protocol/node";
import { WatchService } from "../lib/watch.ts";
import type { WindowTypes } from "../windows/types.ts";
import type { Grants } from "./grants.ts";
import { readPackage, type ParseOptions, type WidgetPackage } from "./package.ts";

const log = logger("widgets");

/** One folder of the packages folder: its package, or why it isn't one. */
export type PackageEntry = { dir: string; folder: string; builtin?: true } & ({ ok: true; pkg: WidgetPackage } | { ok: false; errors: string[] });

// ── the built-in root ────────────────────────────────────
/** Packages that ship with cmd: packages/widgets beside the core, in a checkout as in the staged runtime. */
export const BUILTIN_WIDGETS = path.resolve(import.meta.dirname, "../../../widgets");
/** The built-in root: $CMD_BUILTIN_WIDGETS when set (tests; "" for none), else BUILTIN_WIDGETS. */
export const builtinWidgets = (): string | null => (process.env.CMD_BUILTIN_WIDGETS === undefined ? BUILTIN_WIDGETS : process.env.CMD_BUILTIN_WIDGETS || null);

export interface PackagesOptions {
  /** The packages folder; null: none (tests that don't ask for one). */
  home: string | null;
  /** The built-in packages' folder; a package of the same name in `home` wins. */
  builtin?: string | null;
  /** The registry (read when used: the service is made before it). */
  types: () => WindowTypes;
  /** The packages changed (added, removed, edited). */
  onChange: () => void;
  /** After a change, how long to wait for the rest of its burst (ms). */
  debounce?: number;
  parse?: ParseOptions;
}

export class WidgetPackages {
  readonly home: string | null;
  readonly builtin: string | null;
  #o: PackagesOptions;
  #entries = new Map<string, PackageEntry>();
  #kinds = new Set<string>();
  #watch = new WatchService();
  #watched = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #started = false;
  #closed = false;

  constructor(o: PackagesOptions) {
    this.#o = o;
    this.home = o.home;
    this.builtin = o.builtin ?? null;
    this.#watch.on("changed", () => this.#soon());
  }

  /** Every folder of the packages folder, packages and not, by name. */
  list(): PackageEntry[] {
    return [...this.#entries.values()].sort((a, b) => a.folder.localeCompare(b.folder));
  }

  /** The package a widget kind belongs to. */
  forKind(kind: string): WidgetPackage | null {
    for (const e of this.#entries.values()) if (e.ok && e.pkg.widgets.some((w) => w.kind === kind)) return e.pkg;
    return null;
  }

  /** A built-in package's grant: what it declares (it ships with cmd), never a grants file and never the sheet; null for any other. */
  builtinGrant(name: string): Grants | null {
    const e = [...this.#entries.values()].find((x) => x.ok && x.pkg.name === name);
    return e?.ok && e.pkg.builtin ? { version: e.pkg.version, permissions: e.pkg.permissions } : null;
  }

  /** Read the folder and keep watching it (a startup job). */
  start(): void {
    if (this.#started || (!this.home && !this.builtin)) return;
    this.#started = true;
    this.scan();
  }

  /** Read the packages folder again: register what's new or changed, unregister what's gone; true when anything changed. */
  scan(): boolean {
    const home = this.home;
    if ((!home && !this.builtin) || this.#closed) return false;
    const before = this.#signature();
    const next = new Map<string, PackageEntry>();
    const shadowed: string[] = [];
    for (const [root, builtin] of [[home, false], [this.builtin, true]] as const) {
      if (!root) continue;
      let names: string[] = [];
      try {
        names = fs.readdirSync(root).filter((n) => !n.startsWith("."));
      } catch {}
      for (const folder of names) {
        const dir = path.join(root, folder);
        try {
          if (!fs.statSync(dir).isDirectory()) continue; // follows links; a dangling one is skipped
        } catch {
          continue;
        }
        if (builtin && next.has(folder)) {
          shadowed.push(folder); // the person's package of that name wins
          continue;
        }
        if (builtin && !fs.existsSync(path.join(dir, "package.json"))) continue;
        const r = readPackage(dir, this.#o.parse);
        const entry: PackageEntry = r.ok && r.pkg.name !== folder ? { dir, folder, ok: false, errors: [`name: "${r.pkg.name}" should be the folder's name, "${folder}"`] } : { dir, folder, ...r };
        if (builtin) {
          entry.builtin = true;
          if (entry.ok) entry.pkg.builtin = true;
        }
        next.set(folder, entry);
      }
    }
    this.#entries = next;
    this.#register();
    this.#rewatch(home);
    const changed = this.#signature() !== before;
    if (changed) {
      for (const e of next.values()) if (!e.ok) log.info(`widget package ${e.folder} can't be used: ${e.errors.join("; ")}`);
      for (const f of shadowed) log.info(`widget package ${f}: yours in ${home} is used instead of the built-in one`);
      this.#o.onChange();
    }
    return changed;
  }

  dispose(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#watch.close();
    for (const k of this.#kinds) this.#o.types().unregister(k);
    this.#kinds.clear();
  }

  #soon(): void {
    if (this.#timer || this.#closed) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      try {
        this.scan();
      } catch (e) {
        log.error("reading the widget packages failed", e);
      }
    }, this.#o.debounce ?? 100);
    this.#timer.unref();
  }

  /** Window types for every widget of every package; a changed package's again (its title, icon). */
  #register(): void {
    const types = this.#o.types();
    for (const k of this.#kinds) types.unregister(k);
    this.#kinds.clear();
    for (const e of this.#entries.values()) {
      if (!e.ok) continue;
      const pkg = e.pkg;
      for (const w of pkg.widgets) {
        if (types.get(w.kind)) continue;
        // The process and the view are phase 1's other items (docs/56); the window holds which widget it shows.
        types.register({
          kind: w.kind,
          title: w.title,
          icon: w.icon,
          role: "widget",
          ...(w.description || pkg.description ? { description: w.description ?? pkg.description } : {}),
          create: () => ({ state: { package: pkg.name, widget: w.id }, title: w.title }),
          remoteState: (s) => ({ package: s.package, widget: s.widget }),
        });
        this.#kinds.add(w.kind);
      }
    }
  }

  /**
   * Watch the packages folder (or, until it exists, the nearest folder above it) and each
   * package's folder at its real path, so a linked package's edits count too.
   */
  #rewatch(home: string | null): void {
    const want = new Set<string>();
    if (home) {
      let top = home;
      while (!fs.existsSync(top) && path.dirname(top) !== top) top = path.dirname(top);
      want.add(top);
    }
    for (const e of this.#entries.values()) {
      try {
        want.add(fs.realpathSync(e.dir));
      } catch {}
    }
    for (const p of this.#watched) if (!want.has(p)) this.#watch.unwatch(p);
    for (const p of want) if (!this.#watched.has(p) && !this.#watch.watch(p)) want.delete(p);
    this.#watched = want;
  }

  /** What the Library shows of the packages, to tell a change from a rescan that found the same. */
  #signature(): string {
    return JSON.stringify(this.list().map((e) => (e.ok ? [e.folder, e.pkg] : [e.folder, e.errors, !!e.builtin])));
  }
}
