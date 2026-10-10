// File watching for windows (text editors, file trees). Watches the parent
// folder and filters by name: editors often save by writing a new file and
// renaming it over the old one, which a watch on the file itself would miss.
// Reference-counted per path; bursts are debounced into one "changed".
//
// A new watch isn't live at once: on macOS fs.watch starts its FSEvents stream
// on another thread, and a change made before the stream is live is never
// reported (nearly always for a write right after the watch). So a new folder
// watch looks again a little later (`settle`): a watched path the watch hasn't
// reported yet whose timestamps say it changed since it was watched (or since
// the caller read it, `since`) is reported then. Timestamps, not a second
// listing to compare: one async stat pass, nothing kept, nothing reported when
// nothing changed.

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { logger } from "@cmd/protocol/node";

const log = logger("watch");

/** When a new watch looks for changes it may have missed, in ms after it began: before it's surely live and once it is. */
const SETTLE = [150, 1000];
/** A folder with more entries than this is checked by its own timestamps only (entries added, removed, renamed), not each entry's. */
const MAX_ENTRIES = 1000;

interface Name {
  refs: number;
  /** Changes from this time on (epoch ms) are this watch's to report. */
  since: number;
  /** The watch reported it already: what it would have missed is covered. */
  seen: boolean;
}

interface DirWatch {
  watcher: fs.FSWatcher;
  /** Watched paths in this folder (files, or "." for the folder itself). */
  names: Map<string, Name>;
  /** Pending looks for changes made before the watch was live; empty once done. */
  settle: NodeJS.Timeout[];
}

export interface WatchOptions {
  /** Override SETTLE (tests). */
  settle?: number[];
}

export class WatchService extends EventEmitter<{ changed: [path: string] }> {
  #dirs = new Map<string, DirWatch>();
  #timers = new Map<string, NodeJS.Timeout>();
  #settle: number[];

  constructor(o: WatchOptions = {}) {
    super();
    this.#settle = o.settle ?? SETTLE;
  }

  /**
   * Watch a file or folder. Returns false if it can't be watched. `since` is when
   * the caller read it (epoch ms; default now): a change after that is reported
   * even if it came before the watch was live.
   */
  watch(p: string, since = Date.now()): boolean {
    const abs = path.resolve(p);
    let isDir = false;
    try {
      isDir = fs.statSync(abs).isDirectory();
    } catch {
      return false;
    }
    // Folders are watched directly (their entries changing); files via their parent.
    const dir = isDir ? abs : path.dirname(abs);
    const name = isDir ? "." : path.basename(abs);
    let d = this.#dirs.get(dir);
    if (!d) {
      try {
        const watcher = fs.watch(dir, (_event, changed) => this.#onEvent(dir, changed?.toString() ?? null));
        watcher.unref();
        watcher.on("error", () => this.#drop(dir));
        d = { watcher, names: new Map(), settle: [] };
        this.#dirs.set(dir, d);
        const dw = d;
        for (const ms of this.#settle) {
          const t = setTimeout(() => {
            dw.settle = dw.settle.filter((x) => x !== t);
            void this.#check(dir, dw);
          }, ms);
          t.unref();
          d.settle.push(t);
        }
      } catch {
        return false;
      }
    }
    const n = d.names.get(name);
    if (n) {
      n.refs++;
      n.since = Math.min(n.since, since);
    } else {
      // Added to a watch that is live already: nothing to look for.
      d.names.set(name, { refs: 1, since, seen: d.settle.length === 0 });
    }
    return true;
  }

  unwatch(p: string): void {
    const abs = path.resolve(p);
    for (const [dir, d] of this.#dirs) {
      const name = abs === dir ? "." : path.dirname(abs) === dir ? path.basename(abs) : null;
      const n = name ? d.names.get(name) : undefined;
      if (!name || !n) continue;
      if (--n.refs <= 0) d.names.delete(name);
      if (d.names.size === 0) this.#drop(dir);
      return;
    }
  }

  close(): void {
    for (const dir of [...this.#dirs.keys()]) this.#drop(dir);
    for (const t of this.#timers.values()) clearTimeout(t);
  }

  #onEvent(dir: string, changed: string | null): void {
    const d = this.#dirs.get(dir);
    if (!d) return;
    // The folder's listing changed (anything in it) and/or a watched file.
    const dot = d.names.get(".");
    if (dot) this.#report(dir, dot, ".");
    const n = changed ? d.names.get(changed) : undefined;
    if (changed && n) this.#report(dir, n, changed);
    if (!changed) for (const [k, v] of d.names) if (k !== ".") this.#report(dir, v, k);
  }

  #report(dir: string, n: Name, name: string): void {
    n.seen = true;
    this.#emitSoon(name === "." ? dir : path.join(dir, name));
  }

  /** Report what changed since it was watched but the watch hasn't reported (it wasn't live yet). Async: stats only. */
  async #check(dir: string, d: DirWatch): Promise<void> {
    for (const [name, n] of d.names) {
      if (n.seen) continue;
      let changed = false;
      try {
        changed = name === "." ? await changedIn(dir, n.since) : await changedAt(path.join(dir, name), n.since);
      } catch (e) {
        log.debug(`checking ${dir}: ${(e as Error).message}`);
      }
      // Unwatched, dropped, or reported meanwhile.
      if (changed && this.#dirs.get(dir) === d && d.names.get(name) === n && !n.seen) this.#report(dir, n, name);
    }
  }

  #emitSoon(p: string): void {
    clearTimeout(this.#timers.get(p));
    this.#timers.set(
      p,
      setTimeout(() => {
        this.#timers.delete(p);
        this.emit("changed", p);
      }, 80),
    );
  }

  #drop(dir: string): void {
    const d = this.#dirs.get(dir);
    if (!d) return;
    d.watcher.close();
    for (const t of d.settle) clearTimeout(t);
    this.#dirs.delete(dir);
  }
}

const after = (s: fs.Stats, since: number) => s.mtimeMs >= since || s.ctimeMs >= since;

/** A file changed, was replaced (an atomic save), or is gone. */
async function changedAt(file: string, since: number): Promise<boolean> {
  try {
    return after(await fs.promises.lstat(file), since);
  } catch {
    return true;
  }
}

/** A folder gained, lost or renamed an entry (its own mtime), or one of its entries changed. */
async function changedIn(dir: string, since: number): Promise<boolean> {
  if (after(await fs.promises.stat(dir), since)) return true;
  const names = await fs.promises.readdir(dir);
  if (names.length > MAX_ENTRIES) return false;
  for (let i = 0; i < names.length; i += 32) {
    const batch = await Promise.all(names.slice(i, i + 32).map((x) => fs.promises.lstat(path.join(dir, x)).then((s) => after(s, since), () => false)));
    if (batch.includes(true)) return true;
  }
  return false;
}
