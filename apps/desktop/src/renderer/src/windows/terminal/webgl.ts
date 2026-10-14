// Which terminals draw with WebGL (terminals.ts): a pool of contexts (browsers keep ~16
// a page) for those most recently shown, the rest with xterm's DOM renderer. A terminal
// gets its context a frame after it's shown, one a frame (see queue). The addon loads
// only when the webgl renderer is used, so it stays out of the startup bundle.

import type { Terminal } from "@xterm/xterm";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { Settings } from "@cmd/protocol";

/** What the pool needs of a terminal. */
export interface GlHost {
  term: Terminal;
  el: HTMLElement;
  webgl: WebglAddon | null;
  lastUsed: number;
}

let Webgl: typeof WebglAddon | null = null;
let webglLoading: Promise<void> | null = null;

export class WebglPool {
  /** Terminals waiting for their context (queue). */
  #queue = new Set<GlHost>();
  #raf = 0;
  #o: { hosts: () => Iterable<GlHost>; settings: () => Settings };

  constructor(o: { hosts: () => Iterable<GlHost>; settings: () => Settings }) {
    this.#o = o;
  }

  #alive(h: GlHost): boolean {
    return [...this.#o.hosts()].includes(h);
  }

  /**
   * WebGL for a terminal just shown, from the next frame on, one a frame (the focused one
   * first), drawn by the DOM renderer meanwhile. Making a context waits for the GPU process
   * (its shaders' compile, the canvas's framebuffer): ~5 ms when it's idle, 30-90 ms while
   * other terminals stream output; showing a workspace attaches all its terminals in one
   * commit, inside the switch's view transition.
   */
  queue(h: GlHost): void {
    if (h.webgl) return;
    this.#queue.add(h);
    this.#raf ||= requestAnimationFrame(this.#next);
  }

  #next = (): void => {
    this.#raf = 0;
    const waiting = [...this.#queue].filter((h) => h.el.isConnected && this.#alive(h));
    this.#queue.clear();
    const next = waiting.find((h) => h.el.contains(document.activeElement)) ?? waiting[0];
    if (!next) return;
    this.ensure(next);
    for (const h of waiting) if (h !== next) this.#queue.add(h);
    if (this.#queue.size) this.#raf = requestAnimationFrame(this.#next);
  };

  /** Draw this terminal with WebGL; with the pool full, in place of the least recently used one (`evict`), else not. */
  ensure(h: GlHost, evict = true): void {
    const pool = this.#o.settings()["terminal.webglPool"];
    if (h.webgl || pool <= 0 || this.#o.settings()["terminal.renderer"] !== "webgl") return;
    if (!Webgl) {
      webglLoading ??= import("@xterm/addon-webgl").then((m) => void (Webgl = m.WebglAddon));
      // Once loaded, upgrade this terminal unless it was disposed meanwhile.
      void webglLoading.then(() => this.#alive(h) && this.ensure(h, evict));
      return;
    }
    const live = [...this.#o.hosts()].filter((x) => x.webgl);
    if (live.length >= pool) {
      if (!evict) return;
      // Evict the least recently used terminal back to the DOM renderer.
      this.drop(live.sort((a, b) => a.lastUsed - b.lastUsed)[0]!);
    }
    try {
      const addon = new Webgl();
      addon.onContextLoss(() => h.webgl === addon && this.drop(h));
      h.term.loadAddon(addon);
      h.webgl = addon;
    } catch {
      h.webgl = null;
    }
  }

  /** Back to the DOM renderer, releasing the GL context: the addon's dispose removes its canvas
   *  but the context lives on until GC, and Chromium counts it towards its limit. */
  drop(h: GlHost): void {
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
}
