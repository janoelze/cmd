// One xterm.js instance per pane, kept alive while the pane exists so switching
// views never loses state. Views borrow the instance's element.
// WebGL contexts are pooled (browsers keep ~16); others use the DOM renderer.
// Also what xterm.js leaves to the app: find (⌘F), prompt marks (OSC 133:
// ⌘↑/⌘↓, copy last output), OSC 52 copy, images, drag-and-drop, paste
// protection, Option as Meta per side, and the queries it doesn't answer
// (XTVERSION, color scheme). See docs/02-terminal-foundations.md.

import { MAC_KEYMAP } from "../../shared/commands.ts";
import { isAppShortcut } from "./keybindings.ts";
import { Terminal, type IBufferCellPosition, type IDisposable, type ILink, type IMarker, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { ImageAddon } from "@xterm/addon-image";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { PaneId, Settings } from "@cmd/protocol";
import { DEFAULT_SETTINGS } from "@cmd/protocol";
import { cmd } from "./bridge.ts";
import { currentTheme, onThemeChange, terminalColors } from "@cmd/ui/themes";
import { findLinks, logicalLine, type Row } from "./links.ts";
import { scrolled, type FindOptions, type FindResults } from "@cmd/ui";
import type { FindRequest } from "./find.tsx";
import { pasteRisk, preview, shellWord } from "./paste.ts";
import { registerDropTarget } from "./drops.ts";
import { Replayer } from "@cmd/protocol/replay";

// ⌘ keys sent to the PTY as readline control characters: kill line, start, end.
const CMD_KEYS: Record<string, string> = { Backspace: "\x15", ArrowLeft: "\x01", ArrowRight: "\x05" };

interface Host {
  paneId: PaneId;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  images: ImageAddon | null;
  /** Shell integration marks (OSC 133): where prompts start, and each command's output. */
  prompts: IMarker[];
  outputs: { start: IMarker; end: IMarker | null }[];
  /** The last ⌘↑/⌘↓ target, while the view is still where that jump left it. */
  jump: { line: number; viewportY: number } | null;
  /** Mode 2031: the program wants to hear when the color scheme changes. */
  schemeUpdates: boolean;
  /** The last search's options: the addon caches by query alone, so a change has to reset it. */
  findOptions: string;
  /** Keeps xterm from answering device attribute queries (see #quietDA). */
  quietDA: IDisposable | null;
  el: HTMLDivElement;
  opened: boolean;
  webgl: WebglAddon | null;
  lastUsed: number;
  /** When it was last fitted, and a pending trailing fit (see resized). */
  fittedAt: number;
  fitTimer: ReturnType<typeof setTimeout> | null;
  /** The PTY's size, told at most every FIT_INTERVAL ms: when it was last told, and a size waiting. */
  ptyAt: number;
  ptyTimer: ReturnType<typeof setTimeout> | null;
  /** Writes snapshots at their size; no fitting while one is being parsed (@cmd/protocol/replay). */
  replays: Replayer;
  /** Removes its drop target (drops.ts). */
  undrop: () => void;
}

/** While a terminal keeps changing size (the app window being resized), fit it at most this often. */
const FIT_INTERVAL = 100;

const theme = (): ITheme => terminalColors(currentTheme());

/** Marks kept per terminal; older ones go (and with scrollback, xterm disposes them). */
const MAX_MARKS = 1000;

/** The app's version, for XTVERSION (programs that check what terminal they're in). */
let version = "";
void cmd.appInfo().then((i) => (version = i.version), () => {});

/** Which Option key is down, for terminal.optionAsMeta = left / right. */
let optionSide: "left" | "right" | null = null;
window.addEventListener("keydown", (e) => e.key === "Alt" && (optionSide = e.code === "AltRight" ? "right" : "left"), true);
window.addEventListener("keyup", (e) => e.key === "Alt" && (optionSide = null), true);
window.addEventListener("blur", () => (optionSide = null));

/** #RRGGBB for search highlights (they don't take other formats). */
const hex = (c: string | undefined, fallback: string): string => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : fallback);
function searchOptions(o: FindOptions): ISearchOptions {
  const t = theme();
  const match = hex(t.yellow, "#c0a030");
  return {
    ...o,
    decorations: {
      matchBackground: hex(t.selectionBackground, "#44475a"),
      matchBorder: match,
      matchOverviewRuler: match,
      activeMatchBackground: match,
      activeMatchColorOverviewRuler: hex(t.brightYellow, match),
    },
  };
}


// ⌘-click links (URLs, existing file paths). xterm asks the provider only for
// the line under the mouse, when the mouse moves onto it, and caches the reply
// for that line, so cost doesn't grow with output or scrollback: one regex pass
// over a capped line, plus one batched existence check (cached) for path-like
// tokens. Detection runs on hover either way; ⌘ only decides whether the link
// is underlined and opens on click (plain clicks stay selection / the app's).
const LINK_MAX_ROWS = 8; // rows read on each side of the hovered one
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
  else void openPath(target, "content");
}

function linkProvider(term: Terminal, paneId: PaneId) {
  return {
    provideLinks(y: number, done: (links: ILink[] | undefined) => void): void {
      // The logical line around row y (1-based), from the rows on either side:
      // soft wraps and URLs wrapped by the program (logicalLine), with each
      // character's cell, so wide characters and wraps map back exactly.
      const buf = term.buffer.active;
      const rows: Row[] = [];
      const first = Math.max(0, y - 1 - LINK_MAX_ROWS);
      for (let row = first; row < y + LINK_MAX_ROWS; row++) {
        const line = buf.getLine(row);
        if (!line) break;
        let text = "";
        const cells: IBufferCellPosition[] = [];
        const cell = line.getCell(0);
        for (let x = 0; x < line.length; x++) {
          const c = line.getCell(x, cell);
          const ch = c?.getChars() ?? "";
          if (!c || c.getWidth() === 0) continue; // right half of a wide char
          text += ch || " ";
          for (let i = 0; i < (ch.length || 1); i++) cells.push({ x: x + 1, y: row + 1 });
        }
        rows.push({ text, cells, wrapped: line.isWrapped });
      }
      const { text: full, cells } = logicalLine(rows, y - 1 - first, term.cols);
      const text = full.slice(0, LINK_MAX_CHARS);
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
  /** Terminals a remote device sizes to its screen (see setOverride). */
  #overrides = new Map<PaneId, { cols: number; rows: number }>();
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
        // Only into free pool slots. Evicting one terminal to upgrade the next, for every
        // terminal in turn, recreated contexts on each settings change; past Chromium's
        // limit of 16 per page it loses live terminals' contexts, which go blank.
        this.#ensureWebgl(h, false);
      }
      if (s["terminal.images"] !== !!h.images) this.#setImages(h, s["terminal.images"]);
      if (fontChanged || s["font.code"] !== prev["font.code"] || s["font.codeSize"] !== prev["font.codeSize"]) {
        h.webgl?.clearTextureAtlas();
      }
      this.fit(id);
    }
    // A smaller pool: hand the least recently used terminals back to the DOM renderer.
    const live = [...this.#hosts.values()].filter((h) => h.webgl).sort((a, b) => b.lastUsed - a.lastUsed);
    for (const h of live.slice(Math.max(0, s["terminal.webglPool"]))) this.#dropWebgl(h);
  }

  #options() {
    const s = this.#settings;
    return {
      fontFamily: s["font.code"],
      fontSize: Math.max(6, s["font.codeSize"] + this.#zoom),
      lineHeight: s["terminal.lineHeight"],
      cursorBlink: s["terminal.cursorBlink"],
      cursorStyle: s["terminal.cursorStyle"],
      minimumContrastRatio: s["terminal.minimumContrast"],
      macOptionIsMeta: s["terminal.optionAsMeta"] === "both",
      scrollback: s["terminal.scrollback"],
    };
  }

  get(paneId: PaneId): Host {
    let h = this.#hosts.get(paneId);
    if (h) return h;
    const term = new Terminal({
      ...this.#options(),
      allowProposedApi: true,
      // ⌥-drag selects in programs that use the mouse (Claude Code, vim, htop).
      macOptionClickForcesSelection: true,
      // Size reports some programs use to fit images and layouts (CSI 14/16/18 t).
      windowOptions: { getWinSizePixels: true, getCellSizePixels: true, getWinSizeChars: true },
      theme: theme(),
      // OSC 8 hyperlinks (ls --hyperlink, Claude Code…): ⌘-click too, no xterm dialog.
      // The link text can say anything, so other schemes go to main as content:
      // it confirms them (smb:, app URL handlers) in a sheet naming the real URL.
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (e, uri) => {
          if (!e.metaKey) return;
          if (/^https?:/i.test(uri)) void openTarget("url", uri);
          else if (/^file:/i.test(uri)) void openTarget("path", decodeURIComponent(new URL(uri).pathname));
          else cmd.openPath(uri, { from: "content" });
        },
      },
    });
    term.registerLinkProvider(linkProvider(term, paneId));
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    // Past its highlight limit xterm stops knowing which match is current: "1000+".
    search.onDidChangeResults((r) => this.#findListeners.get(paneId)?.results({ index: r.resultIndex, count: r.resultCount, more: r.resultIndex < 0 && r.resultCount > 0 }));
    // Emoji and CJK as two cells, as programs measure them (the PTY host's terminal matches: terminals/local.ts).
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    const el = document.createElement("div");
    h = {
      paneId,
      term,
      fit,
      search,
      images: null,
      prompts: [],
      outputs: [],
      jump: null,
      schemeUpdates: false,
      quietDA: null,
      findOptions: "",
      el,
      opened: false,
      webgl: null,
      lastUsed: Date.now(),
      fittedAt: 0,
      fitTimer: null,
      ptyAt: 0,
      ptyTimer: null,
      replays: new Replayer(term),
      undrop: () => {},
    };
    const host = h;
    if (this.#settings["terminal.images"]) this.#setImages(h, true);
    this.#protocol(host);
    // Input and sizes go to the core without waiting. A pane that exited or closed meanwhile
    // (xterm still fits and sizes it) answers "no such pane": not an error worth a crash report.
    term.onData((data) => void cmd.call("pane.write", { paneId, data }).catch(() => {}));
    // The desktop's size; not while a device sizes the terminal (that's the device's size).
    // A resize of the PTY makes its program redraw (a TUI all of it), so while the terminal
    // keeps changing size (rows follow the app window every frame, see resized) the PTY
    // hears at most every FIT_INTERVAL ms, the last size always.
    term.onResize(() => {
      const h = this.#hosts.get(paneId);
      if (!h || this.#overrides.has(paneId) || h.ptyTimer) return;
      const send = () => {
        h.ptyTimer = null;
        h.ptyAt = performance.now();
        if (!this.#overrides.has(paneId)) void cmd.call("pane.resize", { paneId, cols: h.term.cols, rows: h.term.rows }).catch(() => {});
      };
      const wait = h.ptyAt + FIT_INTERVAL - performance.now();
      if (wait <= 0) send();
      else h.ptyTimer = setTimeout(send, wait);
    });
    // App shortcuts are menu key equivalents (main process); keep them out of the PTY:
    // ⌘-anything on macOS, the bound Ctrl combinations elsewhere (Ctrl+Shift+K…).
    // Except the line-editing keys macOS terminals translate (⌘⌫ ⌘← ⌘→, as Ghostty does).
    // ⇧↩ sends ESC CR, which agents (Claude Code, Codex) read as a newline in their input
    // and zsh inserts as one; xterm.js would send a plain CR, the same as ↩.
    // Option as Meta for one side only: decided per key, from which Option is down.
    // ⌘↑ ⌘↓ jump between prompts, ⌘Home ⌘End ⌘PgUp ⌘PgDn scroll (Terminal.app, Ghostty).
    term.attachCustomKeyEventHandler((e) => {
      if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.type === "keydown") void cmd.call("pane.write", { paneId, data: "\x1b\r" }).catch(() => {});
        return false;
      }
      if (!MAC_KEYMAP) return !isAppShortcut(e);
      if (e.altKey && !e.metaKey) {
        const mode = this.#settings["terminal.optionAsMeta"];
        const meta = mode === "both" || (mode !== "off" && mode === optionSide);
        if (term.options.macOptionIsMeta !== meta) term.options.macOptionIsMeta = meta;
      }
      if (!e.metaKey) return true;
      if (e.type === "keydown" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const seq = CMD_KEYS[e.key];
        if (seq) void cmd.call("pane.write", { paneId, data: seq }).catch(() => {});
        else if (e.key === "ArrowUp") this.jumpToPrompt(paneId, -1);
        else if (e.key === "ArrowDown") this.jumpToPrompt(paneId, 1);
        else if (e.key === "Home") term.scrollToTop();
        else if (e.key === "End") term.scrollToBottom();
        else if (e.key === "PageUp") term.scrollPages(-1);
        else if (e.key === "PageDown") term.scrollPages(1);
      }
      return false;
    });
    el.className = "xterm-host";
    this.#dom(host);
    // Mark terminals that have scrollback, so the scrollbar only shows when there's
    // something to scroll to (full-screen apps like Claude Code draw in place: none).
    const scrollable = () => el.classList.toggle("scrollable", term.buffer.active.baseY > 0);
    term.onWriteParsed(scrollable);
    term.buffer.onBufferChange(scrollable);
    term.onResize(scrollable);
    // xterm scrolls without DOM scroll events: tell the kit, so the bar fades like every other.
    term.onScroll(() => scrolled(el));
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
    if (!h?.opened || !h.el.isConnected || h.replays.busy) return;
    if (h.fitTimer) clearTimeout(h.fitTimer), (h.fitTimer = null);
    h.fittedAt = performance.now();
    const o = this.#overrides.get(paneId);
    try {
      if (o) h.term.resize(o.cols, o.rows);
      else h.fit.fit();
    } catch {}
  }

  /**
   * A remote device sizes this terminal (Pane.sizedBy): draw it at that size,
   * top-left in its window, and don't send this window's size. null: fit again,
   * which hands the core the desktop's size back.
   */
  setOverride(paneId: PaneId, size: { cols: number; rows: number } | null): void {
    const was = this.#overrides.get(paneId);
    if (size && was && was.cols === size.cols && was.rows === size.rows) return;
    if (!size && !was) return;
    if (size) this.#overrides.set(paneId, size);
    else this.#overrides.delete(paneId);
    this.fit(paneId);
  }

  /**
   * The terminal's element changed size. Its rows follow at once (no reflow; the PTY
   * hears as often as onResize lets it), so a terminal grows and shrinks with its
   * window in step. Its width: a single change (sidebar, mode switch) fits
   * right away; a continuous one fits every FIT_INTERVAL ms and once at the end. A new
   * width reflows the scrollback, so fitting on every frame of a window resize makes it lag.
   */
  resized(paneId: PaneId): void {
    const h = this.#hosts.get(paneId);
    if (!h || h.replays.busy) return;
    if (h.opened && h.el.isConnected && !this.#overrides.has(paneId)) {
      const d = h.fit.proposeDimensions();
      // Rows never wait for columns: a new width is the throttled fit's below.
      if (d && d.rows > 0 && d.rows !== h.term.rows) h.term.resize(h.term.cols, d.rows);
    }
    if (h.fitTimer) return;
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

  /** Paste with bracketed-paste handling, asking first when it's risky (terminal.pasteProtection). */
  async paste(paneId: PaneId, text: string): Promise<void> {
    const t = this.#hosts.get(paneId)?.term;
    if (!t || !text) return;
    const risk = this.#settings["terminal.pasteProtection"] ? pasteRisk(text, t.modes.bracketedPasteMode) : null;
    if (risk && !(await cmd.confirm({ message: "Paste this text?", detail: `${risk}\n\n${preview(text)}`, confirm: "Paste" }))) return;
    t.paste(text);
    t.focus();
  }

  /**
   * Scroll so the previous (-1) or next (1) prompt is at the top. Starts from
   * the prompt being typed at when at the bottom, else from the last jump while
   * the view stays there, else from the top of the view.
   */
  jumpToPrompt(paneId: PaneId, dir: -1 | 1): void {
    const h = this.#hosts.get(paneId);
    if (!h) return;
    const t = h.term;
    const buf = t.buffer.active;
    if (buf.type !== "normal") return;
    h.prompts = h.prompts.filter((m) => !m.isDisposed);
    const lines = h.prompts.map((m) => m.line);
    const from =
      h.jump && h.jump.viewportY === buf.viewportY ? h.jump.line : buf.viewportY === buf.baseY && dir < 0 ? (lines.at(-1) ?? buf.viewportY) : buf.viewportY;
    const i = dir < 0 ? lines.findLastIndex((l) => l < from) : lines.findIndex((l) => l > from);
    if (i < 0) {
      if (dir > 0) t.scrollToBottom();
      h.jump = null;
      return;
    }
    t.scrollToLine(lines[i]!);
    h.jump = { line: lines[i]!, viewportY: buf.viewportY };
    this.#flash(h, h.prompts[i]!);
  }

  /** Select and copy the output of the last finished command (needs shell integration); false if there's none. */
  copyLastOutput(paneId: PaneId): boolean {
    const h = this.#hosts.get(paneId);
    if (!h || h.term.buffer.active.type !== "normal") return false;
    const buf = h.term.buffer.active;
    const o = h.outputs.findLast((o) => o.end && !o.end.isDisposed && !o.start.isDisposed);
    if (!o) return false;
    let end = o.end!.line - 1;
    while (end >= o.start.line && !buf.getLine(end)?.translateToString(true).trim()) end--;
    if (end < o.start.line) return false;
    h.term.selectLines(o.start.line, end);
    if (o.start.line < buf.viewportY || o.start.line >= buf.viewportY + h.term.rows) h.term.scrollToLine(o.start.line);
    cmd.writeClipboard(h.term.getSelection());
    return true;
  }

  // ── find (⌘F): the view shows the bar, these drive xterm's search addon ──
  #findListeners = new Map<PaneId, { request: (r: FindRequest) => void; results: (r: FindResults) => void }>();

  /** The view of this terminal handles find requests and shows results. */
  onFind(paneId: PaneId, l: { request: (r: FindRequest) => void; results: (r: FindResults) => void }): () => void {
    this.#findListeners.set(paneId, l);
    return () => this.#findListeners.get(paneId) === l && this.#findListeners.delete(paneId);
  }

  /** ⌘F / ⌘G / ⇧⌘G for this terminal; false if no view of it is showing. */
  requestFind(paneId: PaneId, r: FindRequest): boolean {
    const l = this.#findListeners.get(paneId);
    l?.request(r);
    return !!l;
  }

  find(paneId: PaneId, query: string, dir: 1 | -1, o: FindOptions & { incremental?: boolean }): void {
    const h = this.#hosts.get(paneId);
    if (!h) return;
    if (!query) {
      h.search.clearDecorations();
      h.term.clearSelection();
      this.#findListeners.get(paneId)?.results({ index: -1, count: 0 });
      return;
    }
    const key = `${o.caseSensitive} ${o.regex} ${o.wholeWord}`;
    if (key !== h.findOptions) h.search.clearDecorations(), (h.findOptions = key);
    try {
      const opts = { ...searchOptions({ caseSensitive: o.caseSensitive, regex: o.regex, wholeWord: o.wholeWord }), incremental: o.incremental };
      if (dir > 0) h.search.findNext(query, opts);
      else h.search.findPrevious(query, opts);
    } catch {
      // An incomplete regex while typing.
      this.#findListeners.get(paneId)?.results({ index: -1, count: 0 });
    }
  }

  endFind(paneId: PaneId): void {
    const h = this.#hosts.get(paneId);
    h?.search.clearDecorations();
  }

  /** The selection if it's on one line (to search for), else "". */
  selectionText(paneId: PaneId): string {
    const sel = this.#hosts.get(paneId)?.term.getSelection() ?? "";
    return sel.includes("\n") ? "" : sel;
  }

  hasSelection(paneId: PaneId): boolean {
    return !!this.#hosts.get(paneId)?.term.hasSelection();
  }

  /** Write live output. */
  write(paneId: PaneId, data: string): void {
    this.get(paneId).term.write(data);
  }

  /**
   * Write a snapshot made at `size`: the terminal takes that size first (a fresh one is
   * 80x24, and a wider screen replayed into it wraps and puts its cursor moves on the
   * wrong cells). That is the PTY's size already, so it isn't resized. No fits until it
   * is parsed (@cmd/protocol/replay says why); then the real size.
   */
  replay(paneId: PaneId, data: string, size: { cols: number; rows: number }): void {
    const h = this.get(paneId);
    h.replays.replay(data, size, () => this.#hosts.get(paneId) === h && this.fit(paneId));
  }

  reset(paneId: PaneId): void {
    const h = this.get(paneId);
    h.term.reset();
    for (const m of [...h.prompts, ...h.outputs.flatMap((o) => [o.start, o.end])]) m?.dispose();
    h.prompts = [];
    h.outputs = [];
    h.jump = null;
  }

  dispose(paneId: PaneId): void {
    const h = this.#hosts.get(paneId);
    if (!h) return;
    if (h.fitTimer) clearTimeout(h.fitTimer);
    if (h.ptyTimer) clearTimeout(h.ptyTimer);
    // With mouse reporting on (Claude Code, vim), a mousedown adds mousemove/mouseup
    // listeners on the document that only a mouseup removes, and dispose doesn't.
    // Closing the pane mid-drag would leave them calling into the disposed renderer
    // ("reading 'dimensions'") on every later drag, so end the drag first.
    if (h.opened && h.term.modes.mouseTrackingMode !== "none") document.dispatchEvent(new MouseEvent("mouseup"));
    h.undrop();
    this.#dropWebgl(h);
    h.term.dispose();
    h.el.remove();
    this.#hosts.delete(paneId);
  }

  /** Draw this terminal with WebGL; with the pool full, in place of the least recently used one (`evict`), else not. */
  #ensureWebgl(h: Host, evict = true): void {
    const pool = this.#settings["terminal.webglPool"];
    if (h.webgl || pool <= 0 || this.#settings["terminal.renderer"] !== "webgl") return;
    if (!Webgl) {
      webglLoading ??= import("@xterm/addon-webgl").then((m) => void (Webgl = m.WebglAddon));
      // Once loaded, upgrade this terminal unless it was disposed meanwhile.
      void webglLoading.then(() => [...this.#hosts.values()].includes(h) && this.#ensureWebgl(h, evict));
      return;
    }
    const live = [...this.#hosts.values()].filter((x) => x.webgl);
    if (live.length >= pool) {
      if (!evict) return;
      // Evict the least recently used terminal back to the DOM renderer.
      this.#dropWebgl(live.sort((a, b) => a.lastUsed - b.lastUsed)[0]!);
    }
    try {
      const addon = new Webgl();
      addon.onContextLoss(() => h.webgl === addon && this.#dropWebgl(h));
      h.term.loadAddon(addon);
      h.webgl = addon;
    } catch {
      h.webgl = null;
    }
  }

  /** Back to the DOM renderer, releasing the GL context: the addon's dispose removes its canvas
   *  but the context lives on until GC, and Chromium counts it towards its limit. */
  #dropWebgl(h: Host): void {
    const addon = h.webgl;
    if (!addon) return;
    h.webgl = null;
    const canvases = [...h.el.querySelectorAll("canvas")];
    addon.dispose();
    for (const c of canvases) {
      if (c.isConnected) continue; // another addon's (images)
      try {
        c.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {}
    }
  }

  applyTheme(): void {
    for (const h of this.#hosts.values()) {
      h.term.options.theme = theme();
      if (h.schemeUpdates) this.#reply(h, schemeReport());
    }
  }

  #reply(h: Host, data: string): void {
    void cmd.call("pane.write", { paneId: h.paneId, data }).catch(() => {});
  }

  /**
   * Sequences xterm.js leaves to the embedder. Handlers that return false let
   * xterm handle the sequence too.
   */
  #protocol(h: Host): void {
    const p = h.term.parser;
    this.#quietDA(h);
    // OSC 133 shell integration: A prompt start, C command output starts, D it ended.
    p.registerOscHandler(133, (data) => {
      const kind = data[0];
      if (kind === "A") {
        const m = h.term.registerMarker(0);
        if (m) h.prompts.push(m);
        if (h.prompts.length > MAX_MARKS) h.prompts.shift()!.dispose();
      } else if (kind === "C") {
        const m = h.term.registerMarker(0);
        if (m) h.outputs.push({ start: m, end: null });
        if (h.outputs.length > MAX_MARKS) {
          const o = h.outputs.shift()!;
          o.start.dispose(), o.end?.dispose();
        }
      } else if (kind === "D") {
        const o = h.outputs.at(-1);
        if (o && !o.end) o.end = h.term.registerMarker(0) ?? null;
      }
      return false;
    });
    // OSC 52: a program copies (base64). Queries (reading the clipboard) get no answer.
    p.registerOscHandler(52, (data) => {
      const semi = data.indexOf(";");
      const payload = semi < 0 ? "" : data.slice(semi + 1);
      if (!this.#settings["terminal.clipboardWrite"] || payload === "?" || payload.length > 8 << 20) return true;
      try {
        const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
        cmd.writeClipboard(new TextDecoder().decode(bytes));
      } catch {}
      return true;
    });
    // XTVERSION (CSI > q): name and version, the way programs tell terminals apart.
    p.registerCsiHandler({ prefix: ">", final: "q" }, (params) => {
      if (!params[0]) this.#reply(h, `\x1bP>|cmd ${version}\x1b\\`);
      return true;
    });
    // Color scheme: CSI ? 996 n asks dark or light; mode 2031 subscribes to changes (Neovim, Helix).
    p.registerCsiHandler({ prefix: "?", final: "n" }, (params) => {
      if (params[0] !== 996) return false;
      this.#reply(h, schemeReport());
      return true;
    });
    const mode2031 = (on: boolean) => (params: (number | number[])[]) => {
      if (params.includes(2031)) h.schemeUpdates = on;
      return false;
    };
    p.registerCsiHandler({ prefix: "?", final: "h" }, mode2031(true));
    p.registerCsiHandler({ prefix: "?", final: "l" }, mode2031(false));
    p.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, (params) => {
      if (params[0] !== 2031) return false;
      this.#reply(h, `\x1b[?2031;${h.schemeUpdates ? 1 : 2}$y`);
      return true;
    });
  }

  /** Mouse and drag-and-drop on the terminal's element. */
  #dom(h: Host): void {
    const { el, term, paneId } = h;
    // Click to move the cursor at a prompt: a plain click (no drag, no selection)
    // in an already focused terminal, on the command line being typed.
    let down: { x: number; y: number; focused: boolean } | null = null;
    el.addEventListener("mousedown", (e) => {
      down = e.button === 0 && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey ? { x: e.clientX, y: e.clientY, focused: el.contains(document.activeElement) } : null;
    });
    el.addEventListener("mouseup", (e) => {
      const d = down;
      down = null;
      if (!d?.focused || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 3 || e.detail > 1 || !this.#settings["terminal.clickMovesCursor"]) return;
      setTimeout(() => this.#moveCursorTo(h, e.clientX, e.clientY));
    });
    // Hide the pointer while typing; it comes back when the mouse moves.
    el.addEventListener("keydown", () => this.#settings["terminal.hideMouseWhileTyping"] && el.classList.add("typing"), true);
    el.addEventListener("mousemove", () => el.classList.remove("typing"));
    // Copy on select: when the mouse lets go (not on every step of a drag).
    el.addEventListener("mouseup", () => {
      if (this.#settings["terminal.copyOnSelect"] && term.hasSelection()) setTimeout(() => cmd.writeClipboard(term.getSelection()));
    });
    // ⌘V and Edit › Paste reach xterm as a paste event: check it first.
    el.addEventListener(
      "paste",
      (e) => {
        const text = e.clipboardData?.getData("text/plain") ?? "";
        if (!this.#settings["terminal.pasteProtection"] || !pasteRisk(text, term.modes.bracketedPasteMode)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        void this.paste(paneId, text);
      },
      true,
    );
    // Files dropped (from Finder, the file browser, a title icon) type their paths
    // as shell words, as Terminal.app does, so agents attach them; ⌘ types `cd` and
    // the path, to press Return on. Links and text type themselves. Router: drops.ts.
    h.undrop = registerDropTarget(paneId, {
      over: (d) => (d.files || d.urls || d.text ? "copy" : null),
      drop: (items, d) => {
        const words = items.files.map(shellWord);
        const text = !words.length ? items.urls.join(" ") || items.text : d.meta && words.length === 1 ? `cd ${words[0]}` : words.join(" ") + " ";
        void this.paste(paneId, text);
      },
    });
  }

  /**
   * Send the arrow keys that take the shell's cursor to the clicked cell, when
   * the shell is at its prompt (a prompt mark with no command started after it)
   * and the click is on the command line, between that prompt and the cursor's
   * line or the lines it wraps onto.
   */
  #moveCursorTo(h: Host, clientX: number, clientY: number): void {
    const t = h.term;
    const buf = t.buffer.active;
    if (t.hasSelection() || buf.type !== "normal" || t.modes.mouseTrackingMode !== "none") return;
    const prompt = h.prompts.findLast((m) => !m.isDisposed);
    const output = h.outputs.at(-1);
    if (!prompt || (output && !output.start.isDisposed && output.start.line >= prompt.line)) return;
    const screen = h.el.querySelector(".xterm-screen")?.getBoundingClientRect();
    if (!screen?.width) return;
    const col = Math.max(0, Math.min(t.cols - 1, Math.floor(((clientX - screen.left) / screen.width) * t.cols)));
    const line = buf.viewportY + Math.floor(((clientY - screen.top) / screen.height) * t.rows);
    const cursorLine = buf.baseY + buf.cursorY;
    let last = cursorLine;
    while (buf.getLine(last + 1)?.isWrapped) last++;
    if (line < prompt.line || line > last) return;
    const delta = (line - cursorLine) * t.cols + (col - buf.cursorX);
    if (!delta || Math.abs(delta) > 2000) return;
    const key = t.modes.applicationCursorKeysMode ? (delta > 0 ? "\x1bOC" : "\x1bOD") : delta > 0 ? "\x1b[C" : "\x1b[D";
    this.#reply(h, key.repeat(Math.abs(delta)));
  }

  #setImages(h: Host, on: boolean): void {
    if (!on) {
      h.images?.dispose();
      h.images = null;
      return;
    }
    imageAddon ??= import("@xterm/addon-image").then((m) => m.ImageAddon);
    void imageAddon.then((Image) => {
      if (h.images || !this.#settings["terminal.images"] || this.#hosts.get(h.paneId) !== h) return;
      h.images = new Image({ sixelSupport: true, iipSupport: true, storageLimit: 64 });
      h.term.loadAddon(h.images);
      this.#quietDA(h); // the addon answers DA1 itself; ours must come after it
    });
  }

  /**
   * The core answers device attribute queries (CSI c, CSI > c: core/osc.ts), also
   * while no window shows the terminal; xterm answering too would send two replies.
   * The newest handler runs first, so this is registered again after other addons.
   */
  #quietDA(h: Host): void {
    h.quietDA?.dispose();
    const p = h.term.parser;
    const plain = (params: (number | number[])[]) => !params[0];
    const a = p.registerCsiHandler({ final: "c" }, plain);
    const b = p.registerCsiHandler({ prefix: ">", final: "c" }, plain);
    h.quietDA = { dispose: () => (a.dispose(), b.dispose()) };
  }

  /** Briefly highlight the line a jump landed on. */
  #flash(h: Host, marker: IMarker): void {
    const d = h.term.registerDecoration({ marker, width: h.term.cols, layer: "top" });
    if (!d) return;
    let sub: IDisposable | null = d.onRender((e) => {
      e.classList.add("prompt-flash");
      sub?.dispose();
      sub = null;
    });
    setTimeout(() => d.dispose(), 700);
  }
}

/** CSI ? 997 ; 1|2 n: the color scheme is dark (1) or light (2). */
const schemeReport = () => `\x1b[?997;${currentTheme().appearance === "light" ? 2 : 1}n`;

let imageAddon: Promise<typeof ImageAddon> | null = null;

export const terminals = new Terminals();
onThemeChange(() => terminals.applyTheme());
