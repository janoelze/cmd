// One xterm.js instance per pane, kept alive while the pane exists so switching
// views never loses state. Views borrow the instance's element.
// WebGL contexts are pooled (browsers keep ~16); others use the DOM renderer.
// See docs/02-terminal-foundations.md.

import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { PaneId, Settings } from "@cmd/protocol";
import { DEFAULT_SETTINGS } from "@cmd/protocol";
import { cmd } from "./bridge.ts";


interface Host {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  opened: boolean;
  webgl: WebglAddon | null;
  lastUsed: number;
}

const dark: ITheme = {
  background: "#161618",
  foreground: "#e6e6ea",
  cursor: "#9d9dff",
  selectionBackground: "#3a3a6e",
  black: "#16161c", red: "#ff6b5e", green: "#7bd88f", yellow: "#ffd866",
  blue: "#8f8fff", magenta: "#e08cff", cyan: "#6fe0e8", white: "#d6d6dc",
  brightBlack: "#6c6c78", brightRed: "#ff8a7f", brightGreen: "#9be6aa", brightYellow: "#ffe38f",
  brightBlue: "#b0b0ff", brightMagenta: "#eeb0ff", brightCyan: "#9aeef3", brightWhite: "#ffffff",
};

const theme = () => dark;

// The WebGL addon loads only when the webgl renderer is used (not the default),
// so it stays out of the startup bundle.
let Webgl: typeof WebglAddon | null = null;
let webglLoading: Promise<void> | null = null;

class Terminals {
  #hosts = new Map<PaneId, Host>();
  #settings: Settings = DEFAULT_SETTINGS;
  /** ⌘+/⌘- offset on top of terminal.fontSize (persisted by the app). */
  #zoom = 0;

  /** Font size offset on top of terminal.fontSize (⌘+ / ⌘-). */
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
      if (fontChanged || s["terminal.fontFamily"] !== prev["terminal.fontFamily"] || s["terminal.fontSize"] !== prev["terminal.fontSize"]) {
        h.webgl?.clearTextureAtlas();
      }
      this.fit(id);
    }
  }

  #options() {
    const s = this.#settings;
    return {
      fontFamily: s["terminal.fontFamily"],
      fontSize: Math.max(6, s["terminal.fontSize"] + this.#zoom),
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
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.onData((data) => void cmd.call("pane.write", { paneId, data }));
    term.onResize(({ cols, rows }) => void cmd.call("pane.resize", { paneId, cols, rows }));
    // ⌘-shortcuts are menu key equivalents (main process); keep them out of the PTY.
    term.attachCustomKeyEventHandler((e) => !e.metaKey);
    const el = document.createElement("div");
    el.className = "xterm-host";
    // Mark terminals that have scrollback, so the scrollbar only shows when there's
    // something to scroll to (full-screen apps like Claude Code draw in place: none).
    const scrollable = () => el.classList.toggle("scrollable", term.buffer.active.baseY > 0);
    term.onWriteParsed(scrollable);
    term.buffer.onBufferChange(scrollable);
    term.onResize(scrollable);
    h = { term, fit, el, opened: false, webgl: null, lastUsed: Date.now() };
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
    try {
      h.fit.fit();
    } catch {}
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

  write(paneId: PaneId, data: string): void {
    this.get(paneId).term.write(data);
  }

  reset(paneId: PaneId): void {
    this.get(paneId).term.reset();
  }

  dispose(paneId: PaneId): void {
    const h = this.#hosts.get(paneId);
    if (!h) return;
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
