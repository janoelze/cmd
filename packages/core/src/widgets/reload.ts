// Hot reload of widget packages (docs/56, "Hot reload, from anywhere"): each package's sources,
// at their real path (a linked package's folder), watched wherever the save comes from (cmd's
// editor, an agent in a terminal, a build tool writing dist/). Watched: `src/` and `dist/` with
// their subfolders (one recursive FSEvents stream each), and `view.html` at the top;
// `package.json` is the packages folder's own watch (packages.ts). Never node_modules, .git,
// fixtures or tests, nor stories and tests beside the code (the Workbench and `cmd widget test`
// have their own). A burst of saves is one reload, 250 ms after its last change.

import fs from "node:fs";
import path from "node:path";
import { logger } from "@cmd/protocol/node";
import type { PackageEntry } from "./packages.ts";

const log = logger("widgets");

/** After a save, how long to wait for the rest of its burst (ms). */
export const RELOAD_DEBOUNCE_MS = 250;
/** The folders whose files are the widget's code. */
const SOURCES = ["src", "dist"];
/** Files at the package's top that are code too. */
const TOP = new Set(["view.html"]);
/** Folders never looked into, wherever they are. */
const SKIP_DIRS = new Set(["node_modules", ".git", "fixtures", "test", "tests"]);

/** Whether a change at `rel` (relative to a sources folder) is the widget's code. */
export function isSource(rel: string): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const file = parts.at(-1);
  if (!file || parts.some((p) => SKIP_DIRS.has(p) || p.startsWith("."))) return false;
  return !/\.(test|spec)\.[^.]+$/.test(file) && !/\.stor(y|ies)\.[^.]+$/.test(file);
}

interface Watched {
  root: string;
  watchers: fs.FSWatcher[];
  /** The sources folders that existed when it was watched. */
  sources: Set<string>;
}

export interface ReloaderOptions {
  /** A package's code changed: once per burst. */
  onReload: (name: string) => void;
  debounce?: number;
}

export class PackageReloader {
  #o: ReloaderOptions;
  #pkgs = new Map<string, Watched>();
  #timers = new Map<string, NodeJS.Timeout>();
  #closed = false;

  constructor(o: ReloaderOptions) {
    this.#o = o;
  }

  /** Watch the packages there are now (each at its real path), and no others. */
  sync(entries: PackageEntry[]): void {
    if (this.#closed) return;
    const want = new Map<string, string>();
    for (const e of entries) {
      if (!e.ok) continue;
      try {
        want.set(e.pkg.name, fs.realpathSync(e.dir));
      } catch {}
    }
    for (const [name, w] of this.#pkgs) if (want.get(name) !== w.root) this.#unwatch(name);
    for (const [name, root] of want) if (!this.#pkgs.has(name)) this.#watch(name, root);
  }

  /** How many fs watches are open (tests, diagnostics). */
  watchers(): number {
    let n = 0;
    for (const w of this.#pkgs.values()) n += w.watchers.length;
    return n;
  }

  /** Whether a reload is waiting for its burst to end (tests). */
  pending(): boolean {
    return this.#timers.size > 0;
  }

  close(): void {
    this.#closed = true;
    for (const name of [...this.#pkgs.keys()]) this.#unwatch(name);
  }

  #watch(name: string, root: string): void {
    const w: Watched = { root, watchers: [], sources: new Set(SOURCES.filter((x) => fs.existsSync(path.join(root, x)))) };
    this.#pkgs.set(name, w);
    const add = (dir: string, recursive: boolean, take: (rel: string) => boolean) => {
      try {
        const watcher = fs.watch(dir, { recursive }, (_event, file) => {
          const rel = file?.toString() ?? "";
          if (take(rel)) this.#soon(name);
        });
        watcher.unref();
        watcher.on("error", () => watcher.close());
        w.watchers.push(watcher);
      } catch (e) {
        log.debug(`can't watch ${dir}: ${(e as Error).message}`);
      }
    };
    // The top: view.html, and a sources folder coming or going (watched again then).
    add(root, false, (rel) => {
      if (SOURCES.includes(rel) && fs.existsSync(path.join(root, rel)) !== w.sources.has(rel)) {
        this.#unwatch(name);
        this.#watch(name, root);
        return true;
      }
      return TOP.has(rel);
    });
    for (const s of w.sources) add(path.join(root, s), true, isSource);
  }

  #unwatch(name: string): void {
    const w = this.#pkgs.get(name);
    if (!w) return;
    for (const x of w.watchers) x.close();
    this.#pkgs.delete(name);
    clearTimeout(this.#timers.get(name));
    this.#timers.delete(name);
  }

  #soon(name: string): void {
    if (this.#closed) return;
    clearTimeout(this.#timers.get(name));
    const t = setTimeout(() => {
      this.#timers.delete(name);
      try {
        this.#o.onReload(name);
      } catch (e) {
        log.error(`reloading widget package ${name} failed`, e);
      }
    }, this.#o.debounce ?? RELOAD_DEBOUNCE_MS);
    t.unref();
    this.#timers.set(name, t);
  }
}
