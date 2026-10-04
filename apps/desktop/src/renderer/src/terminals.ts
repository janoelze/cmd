// One xterm.js instance per pane, kept alive while the pane exists so switching
// views never loses state. Views borrow the instance's element.
// WebGL contexts are pooled (browsers keep ~16); others use the DOM renderer.
// See docs/02-terminal-foundations.md.

import { MAC_KEYMAP } from "../../shared/commands.ts";
import { isAppShortcut } from "./keybindings.ts";
import { Terminal, type IBufferCellPosition, type ILink, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { PaneId, Settings } from "@cmd/protocol";
import { DEFAULT_SETTINGS } from "@cmd/protocol";
import { cmd } from "./bridge.ts";
import { currentTheme, onThemeChange, terminalColors } from "./themes/registry.ts";
import { findLinks } from "./links.ts";

// ⌘ keys sent to the PTY as readline control characters: kill line, start, end.
const CMD_KEYS: Record<string, string> = { Backspace: "\x15", ArrowLeft: "\x01", ArrowRight: "\x05" };

interface Host {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  opened: boolean;
  webgl: WebglAddon | null;
  lastUsed: number;
  /** When it was last fitted, and a pending trailing fit (see resized). */
  fittedAt: number;
  fitTimer: ReturnType<typeof setTimeout> | null;
}

/** While a terminal keeps changing size (the app window being resized), fit it at most this often. */
const FIT_INTERVAL = 100;

const theme = (): ITheme => terminalColors(currentTheme());

// ⌘-click links (URLs, existing file paths). xterm asks the provider only for
// the line under the mouse, when the mouse moves onto it, and caches the reply
// for that line, so cost doesn't grow with output or scrollback: one regex pass
// over a capped line, plus one batched existence check (cached) for path-like
// tokens. Detection runs on hover either way; ⌘ only decides whether the link
// is underlined and opens on click (plain clicks stay selection / the app's).
const LINK_MAX_ROWS = 8; // wrapped rows joined on each side of the hovered one
const LINK_MAX_CHARS = 2000;
const RESOLVE_TTL = 5000;
const resolved = new Map<string, { at: number; abs: Promise<string | null> }>();
let hovered: ILink | null = null;
let metaDown = false;
const showLinks = (on: boolean): void => {
  metaDown = on;
  // xterm tracks these properties (not the object) on the link under the mouse.
  if (hovered?.decorations) (hovered.decorations.underline = on), (hovered.decorations.pointerCursor = on);
};
window.addEventListener("keydown", (e) => e.key === "Meta" && showLinks(true), true);
window.addEventListener("keyup", (e) => e.key === "Meta" && showLinks(false), true);
window.addEventListener("blur", () => showLinks(false));

/** Absolute paths of those that exist (relative to cwd), cached briefly; one RPC for the misses. */
function resolvePaths(paths: string[], cwd: string): Promise<(string | null)[]> {
  const now = Date.now();
  if (resolved.size > 500) for (const [k, v] of resolved) if (now - v.at > RESOLVE_TTL) resolved.delete(k);
  const miss = paths.filter((p) => !((resolved.get(`${cwd}\0${p}`)?.at ?? 0) > now - RESOLVE_TTL));
  if (miss.length) {
    const call = cmd.call("fs.resolve", { paths: miss, cwd }).catch(() => miss.map(() => null));
    miss.forEach((p, i) => resolved.set(`${cwd}\0${p}`, { at: now, abs: call.then((r) => r[i] ?? null) }));
  }
  return Promise.all(paths.map((p) => resolved.get(`${cwd}\0${p}`)!.abs));
}

async function openTarget(kind: "url" | "path", target: string): Promise<void> {
  const { openLink, openPath } = await import("./actions.ts");
  if (kind === "url") openLink(target);
  else void openPath(target);
}

function linkProvider(term: Terminal, paneId: PaneId) {
  return {
    provideLinks(y: number, done: (links: ILink[] | undefined) => void): void {
      // The logical line around row y (1-based): wrapped rows joined, with each
      // character's cell, so wide characters and wraps map back exactly.
      const buf = term.buffer.active;
      let top = y - 1;
      while (top > y - 1 - LINK_MAX_ROWS && top > 0 && buf.getLine(top)?.isWrapped) top--;
      let text = "";
      const cells: IBufferCellPosition[] = [];
      for (let row = top; row < y + LINK_MAX_ROWS && text.length < LINK_MAX_CHARS; row++) {
        const line = buf.getLine(row);
        if (!line || (row > top && !line.isWrapped)) break;
        const cell = line.getCell(0);
        for (let x = 0; x < line.length; x++) {
          const c = line.getCell(x, cell);
          const ch = c?.getChars() ?? "";
          if (!c || c.getWidth() === 0) continue; // right half of a wide char
          text += ch || " ";
          for (let i = 0; i < (ch.length || 1); i++) cells.push({ x: x + 1, y: row + 1 });
        }
      }
      const matches = findLinks(text.trimEnd());
      if (!matches.length) return done(undefined);
      const make = (start: number, end: number, open: () => void): ILink => ({
        range: { start: cells[start]!, end: cells[end - 1]! },
        text: text.slice(start, end),
        decorations: { underline: metaDown, pointerCursor: metaDown },
        activate: (e) => e.metaKey && open(),
        hover(this: ILink) {
          hovered = this;
        },
        leave(this: ILink) {
          if (hovered === this) hovered = null;
        },
      });
      const urls = matches.filter((m) => m.kind === "url").map((m) => make(m.start, m.end, () => void openTarget("url", m.target)));
      const paths = matches.filter((m) => m.kind === "path");
      if (!paths.length) return done(urls);
      void import("./store.ts").then(async ({ getState }) => {
        const cwd = getState().panes.get(paneId)?.cwd;
        const abs = cwd ? await resolvePaths(paths.map((m) => m.target), cwd) : [];
        const links = paths.flatMap((m, i) => (abs[i] ? [make(m.start, m.end, () => void openTarget("path", abs[i]!))] : []));
        done([...urls, ...links].sort((a, b) => a.range.start.y - b.range.start.y || a.range.start.x - b.range.start.x));
      });
    },
  };
}

// The WebGL addon loads only when the webgl renderer is used (not the default),
// so it stays out of the startup bundle.
let Webgl: typeof WebglAddon | null = null;
let webglLoading: Promise<void> | null = null;

class Terminals {
  #hosts = new Map<PaneId, Host>();
  /** Terminals whose snapshot is still loading (see hold). */
  #held = new Map<PaneId, { ready: Promise<void>; release: () => void }>();

  /**
   * Keep views from opening a terminal until its content is written (release):
   * writing into a terminal that isn't open only parses, with no per-line
   * rendering or scrollbar work, and its first paint shows the final content.
   */
  hold(paneId: PaneId): void {
    if (this.#held.has(paneId)) return;
    let release!: () => void;
    const ready = new Promise<void>((r) => (release = r));
    this.#held.set(paneId, { ready, release });
  }

  release(paneId: PaneId): void {
    this.#held.get(paneId)?.release();
    this.#held.delete(paneId);
  }

  /** Resolves when the terminal may be shown; null if it may be now. */
  whenReady(paneId: PaneId): Promise<void> | null {
    return this.#held.get(paneId)?.ready ?? null;
  }
  #settings: Settings = DEFAULT_SETTINGS;
  /** ⌘+/⌘- offset on top of font.codeSize (persisted by the app). */
  #zoom = 0;

  /** Font size offset on top of font.codeSize (⌘+ / ⌘-). */
  setZoom(offset: number): void {
    if (offset === this.#zoom) return;
    this.#zoom = offset;
    this.configure(this.#settings, true);
  }

  /** Apply settings to existing and future terminals. */
  configure(s: Settings, fontChanged = false): void {
    const prev = this.#settings;
    this.#settings = s;
    for (const [id, h] of this.#hosts) {
      Object.assign(h.term.options, this.#options());
      if (s["terminal.renderer"] !== "webgl" && h.webgl) {
        h.webgl.dispose();
        h.webgl = null;
      } else if (s["terminal.renderer"] === "webgl" && !h.webgl && h.opened) {
        this.#ensureWebgl(h);
      }
      if (fontChanged || s["font.code"] !== prev["font.code"] || s["font.codeSize"] !== prev["font.codeSize"]) {
        h.webgl?.clearTextureAtlas();
      }
      this.fit(id);
    }
    // A smaller pool: hand the least recently used terminals back to the DOM renderer.
    const live = [...this.#hosts.values()].filter((h) => h.webgl).sort((a, b) => b.lastUsed - a.lastUsed);
    for (const h of live.slice(Math.max(0, s["terminal.webglPool"]))) {
      h.webgl!.dispose();
      h.webgl = null;
    }
  }

  #options() {
    const s = this.#settings;
    return {
      fontFamily: s["font.code"],
      fontSize: Math.max(6, s["font.codeSize"] + this.#zoom),
      lineHeight: s["terminal.lineHeight"],
      cursorBlink: s["terminal.cursorBlink"],
      scrollback: s["terminal.scrollback"],
    };
  }

  get(paneId: PaneId): Host {
    let h = this.#hosts.get(paneId);
    if (h) return h;
    const term = new Terminal({
      ...this.#options(),
      macOptionIsMeta: true,
      allowProposedApi: true,
      theme: theme(),
      // OSC 8 hyperlinks (ls --hyperlink, Claude Code…): ⌘-click too, no confirm dialog.
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (e, uri) => {
          if (!e.metaKey) return;
          if (/^https?:/i.test(uri)) void openTarget("url", uri);
          else if (/^file:/i.test(uri)) void openTarget("path", decodeURIComponent(new URL(uri).pathname));
          else cmd.openPath(uri);
        },
      },
    });
    term.registerLinkProvider(linkProvider(term, paneId));
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.onData((data) => void cmd.call("pane.write", { paneId, data }));
    term.onResize(({ cols, rows }) => void cmd.call("pane.resize", { paneId, cols, rows }));
    // App shortcuts are menu key equivalents (main process); keep them out of the PTY:
    // ⌘-anything on macOS, the bound Ctrl combinations elsewhere (Ctrl+Shift+K…).
    // Except the line-editing keys macOS terminals translate (⌘⌫ ⌘← ⌘→, as Ghostty does).
    // ⇧↩ sends ESC CR, which agents (Claude Code, Codex) read as a newline in their input
    // and zsh inserts as one; xterm.js would send a plain CR, the same as ↩.
    term.attachCustomKeyEventHandler((e) => {
      if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.type === "keydown") void cmd.call("pane.write", { paneId, data: "\x1b\r" });
        return false;
      }
      if (!MAC_KEYMAP) return !isAppShortcut(e);
      if (!e.metaKey) return true;
      const seq = !e.ctrlKey && !e.altKey && !e.shiftKey ? CMD_KEYS[e.key] : undefined;
      if (seq && e.type === "keydown") void cmd.call("pane.write", { paneId, data: seq });
      return false;
    });
    const el = document.createElement("div");
    el.className = "xterm-host";
    // Mark terminals that have scrollback, so the scrollbar only shows when there's
    // something to scroll to (full-screen apps like Claude Code draw in place: none).
    const scrollable = () => el.classList.toggle("scrollable", term.buffer.active.baseY > 0);
    term.onWriteParsed(scrollable);
    term.buffer.onBufferChange(scrollable);
    term.onResize(scrollable);
    h = { term, fit, el, opened: false, webgl: null, lastUsed: Date.now(), fittedAt: 0, fitTimer: null };
    this.#hosts.set(paneId, h);
    return h;
  }

  attach(paneId: PaneId, container: HTMLElement): void {
    const h = this.get(paneId);
    h.lastUsed = Date.now();
    container.appendChild(h.el);
    if (!h.opened) {
      h.term.open(h.el);
      h.opened = true;
    }
    this.#ensureWebgl(h);
    this.fit(paneId);
  }

  detach(paneId: PaneId, container: HTMLElement): void {
    const h = this.#hosts.get(paneId);
    if (h && h.el.parentElement === container) container.removeChild(h.el);
  }

  fit(paneId: PaneId): void {
    const h = this.#hosts.get(paneId);
    if (!h?.opened || !h.el.isConnected) return;
    if (h.fitTimer) clearTimeout(h.fitTimer), (h.fitTimer = null);
    h.fittedAt = performance.now();
    try {
      h.fit.fit();
    } catch {}
  }

  /**
   * The terminal's element changed size. A single change (sidebar, mode switch)
   * fits right away; a continuous one fits every FIT_INTERVAL ms and once at the
   * end. Each fit reflows the scrollback and resizes the PTY, whose program then
   * redraws, so fitting on every frame of a window resize makes it lag.
   */
  resized(paneId: PaneId): void {
    const h = this.#hosts.get(paneId);
    if (!h || h.fitTimer) return;
    const wait = h.fittedAt + FIT_INTERVAL - performance.now();
    if (wait <= 0) return this.fit(paneId);
    h.fitTimer = setTimeout(() => this.fit(paneId), wait);
  }

  focus(paneId: PaneId): void {
    this.#hosts.get(paneId)?.term.focus();
  }

  /** Copies the selection; false if there is none. */
  copy(paneId: PaneId): boolean {
    const t = this.#hosts.get(paneId)?.term;
    if (!t?.hasSelection()) return false;
    void navigator.clipboard.writeText(t.getSelection());
    return true;
  }

  selectAll(paneId: PaneId): void {
    this.#hosts.get(paneId)?.term.selectAll();
  }

  /** Clears scrollback and screen, keeping the prompt line (like Terminal.app). */
  clear(paneId: PaneId): void {
    this.#hosts.get(paneId)?.term.clear();
  }

  /** Paste with bracketed-paste handling. */
  paste(paneId: PaneId, text: string): void {
    this.#hosts.get(paneId)?.term.paste(text);
  }

  hasSelection(paneId: PaneId): boolean {
    return !!this.#hosts.get(paneId)?.term.hasSelection();
  }

  /**
   * Write output. With a size (a snapshot's), the terminal takes it first: a
   * fresh terminal is 80x24, and a wider screen replayed into it wraps and puts
   * its cursor moves on the wrong cells (Claude Code comes out mangled). That is
   * the PTY's size already, so it isn't resized; the next fit sets the real one.
   */
  write(paneId: PaneId, data: string, size?: { cols: number; rows: number }): void {
    const t = this.get(paneId).term;
    if (size && (size.cols !== t.cols || size.rows !== t.rows)) t.resize(size.cols, size.rows);
    t.write(data);
  }

  reset(paneId: PaneId): void {
    this.get(paneId).term.reset();
  }

  dispose(paneId: PaneId): void {
    const h = this.#hosts.get(paneId);
    if (!h) return;
    if (h.fitTimer) clearTimeout(h.fitTimer);
    // With mouse reporting on (Claude Code, vim), a mousedown adds mousemove/mouseup
    // listeners on the document that only a mouseup removes, and dispose doesn't.
    // Closing the pane mid-drag would leave them calling into the disposed renderer
    // ("reading 'dimensions'") on every later drag, so end the drag first.
    if (h.opened && h.term.modes.mouseTrackingMode !== "none") document.dispatchEvent(new MouseEvent("mouseup"));
    h.webgl?.dispose();
    h.term.dispose();
    h.el.remove();
    this.#hosts.delete(paneId);
  }

  #ensureWebgl(h: Host): void {
    const pool = this.#settings["terminal.webglPool"];
    if (h.webgl || pool <= 0 || this.#settings["terminal.renderer"] !== "webgl") return;
    if (!Webgl) {
      webglLoading ??= import("@xterm/addon-webgl").then((m) => void (Webgl = m.WebglAddon));
      // Once loaded, upgrade this terminal unless it was disposed meanwhile.
      void webglLoading.then(() => [...this.#hosts.values()].includes(h) && this.#ensureWebgl(h));
      return;
    }
    const live = [...this.#hosts.values()].filter((x) => x.webgl);
    if (live.length >= pool) {
      // Evict the least recently used terminal back to the DOM renderer.
      const lru = live.sort((a, b) => a.lastUsed - b.lastUsed)[0]!;
      lru.webgl!.dispose();
      lru.webgl = null;
    }
    try {
      const addon = new Webgl();
      addon.onContextLoss(() => {
        addon.dispose();
        h.webgl = null;
      });
      h.term.loadAddon(addon);
      h.webgl = addon;
    } catch {
      h.webgl = null;
    }
  }

  applyTheme(): void {
    for (const h of this.#hosts.values()) h.term.options.theme = theme();
  }
}

export const terminals = new Terminals();
onThemeChange(() => terminals.applyTheme());
