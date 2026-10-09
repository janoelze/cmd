// Windows: everything the main pane lays out. Terminal windows are the panes
// (window id = pane id); browser and file windows live here, persisted so they
// survive core restarts.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AppWindow, FileEntry, Pane, Workspace, WorkspaceId, WindowId } from "@cmd/protocol";
import type { PaneManager } from "../panes.ts";
import type { Store } from "../store.ts";
import { expandHome } from "./builtin.ts";
import { targetFor, TEXT_MAX_BYTES } from "./routing.ts";
import type { WindowTypes } from "./types.ts";

export { normalizeUrl } from "./builtin.ts";

export function terminalWindow(p: Pane): AppWindow {
  return {
    id: p.id,
    workspaceId: p.workspaceId,
    kind: "terminal",
    title: p.title,
    createdAt: p.createdAt,
    updatedAt: p.lastActivityAt,
    state: { paneId: p.id, cwd: p.cwd },
  };
}

/** Window types that were renamed: old kind → new (stored windows are moved over on load). */
const RENAMED_KINDS: Readonly<Record<string, string>> = { livecode: "jam" };

/**
 * Windows: everything the main pane lays out. Terminal windows are the panes
 * (window id = pane id); other windows are created by their WindowType and
 * persisted, so they survive core restarts. State is opaque per type.
 */
export class WindowManager extends EventEmitter<{ updated: [AppWindow]; removed: [WindowId] }> {
  #windows = new Map<WindowId, AppWindow>();
  #panes: PaneManager;
  #store: Store | null;
  readonly types: WindowTypes;
  #overrides: () => Record<string, string>;

  constructor(panes: PaneManager, store: Store | null, types: WindowTypes, overrides: () => Record<string, string> = () => ({})) {
    super();
    this.#panes = panes;
    this.#store = store;
    this.types = types;
    this.#overrides = overrides;
    for (const w of store?.windows() ?? []) {
      // A window type that was renamed: its stored windows carry on under the new name.
      const renamed = RENAMED_KINDS[w.kind];
      if (renamed) (w.kind = renamed), store?.saveWindow(w);
      this.#windows.set(w.id, w);
    }
  }

  /** Non-terminal windows. */
  others(): AppWindow[] {
    return [...this.#windows.values()];
  }

  list(): AppWindow[] {
    return [...this.#panes.list().map(terminalWindow), ...this.others()];
  }

  /** Open in `workspace`; a type without an explicit cwd (terminal, files) starts at the workspace's root. */
  open(kind: string, input: Record<string, unknown>, workspace: Workspace): AppWindow {
    if (typeof input.cwd !== "string") input = { ...input, cwd: workspace.root };
    if (kind === "terminal") {
      const cwd = typeof input.cwd === "string" ? expandHome(input.cwd) : undefined;
      const command = typeof input.command === "string" ? input.command : undefined;
      return terminalWindow(this.#panes.create({ cwd, command, workspaceId: workspace.id }));
    }
    const type = this.types.get(kind);
    if (!type) throw new Error(`unknown window type: ${kind}`);
    const { state, title } = type.create(input);
    const now = Date.now();
    const w: AppWindow = { id: randomUUID(), workspaceId: workspace.id, kind, title, createdAt: now, updatedAt: now, state };
    this.#save(w);
    return { ...w };
  }

  /** Open a path or URL in the window type that suits it; null = not ours (use the default app). */
  openTarget(input: string, workspace: Workspace): AppWindow | null {
    const target = targetFor(input);
    if (!target) return null;
    const type = this.types.resolve(target, this.#overrides());
    if (!type) return null;
    return this.open(type.kind, type.fromTarget ? type.fromTarget(target) : {}, workspace);
  }

  /** Move a non-terminal window (terminals move with their pane, see Core). */
  move(id: WindowId, workspaceId: WorkspaceId): AppWindow {
    const w = this.#windows.get(id);
    if (!w) throw new Error(`no such window: ${id}`);
    if (w.workspaceId !== workspaceId) {
      w.workspaceId = workspaceId;
      w.updatedAt = Date.now();
      this.#save(w);
    }
    return { ...w };
  }

  /** Non-terminal windows of a workspace. */
  inWorkspace(workspaceId: WorkspaceId): AppWindow[] {
    return this.others().filter((w) => w.workspaceId === workspaceId);
  }

  update(id: WindowId, patch: { title?: string; state?: Record<string, unknown>; kind?: string }): AppWindow {
    const w = this.#windows.get(id);
    if (!w) throw new Error(`no such window: ${id}`);
    if (patch.kind !== undefined && patch.kind !== w.kind) {
      // Switch type in place (e.g. Markdown ⇄ text), keeping id, slot and size.
      // The new type re-creates its state from the current one.
      const next = this.types.get(patch.kind);
      if (!next || patch.kind === "terminal") throw new Error(`cannot switch to window type: ${patch.kind}`);
      const r = next.create({ ...w.state });
      w.kind = patch.kind;
      w.state = r.state;
      w.title = r.title;
    }
    if (patch.state) {
      const type = this.types.get(w.kind);
      const r = type?.update ? type.update(w.state, patch.state) : { state: { ...w.state, ...patch.state } };
      w.state = r.state;
      if (r.title !== undefined) w.title = r.title;
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

/** Paths that exist, made absolute against cwd; null for the rest (terminal links). */
export function resolvePaths(paths: string[], cwd: string): (string | null)[] {
  const base = path.resolve(expandHome(cwd));
  return paths.map((p) => {
    const abs = path.resolve(base, expandHome(p));
    return fs.existsSync(abs) ? abs : null;
  });
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
  if (Buffer.byteLength(text) > TEXT_MAX_BYTES) throw new Error("Too large for the text editor.");
  fs.writeFileSync(abs, text);
  const st = fs.statSync(abs);
  return { size: st.size, mtime: st.mtimeMs };
}
