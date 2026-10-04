// App windows ↔ Spaces (docs/11-spaces.md). Each app window shows one Space and
// a Space is shown in at most one window, because its layout is fitted to one
// viewport. Every switch goes through here: show() focuses the window that
// already shows the Space, or switches the asking window, or opens a new one.
// Which window shows what (and where it sits) is kept in windows.json, so all
// windows come back on launch. The core's space.show events (`cmd .`) arrive here too.

import { app, BrowserWindow, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import { HOME_SPACE_ID } from "@cmd/protocol";
import { cmdHome, connect } from "@cmd/protocol/node";

export interface Bounds { x?: number; y?: number; width: number; height: number; maximized?: boolean }

const DEFAULT_BOUNDS: Bounds = { width: 1400, height: 900 };
const file = () => path.join(cmdHome(), "windows.json");

/** Saved bounds, if still on a screen; else only the size. */
function onScreen(b: Bounds): Bounds {
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x !== undefined && b.y !== undefined && b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + 40 > a.y;
  });
  return visible ? b : { width: b.width, height: b.height };
}

function focus(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export class SpaceWindows {
  #create: (spaceId: string, bounds: Bounds) => BrowserWindow;
  #shown = new Map<BrowserWindow, string>();
  #bounds = new Map<BrowserWindow, Bounds>();
  /** The Space of the most recently focused window: reopened when the last window was closed. */
  #last = HOME_SPACE_ID;
  #quitting = false;
  #saveTimer: NodeJS.Timeout | undefined;

  constructor(create: (spaceId: string, bounds: Bounds) => BrowserWindow) {
    this.#create = create;
    app.on("before-quit", () => {
      this.#save();
      this.#quitting = true;
    });
  }

  /** Reopen the windows of the last session (at least one). */
  restore(): void {
    let saved: { spaceId: string; bounds: Bounds }[] = [];
    try {
      saved = JSON.parse(fs.readFileSync(file(), "utf8")).windows ?? [];
    } catch {}
    const seen = new Set<string>();
    for (const w of saved) {
      if (typeof w.spaceId !== "string" || seen.has(w.spaceId)) continue;
      seen.add(w.spaceId);
      this.#open(w.spaceId, onScreen(w.bounds ?? DEFAULT_BOUNDS));
    }
    if (seen.size === 0) this.#open(HOME_SPACE_ID, DEFAULT_BOUNDS);
  }

  /** A window for when none is open (Dock click, a command with no window). */
  reopen(): BrowserWindow {
    return this.#open(this.#last, this.#nextBounds());
  }

  spaceOf(win: BrowserWindow): string | undefined {
    return this.#shown.get(win);
  }

  #owner(spaceId: string): BrowserWindow | undefined {
    for (const [w, s] of this.#shown) if (s === spaceId && !w.isDestroyed()) return w;
    return undefined;
  }

  /**
   * Show a Space: in the window that already shows it, else in `from` (the
   * asking window), else (newWindow, or no window to ask) in a new window.
   */
  show(spaceId: string, o: { select?: string; newWindow?: boolean }, from: BrowserWindow | null): void {
    const owner = this.#owner(spaceId);
    const target = owner ?? (o.newWindow || !from || from.isDestroyed() ? null : from);
    if (!target) {
      const win = this.#open(spaceId, this.#nextBounds());
      if (o.select) win.webContents.once("did-finish-load", () => win.webContents.send("space-show", { spaceId, select: o.select }));
      focus(win);
      return;
    }
    if (target !== owner) {
      this.#shown.set(target, spaceId);
      this.#save();
    }
    target.webContents.send("space-show", { spaceId, select: o.select });
    this.#last = spaceId;
    focus(target);
  }

  /** The window's Space was closed: show Home there, or close the window if another one shows Home. */
  lost(win: BrowserWindow): void {
    if (this.#owner(HOME_SPACE_ID) && this.#owner(HOME_SPACE_ID) !== win) win.close();
    else this.show(HOME_SPACE_ID, {}, win);
  }

  #open(spaceId: string, bounds: Bounds): BrowserWindow {
    const win = this.#create(spaceId, bounds);
    this.#shown.set(win, spaceId);
    this.#bounds.set(win, bounds);
    this.#last = spaceId;
    const track = () => {
      if (win.isDestroyed() || win.isFullScreen()) return;
      this.#bounds.set(win, { ...win.getNormalBounds(), maximized: win.isMaximized() });
      this.#saveSoon();
    };
    win.on("resize", track);
    win.on("move", track);
    win.on("focus", () => (this.#last = this.#shown.get(win) ?? this.#last));
    win.on("closed", () => {
      // Quitting closes every window; keep them for the next launch.
      if (this.#quitting) return;
      this.#shown.delete(win);
      this.#bounds.delete(win);
      this.#save();
    });
    this.#save();
    return win;
  }

  /** A new window cascades from the focused one, like macOS document windows. */
  #nextBounds(): Bounds {
    const from = BrowserWindow.getFocusedWindow();
    const b = (from && this.#bounds.get(from)) ?? [...this.#bounds.values()].at(-1);
    if (!b) return DEFAULT_BOUNDS;
    return onScreen({ width: b.width, height: b.height, x: b.x === undefined ? undefined : b.x + 24, y: b.y === undefined ? undefined : b.y + 24 });
  }

  #saveSoon(): void {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#save(), 300);
  }

  #save(): void {
    clearTimeout(this.#saveTimer);
    if (this.#quitting) return;
    const windows = [...this.#shown].filter(([w]) => !w.isDestroyed()).map(([w, spaceId]) => ({ spaceId, bounds: this.#bounds.get(w) }));
    try {
      fs.mkdirSync(cmdHome(), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify({ windows }));
    } catch {}
  }

  /**
   * Follow the core's space.show events (`cmd .` in any shell): bring the app
   * forward and show the Space in the frontmost window. Reconnects with the core.
   */
  followCore(socketPath: string, appWindows: () => BrowserWindow[]): void {
    const attach = async () => {
      try {
        const conn = await connect(socketPath);
        conn.client.onEvent((e) => {
          if (e.type !== "space.show") return;
          app.focus({ steal: true });
          const focused = BrowserWindow.getFocusedWindow();
          const from = (focused && this.#shown.has(focused) ? focused : null) ?? appWindows().find((w) => this.#shown.get(w) === this.#last) ?? null;
          this.show(e.spaceId, { newWindow: e.newWindow }, from);
        });
        await conn.client.call("events.subscribe", { types: ["space.show"] });
        // Soon after a restart (Restart Core), or `cmd .` goes unheard meanwhile.
        conn.closed.then(() => setTimeout(attach, 250));
      } catch {
        setTimeout(attach, 250);
      }
    };
    void attach();
  }
}
