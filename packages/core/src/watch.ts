// File watching for windows (text editors, file trees). Watches the parent
// folder and filters by name: editors often save by writing a new file and
// renaming it over the old one, which a watch on the file itself would miss.
// Reference-counted per path; bursts are debounced into one "changed".

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

interface DirWatch {
  watcher: fs.FSWatcher;
  /** Watched paths in this folder (files, or "." for the folder itself) → refcount. */
  names: Map<string, number>;
}

export class WatchService extends EventEmitter<{ changed: [path: string] }> {
  #dirs = new Map<string, DirWatch>();
  #timers = new Map<string, NodeJS.Timeout>();

  /** Watch a file or folder. Returns false if it can't be watched. */
  watch(p: string): boolean {
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
        d = { watcher, names: new Map() };
        this.#dirs.set(dir, d);
      } catch {
        return false;
      }
    }
    d.names.set(name, (d.names.get(name) ?? 0) + 1);
    return true;
  }

  unwatch(p: string): void {
    const abs = path.resolve(p);
    for (const [dir, d] of this.#dirs) {
      const name = abs === dir ? "." : path.dirname(abs) === dir ? path.basename(abs) : null;
      if (!name || !d.names.has(name)) continue;
      const n = d.names.get(name)! - 1;
      if (n > 0) d.names.set(name, n);
      else d.names.delete(name);
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
    if (d.names.has(".")) this.#emitSoon(dir);
    if (changed && d.names.has(changed)) this.#emitSoon(path.join(dir, changed));
    if (!changed) for (const n of d.names.keys()) if (n !== ".") this.#emitSoon(path.join(dir, n));
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
    this.#dirs.get(dir)?.watcher.close();
    this.#dirs.delete(dir);
  }
}
