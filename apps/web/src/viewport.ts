// The phone's window onto a Mac terminal (zoom.ts has the numbers): the xterm drawn at
// the Mac's grid, zoomed by its font size and panned under the screen by a transform.
// Touch is all handled here, not by xterm: one finger pans (with momentum), two pinch
// (drawn as a scale while the fingers move, then redrawn at the new font), a double-tap
// toggles the whole width and the readable size, a tap on a web address asks to open
// it, and a long-press selects (dragging on extends it). In "fit" mode the font is the
// text size and the terminal takes the screen's size (Terminal.tsx tells the Mac).
// A trackpad or mouse wheel pans too, with ctrl (a trackpad pinch) zooming.

import type { Terminal } from "@xterm/xterm";
import { anchors, clamp, clampView, doubleTap, fitSize, maxV, offsetOf, pinchEnd, pinchTransform, place, translateOf, zoomAt, zoomRange, type Extents, type Point, type Ratio, type View } from "./zoom.ts";
import { linkAt, wordAt } from "./keys.ts";

export interface ViewportState {
  /** The latest line is in view. */
  atBottom: boolean;
  /** Output arrived while it wasn't. */
  unread: boolean;
  /** Something is selected (the copy bar shows). */
  selection: boolean;
  /** The terminal is wider than the screen at the readable size: it pans sideways. */
  pans: boolean;
  font: number;
}

export interface ViewportOptions {
  view: HTMLElement;
  pan: HTMLElement;
  term: Terminal;
  pref: number;
  onState: (s: ViewportState) => void;
  onLink: (url: string) => void;
  /** Fit mode: the size that fills the screen at the text size. */
  onFit: (size: { cols: number; rows: number }) => void;
}

const TAP_MS = 300;
const TAP_SLOP = 10;
const DOUBLE_SLOP = 30;
const LONG_PRESS_MS = 450;

export class Viewport {
  #o: ViewportOptions;
  #mode: "scaled" | "fit" = "scaled";
  #pref: number;
  /** Which zoom it keeps as the screen changes; null after a pinch (the font stays). */
  #anchor: "readable" | "overview" | null = "readable";
  #view: View = { font: 0, x: 0, v: 0 };
  #ratio: Ratio = { w: 0.6, h: 1.2 };
  #measured = false;
  #shift = 0;
  #ours = false;
  #state: ViewportState = { atBottom: true, unread: false, selection: false, pans: false, font: 0 };
  #lastBase = 0;
  #lastCursor = -1;
  #frame = 0;
  #off: (() => void)[] = [];
  #replaying = false;
  /** Up in the history when a replay began: the line on top and how far it was from the bottom, to find it again. */
  #held: { text: string; fromBottom: number } | null = null;

  /** A snapshot is being written: what changes isn't news, and the view holds still until it's parsed. */
  get replaying(): boolean {
    return this.#replaying;
  }

  set replaying(on: boolean) {
    if (on === this.#replaying) return;
    this.#replaying = on;
    const b = this.#o.term.buffer.active;
    if (on) {
      this.#held = b.viewportY < b.baseY ? { text: b.getLine(b.viewportY)?.translateToString(true) ?? "", fromBottom: b.baseY - b.viewportY } : null;
      return;
    }
    // Parsed: the same line on top again, if it's still there (lines arrived meanwhile, or the Mac keeps less history).
    const a = this.#held;
    this.#held = null;
    if (!a || !a.text) return;
    const guess = b.baseY - a.fromBottom;
    for (let d = 0; d <= 500; d++)
      for (const i of [guess + d, guess - d])
        if (i >= 0 && i < b.baseY && b.getLine(i)?.translateToString(true) === a.text) {
          this.#view.v = offsetOf(this.#shift, i, this.#extents());
          return;
        }
  }

  constructor(o: ViewportOptions) {
    this.#o = o;
    this.#pref = o.pref;
    this.#view.font = o.term.options.fontSize ?? o.pref;
    const t = o.term;
    const d1 = t.onWriteParsed(() => this.#written());
    const d2 = t.onScroll(() => !this.#ours && this.#scrolled());
    const d3 = t.onSelectionChange(() => this.#emit({ selection: t.hasSelection() }));
    this.#off.push(
      () => (d1.dispose(), d2.dispose(), d3.dispose()),
      this.#touch(),
      this.#wheel(),
    );
    const ro = new ResizeObserver(() => !this.replaying && this.layout());
    ro.observe(o.view);
    ro.observe(o.pan);
    this.#off.push(() => ro.disconnect());
    void document.fonts?.ready.then(() => ((this.#measured = false), this.layout()));
  }

  get mode() {
    return this.#mode;
  }

  setMode(mode: "scaled" | "fit"): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#anchor = "readable";
    this.#view = { ...this.#view, x: 0, v: 0 };
    this.layout();
  }

  setPref(font: number): void {
    this.#pref = font;
    this.#anchor = "readable";
    this.layout();
  }

  /** Back to the latest line. */
  toBottom(): void {
    this.#stopFling();
    this.#view.v = 0;
    this.#apply();
  }

  clearSelection(): void {
    this.#o.term.clearSelection();
  }

  dispose(): void {
    this.#stopFling();
    cancelAnimationFrame(this.#frame);
    this.#off.forEach((f) => f());
  }

  // ── measuring and drawing ──

  #screen(): HTMLElement | null {
    return this.#o.term.element?.querySelector<HTMLElement>(".xterm-screen") ?? null;
  }

  /** A cell's size per pixel of font, as xterm drew it at the font it has now. */
  #measure(): void {
    const s = this.#screen();
    const t = this.#o.term;
    const f = t.options.fontSize ?? 0;
    if (!s || !s.offsetWidth || !f) return;
    this.#ratio = { w: s.offsetWidth / (t.cols * f), h: s.offsetHeight / (t.rows * f) };
    this.#measured = true;
  }

  #padding(): { x: number; y: number } {
    const cs = getComputedStyle(this.#o.pan);
    return { x: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), y: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) };
  }

  #extents(): Extents {
    const { view, pan, term } = this.#o;
    const s = this.#screen();
    return {
      contentW: pan.offsetWidth,
      contentH: pan.offsetHeight,
      viewW: view.clientWidth,
      viewH: view.clientHeight,
      cellH: s && term.rows ? s.offsetHeight / term.rows : this.#ratio.h * this.#view.font,
      base: term.buffer.active.baseY,
    };
  }

  #anchors() {
    const pad = this.#padding();
    return anchors(this.#o.term.cols, this.#o.view.clientWidth - pad.x, this.#ratio, this.#pref);
  }

  /** The screen, the pane or the text size changed: pick the font again (and, fitting, the size). */
  layout(): void {
    const { view } = this.#o;
    if (!view.clientWidth || !view.clientHeight) return;
    if (!this.#measured) this.#measure();
    if (this.#mode === "fit") {
      this.#setFont(this.#pref);
      const pad = this.#padding();
      this.#o.onFit(fitSize(view.clientWidth - pad.x, view.clientHeight - pad.y, this.#ratio, this.#pref));
    } else {
      const a = this.#anchors();
      const [lo, hi] = zoomRange(a);
      this.#setFont(this.#anchor ? a[this.#anchor] : clamp(this.#view.font, lo, hi));
    }
    this.#apply();
  }

  #setFont(font: number): void {
    // Half pixels: close enough to fill the width, and fewer redraws.
    const f = Math.max(1, Math.round(font * 2) / 2);
    this.#view.font = f;
    const t = this.#o.term;
    if (t.options.fontSize !== f) {
      t.options.fontSize = f;
      this.#measure();
    }
  }

  /** The view onto the terminal as it stands: the pan and scrollback place, drawn. */
  #apply(): void {
    const t = this.#o.term;
    const e = this.#extents();
    this.#view = clampView(this.#view, e);
    const { shift, line } = place(this.#view.v, e);
    this.#shift = shift;
    if (t.buffer.active.viewportY !== line) {
      this.#ours = true;
      t.scrollToLine(line);
      this.#ours = false;
    }
    const tr = translateOf(this.#view.x, shift, e);
    this.#o.pan.style.transform = `translate3d(${tr.x}px, ${tr.y}px, 0)`;
    const atBottom = this.#view.v < 1;
    this.#emit({ atBottom, unread: atBottom ? false : this.#state.unread, font: this.#view.font, pans: this.#mode === "scaled" && this.#anchors().pans });
  }

  #emit(p: Partial<ViewportState>): void {
    const next = { ...this.#state, ...p };
    const changed = (Object.keys(next) as (keyof ViewportState)[]).some((k) => next[k] !== this.#state[k]);
    this.#state = next;
    if (changed) this.#o.onState(next);
  }

  /** Output was parsed: a view up in the history stays on what it shows (xterm holds it), and it's news. */
  #written(): void {
    // A replay rebuilds the buffer from nothing: the view keeps its place from the bottom until it's parsed (layout).
    if (this.replaying) return;
    const b = this.#o.term.buffer.active;
    const moved = b.baseY !== this.#lastBase || b.baseY + b.cursorY !== this.#lastCursor;
    this.#lastBase = b.baseY;
    this.#lastCursor = b.baseY + b.cursorY;
    if (this.#view.v >= 1) {
      this.#view.v = offsetOf(this.#shift, b.viewportY, this.#extents());
      if (moved && !this.replaying) this.#emit({ unread: true });
    }
    this.#apply();
  }

  /** xterm scrolled by itself (a reset, a clear): follow it. */
  #scrolled(): void {
    if (this.replaying) return;
    const b = this.#o.term.buffer.active;
    this.#view.v = offsetOf(this.#shift, b.viewportY, this.#extents());
    this.#apply();
  }

  /** Buffer cell under a point on the screen. */
  #cellAt(clientX: number, clientY: number): { col: number; row: number } | null {
    const s = this.#screen();
    const t = this.#o.term;
    if (!s) return null;
    const r = s.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const col = clamp(Math.floor(((clientX - r.left) / r.width) * t.cols), 0, t.cols - 1);
    const y = Math.floor(((clientY - r.top) / r.height) * t.rows);
    if (y < 0 || y >= t.rows) return null;
    return { col, row: t.buffer.active.viewportY + y };
  }

  /** A line with the lines it wraps onto, and where `row` starts in it. */
  #logical(row: number): { text: string; offset: number } {
    const b = this.#o.term.buffer.active;
    let start = row;
    while (start > 0 && b.getLine(start)?.isWrapped) start--;
    let text = "";
    for (let i = start; ; i++) {
      const l = b.getLine(i);
      if (!l || (i > start && !l.isWrapped)) break;
      text += l.translateToString(false);
    }
    return { text, offset: (row - start) * this.#o.term.cols };
  }

  // ── touch ──

  #fling: { vx: number; vy: number; at: number } | null = null;
  #flingFrame = 0;

  #stopFling(): void {
    cancelAnimationFrame(this.#flingFrame);
    this.#fling = null;
  }

  #startFling(vx: number, vy: number): void {
    if (Math.hypot(vx, vy) < 0.15) return;
    this.#fling = { vx, vy, at: performance.now() };
    const step = (now: number) => {
      const f = this.#fling;
      if (!f) return;
      const dt = Math.min(34, now - f.at);
      f.at = now;
      this.#view.x -= f.vx * dt;
      this.#view.v += f.vy * dt;
      const decay = Math.pow(0.95, dt / 16);
      f.vx *= decay;
      f.vy *= decay;
      const before = { ...this.#view };
      this.#apply();
      const stuck = before.x !== this.#view.x && before.v !== this.#view.v;
      if (stuck || Math.hypot(f.vx, f.vy) < 0.02) return this.#stopFling();
      this.#flingFrame = requestAnimationFrame(step);
    };
    this.#flingFrame = requestAnimationFrame(step);
  }

  #touch(): () => void {
    const { view, pan, term } = this.#o;
    type Pinch = { f0: number; d0: number; p0: Point; p1: Point; s: number; t0: Point; e0: Extents; lines: number };
    let one: { id: number; start: Point; last: Point; at: number; moved: boolean; samples: { x: number; y: number; t: number }[] } | null = null;
    let pinch: Pinch | null = null;
    let press: ReturnType<typeof setTimeout> | null = null;
    let select: { col: number; row: number } | null = null;
    let lastTap: { p: Point; at: number } | null = null;
    const cancelPress = () => (press && clearTimeout(press), (press = null));
    const mid = (a: Touch, b: Touch): Point => {
      const r = view.getBoundingClientRect();
      return { x: (a.clientX + b.clientX) / 2 - r.left, y: (a.clientY + b.clientY) / 2 - r.top };
    };
    const local = (x: number, y: number): Point => {
      const r = view.getBoundingClientRect();
      return { x: x - r.left, y: y - r.top };
    };
    const extend = (x: number, y: number) => {
      const c = this.#cellAt(x, y);
      if (!select || !c) return;
      const a = select.row * term.cols + select.col;
      const b = c.row * term.cols + c.col;
      const from = Math.min(a, b);
      term.select(from % term.cols, Math.floor(from / term.cols), Math.abs(b - a) + 1);
    };
    const beginOne = (t: Touch) => {
      const p = { x: t.clientX, y: t.clientY };
      one = { id: t.identifier, start: p, last: p, at: performance.now(), moved: false, samples: [{ ...p, t: performance.now() }] };
      cancelPress();
      press = setTimeout(() => {
        press = null;
        if (!one || one.moved) return;
        // Long-press: select the word under the finger; dragging on extends it.
        const c = this.#cellAt(one.start.x, one.start.y);
        if (!c) return;
        const { text, offset } = this.#logical(c.row);
        const w = wordAt(text, offset + c.col);
        select = c;
        if (w) {
          const start = c.row * term.cols - offset + w[0];
          select = { col: start % term.cols, row: Math.floor(start / term.cols) };
          term.select(select.col, select.row, w[1] - w[0]);
        } else term.select(c.col, c.row, 1);
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    };
    const start = (e: TouchEvent) => {
      e.stopPropagation();
      this.#stopFling();
      if (e.touches.length === 1) {
        beginOne(e.touches[0]!);
      } else if (e.touches.length === 2 && this.#mode === "scaled") {
        cancelPress();
        one = null;
        select = null;
        const [a, b] = [e.touches[0]!, e.touches[1]!];
        const ext = this.#extents();
        const p0 = mid(a, b);
        pinch = {
          f0: this.#view.font,
          d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
          p0,
          p1: p0,
          s: 1,
          t0: translateOf(this.#view.x, this.#shift, ext),
          e0: ext,
          lines: ext.base - term.buffer.active.viewportY,
        };
        pan.style.transformOrigin = "0 0";
      }
      e.preventDefault();
    };
    const move = (e: TouchEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (pinch && e.touches.length >= 2) {
        const [a, b] = [e.touches[0]!, e.touches[1]!];
        const [lo, hi] = zoomRange(this.#anchors());
        pinch.s = clamp(Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d0, lo / pinch.f0, hi / pinch.f0);
        pinch.p1 = mid(a, b);
        const tr = pinchTransform(pinch.t0, pinch.p0, pinch.p1, pinch.s);
        pan.style.transform = `translate3d(${tr.x}px, ${tr.y}px, 0) scale(${tr.s})`;
        return;
      }
      const t = one && [...e.touches].find((x) => x.identifier === one!.id);
      if (!one || !t) return;
      const p = { x: t.clientX, y: t.clientY };
      if (!one.moved && Math.hypot(p.x - one.start.x, p.y - one.start.y) > TAP_SLOP) {
        one.moved = true;
        if (!select) cancelPress();
      }
      if (select) return extend(p.x, p.y);
      if (!one.moved) return;
      this.#view.x -= p.x - one.last.x;
      this.#view.v += p.y - one.last.y;
      one.last = p;
      const now = performance.now();
      one.samples.push({ ...p, t: now });
      while (one.samples.length > 2 && now - one.samples[0]!.t > 100) one.samples.shift();
      cancelAnimationFrame(this.#frame);
      this.#frame = requestAnimationFrame(() => this.#apply());
    };
    const end = (e: TouchEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (pinch && e.touches.length < 2) {
        const p = pinch;
        pinch = null;
        this.#anchor = null;
        this.#view = pinchEnd(p.f0, p.s, zoomRange(this.#anchors()), p.t0, p.p0, p.p1, p.e0, p.lines);
        this.#setFont(this.#view.font);
        this.#apply();
        // One finger still down: it pans from here.
        if (e.touches.length === 1) {
          beginOne(e.touches[0]!);
          one!.moved = true;
        }
        return;
      }
      cancelPress();
      const o = one;
      one = null;
      if (!o || e.touches.length) return;
      if (select) {
        select = null;
        return;
      }
      if (o.moved) {
        const s = o.samples;
        const first = s[0]!;
        const last = s[s.length - 1]!;
        const dt = last.t - first.t;
        if (dt > 0 && performance.now() - last.t < 80) this.#startFling((last.x - first.x) / dt, (last.y - first.y) / dt);
        return;
      }
      if (performance.now() - o.at > TAP_MS) return;
      // A tap: clears a selection, opens a link, or (twice) zooms.
      if (term.hasSelection()) return term.clearSelection();
      const c = this.#cellAt(o.start.x, o.start.y);
      if (c) {
        const { text, offset } = this.#logical(c.row);
        const url = linkAt(text, offset + c.col);
        if (url) return this.#o.onLink(url);
      }
      const now = performance.now();
      const p = local(o.start.x, o.start.y);
      if (lastTap && now - lastTap.at < TAP_MS && Math.hypot(p.x - lastTap.p.x, p.y - lastTap.p.y) < DOUBLE_SLOP) {
        lastTap = null;
        this.#zoomTo(p, doubleTap(this.#view.font, this.#anchors()));
      } else lastTap = { p, at: now };
    };
    // iOS zooms the whole page on a pinch unless its gesture events are turned down too.
    const gesture = (e: Event) => e.preventDefault();
    const opts = { capture: true, passive: false } as const;
    view.addEventListener("touchstart", start, opts);
    view.addEventListener("touchmove", move, opts);
    view.addEventListener("touchend", end, opts);
    view.addEventListener("touchcancel", end, opts);
    view.addEventListener("gesturestart", gesture, opts);
    return () => {
      cancelPress();
      view.removeEventListener("touchstart", start, opts);
      view.removeEventListener("touchmove", move, opts);
      view.removeEventListener("touchend", end, opts);
      view.removeEventListener("touchcancel", end, opts);
      view.removeEventListener("gesturestart", gesture, opts);
    };
  }

  /** Zoom to `font` keeping what's under `p` there (double-tap, ctrl-wheel), and remember which zoom it is. */
  #zoomTo(p: Point, font: number): void {
    if (this.#mode !== "scaled") return;
    const a = this.#anchors();
    const e = this.#extents();
    const [lo, hi] = zoomRange(a);
    const f = clamp(font, lo, hi);
    this.#anchor = Math.abs(f - a.readable) < 0.5 ? "readable" : Math.abs(f - a.overview) < 0.5 ? "overview" : null;
    this.#view = zoomAt(this.#view, f, p, e, e.base - this.#o.term.buffer.active.viewportY);
    this.#setFont(this.#view.font);
    this.#apply();
  }

  #wheel(): () => void {
    const { view } = this.#o;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.#stopFling();
      const k = e.deltaMode === 1 ? this.#extents().cellH : 1;
      if (e.ctrlKey) {
        const r = view.getBoundingClientRect();
        return this.#zoomTo({ x: e.clientX - r.left, y: e.clientY - r.top }, this.#view.font * Math.exp(-e.deltaY * 0.01));
      }
      this.#view.x += e.deltaX * k;
      this.#view.v = clamp(this.#view.v - e.deltaY * k, 0, maxV(this.#extents()));
      this.#apply();
    };
    const opts = { capture: true, passive: false } as const;
    view.addEventListener("wheel", wheel, opts);
    return () => view.removeEventListener("wheel", wheel, opts);
  }
}
