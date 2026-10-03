// Windows: everything the main pane lays out. Terminal windows are the panes
// (window id = pane id); browser and file windows live here, persisted so they
// survive core restarts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AppWindow, FileEntry, Pane, WindowId } from "@cmd/protocol";
import type { PaneManager } from "./panes.ts";
import type { Store } from "./store.ts";
import { routeFor, TEXT_MAX_BYTES } from "./routing.ts";
import { pathToFileURL } from "node:url";

export interface OpenParams {
  kind: AppWindow["kind"];
  url?: string;
  path?: string;
  cwd?: string;
  command?: string;
}

const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());

/** Accepts "example.com", "localhost:3000", full URLs; anything else becomes a search-less error. */
export function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return "about:blank";
  if (/^(https?|file|about):/i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(t)) return `https://${t}`;
  throw new Error(`not a URL: ${input}`);
}

export function terminalWindow(p: Pane): AppWindow {
  return {
    id: p.id,
    kind: "terminal",
    title: p.title,
    createdAt: p.createdAt,
    updatedAt: p.lastActivityAt,
    paneId: p.id,
    url: null,
    path: null,
  };
}

export class WindowManager extends EventEmitter<{ updated: [AppWindow]; removed: [WindowId] }> {
  #windows = new Map<WindowId, AppWindow>();
  #panes: PaneManager;
  #store: Store | null;

  constructor(panes: PaneManager, store: Store | null) {
    super();
    this.#panes = panes;
    this.#store = store;
    for (const w of store?.windows() ?? []) this.#windows.set(w.id, w);
  }

  /** Non-terminal windows. */
  others(): AppWindow[] {
    return [...this.#windows.values()];
  }

  list(): AppWindow[] {
    return [...this.#panes.list().map(terminalWindow), ...this.others()];
  }

  open(p: OpenParams): AppWindow {
    if (p.kind === "terminal") {
      return terminalWindow(this.#panes.create({ cwd: p.cwd ? expandHome(p.cwd) : undefined, command: p.command }));
    }
    const now = Date.now();
    const w: AppWindow = {
      id: randomUUID(),
      kind: p.kind,
      title: "",
      createdAt: now,
      updatedAt: now,
      paneId: null,
      url: null,
      path: null,
    };
    if (p.kind === "browser") {
      w.url = normalizeUrl(p.url ?? "");
      w.title = w.url === "about:blank" ? "New Tab" : w.url;
    } else if (p.kind === "text") {
      const file = path.resolve(expandHome(p.path ?? ""));
      if (!fs.statSync(file).isFile()) throw new Error(`not a file: ${file}`);
      w.path = file;
      w.title = path.basename(file);
    } else {
      const dir = path.resolve(expandHome(p.path ?? p.cwd ?? os.homedir()));
      if (!fs.statSync(dir).isDirectory()) throw new Error(`not a folder: ${dir}`);
      w.path = dir;
      w.title = path.basename(dir) || dir;
    }
    this.#save(w);
    return { ...w };
  }

  /** Open a path in the window that suits it (see routing.ts); null = not ours. */
  openPath(p: string): AppWindow | null {
    const abs = path.resolve(expandHome(p));
    const route = routeFor(abs);
    if (route === "files") return this.open({ kind: "files", path: abs });
    if (route === "text") return this.open({ kind: "text", path: abs });
    if (route === "browser") return this.open({ kind: "browser", url: pathToFileURL(abs).href });
    return null;
  }

  update(id: WindowId, patch: { title?: string; url?: string; path?: string }): AppWindow {
    const w = this.#windows.get(id);
    if (!w) throw new Error(`no such window: ${id}`);
    if (patch.url !== undefined && w.kind === "browser") w.url = normalizeUrl(patch.url);
    if (patch.path !== undefined && w.kind === "files") {
      w.path = path.resolve(expandHome(patch.path));
      if (patch.title === undefined) w.title = path.basename(w.path) || w.path;
    }
    if (patch.title !== undefined) w.title = patch.title.slice(0, 300);
    w.updatedAt = Date.now();
    this.#save(w);
    return { ...w };
  }

  close(id: WindowId): void {
    if (this.#panes.get(id)) return this.#panes.kill(id);
    if (!this.#windows.delete(id)) return;
    this.#store?.deleteWindow(id);
    this.emit("removed", id);
  }

  #save(w: AppWindow): void {
    this.#windows.set(w.id, w);
    this.#store?.saveWindow(w);
    this.emit("updated", { ...w });
  }
}

/** Directory listing for file windows: folders first, then by name. */
export function listDir(dir: string): { path: string; parent: string | null; entries: FileEntry[] } {
  const abs = path.resolve(expandHome(dir));
  const entries: FileEntry[] = [];
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, d.name);
    let size = 0;
    let mtime = 0;
    let kind: FileEntry["kind"] = d.isDirectory() ? "dir" : d.isSymbolicLink() ? "link" : "file";
    try {
      const st = fs.statSync(p); // follows links
      size = st.size;
      mtime = st.mtimeMs;
      if (kind === "link" && st.isDirectory()) kind = "dir";
    } catch {}
    entries.push({ name: d.name, path: p, kind, size, mtime, hidden: d.name.startsWith(".") });
  }
  entries.sort((a, b) => (a.kind === "dir") !== (b.kind === "dir") ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, entries };
}

const READ_MAX = 5 * 1024 * 1024;

/** Read a text file for a text window (first 5 MB). */
export function readText(file: string): { text: string; size: number; mtime: number; truncated: boolean; binary: boolean } {
  const abs = path.resolve(expandHome(file));
  const st = fs.statSync(abs);
  const fd = fs.openSync(abs, "r");
  try {
    const len = Math.min(st.size, READ_MAX);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return {
      text: buf.toString("utf8"),
      size: st.size,
      mtime: st.mtimeMs,
      truncated: st.size > READ_MAX,
      binary: buf.subarray(0, 8192).includes(0),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** Save a text window; refuses if the file changed on disk since it was read. */
export function writeText(file: string, text: string, expectMtime?: number): { size: number; mtime: number } {
  const abs = path.resolve(expandHome(file));
  if (expectMtime !== undefined && fs.existsSync(abs) && Math.abs(fs.statSync(abs).mtimeMs - expectMtime) > 1) {
    throw new Error("The file changed on disk since it was opened.");
  }
  if (Buffer.byteLength(text) > TEXT_MAX_BYTES) throw new Error("Too large for a text window.");
  fs.writeFileSync(abs, text);
  const st = fs.statSync(abs);
  return { size: st.size, mtime: st.mtimeMs };
}
