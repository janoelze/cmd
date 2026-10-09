// Window motion (docs/37-motion.md). One curve for everything that moves a
// window: a critically damped spring (no bounce), the same one the CSS token
// --glide samples. TileMotion owns every workspace window's geometry: React says
// where each window should be, and TileMotion glides position and size together,
// one frame at a time, from wherever the window is now (a move that's
// interrupted carries its velocity into the next). While a window glides, its
// content keeps one size, the larger of before and after, clipped by the
// window: a terminal is refit once, not every frame, and nothing reflows inside
// a moving window. Windows hidden by focus mode fade out where they are rather
// than jump to the focused window's rect.

/** Seconds for the spring to (nearly) get there. 0.26 s: quick, and calm at the end. */
const RESPONSE = 0.26;
const OMEGA = (2 * Math.PI) / RESPONSE;
/** ms until 99.9% of the way: CSS transitions on the same curve last this long (tokens.css --glide-dur). */
export const GLIDE_MS = Math.round((9.23 / OMEGA) * 1000);

/** The spring's offset from its target and velocity, t seconds after (x0, v0). */
function spring(x0: number, v0: number, t: number): [number, number] {
  const e = Math.exp(-OMEGA * t);
  const b = v0 + OMEGA * x0;
  return [(x0 + b * t) * e, (v0 - OMEGA * b * t) * e];
}

/** How far along (0…1) a glide is after `ms`: for tweens (scrolling, the canvas camera). */
export const glide = (ms: number): number => (ms >= GLIDE_MS ? 1 : 1 - spring(1, 0, ms / 1000)[0]);

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TileTarget {
  rect: Rect;
  /** Not shown in this mode (focus): fades out where it is and keeps its size. */
  hidden: boolean;
  /** Follows at once (dragged by the pointer). */
  instant?: boolean;
}

export interface UpdateOptions {
  /** Everything takes its place at once (live resize, drags that push others, boot). */
  instant: boolean;
  /** Showing or hiding is a swap, not a fade (another window in focus mode). */
  swap: boolean;
  /**
   * The windows' coordinates changed under them since the last update (a mode
   * switch moved the track, a sidebar moved the workspace on screen): where a
   * window at (x, y), scaled s, now has to be to stay where it was on screen. Each
   * window glides on from there, scaled back to 1 (a zoomed-out canvas's windows
   * shrink and grow with it, content and all).
   */
  remap?: (x: number, y: number, s: number) => { x: number; y: number; s: number };
}

const KEYS = ["x", "y", "w", "h", "s", "o"] as const;
type Key = (typeof KEYS)[number];
/** x, y: top-left; w, h: the size it shows at (its layout size times s); s: scale; o: opacity. */
type Geo = Record<Key, number>;

interface Tile {
  el: HTMLElement;
  target: Geo;
  /** Spring state per key: offset from the target and velocity at `t0`. */
  x0: Geo;
  v0: Geo;
  t0: number;
  /** TileMotion's count of painted frames when the spring last (re)started. */
  paintedAt: number;
  hidden: boolean;
  /** Content held at one size while gliding. */
  frozen: HTMLElement[];
  /** Last values written. */
  shown: Geo;
}

const zero = (): Geo => ({ x: 0, y: 0, w: 0, h: 0, s: 0, o: 0 });
const geo = (r: Rect, o: number): Geo => ({ x: r.x, y: r.y, w: r.w, h: r.h, s: 1, o });
/** Rest when every key is within half a pixel (opacity within 1%, scale within 0.1%). */
const EPS: Geo = { x: 0.5, y: 0.5, w: 0.5, h: 0.5, s: 0.001, o: 0.01 };
const resting = (x: Geo, v: Geo) => KEYS.every((k) => Math.abs(x[k]) < EPS[k] && Math.abs(v[k]) < EPS[k] * 40);
const now = () => performance.now();
/** A retarget this soon after the last belongs to the same change (see update). */
const SETTLED_MS = 34;

export class TileMotion {
  private tiles = new Map<string, Tile>();
  private raf = 0;
  private booted = false;
  /** Frames painted while gliding: counted by a task each frame posts, which runs after it's painted. */
  private painted = 0;
  private afterPaint = (() => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => void this.painted++;
    return ch.port2;
  })();

  /**
   * After every render: each window element (data-pane) and where it goes. New
   * windows fade in (at boot: just appear), gone ones are forgotten.
   */
  update(els: Map<string, HTMLElement>, targets: Map<string, TileTarget>, opts: UpdateOptions): void {
    const t = now();
    const instantAll = opts.instant || reducedMotion();
    for (const [id, tile] of this.tiles) if (!els.has(id) || els.get(id) !== tile.el) this.drop(id);
    for (const [id, el] of els) {
      const target = targets.get(id);
      if (!target) continue;
      let tile = this.tiles.get(id);
      if (!tile) {
        const g = geo(target.rect, target.hidden ? 0 : 1);
        tile = { el, target: g, x0: zero(), v0: zero(), t0: t, paintedAt: this.painted, hidden: target.hidden, frozen: [], shown: { x: NaN, y: NaN, w: NaN, h: NaN, s: NaN, o: NaN } };
        this.tiles.set(id, tile);
        // A window opened after boot comes in: scaled up from a little smaller, fading in
        // (its layout size never changes: shown size and scale shrink alike).
        if (this.booted && !instantAll && !target.hidden) tile.x0 = { x: g.w * 0.02, y: g.h * 0.02, w: -g.w * 0.04, h: -g.h * 0.04, s: -0.04, o: -1 };
        this.write(tile, this.at(tile, t));
        continue;
      }
      // A glide under way carries on from where it is, with its speed (an interrupted move
      // turns smoothly). One that nothing has been painted of yet (the viewport settling
      // after a switch, before the next frame) starts over from where it started: what's
      // on screen.
      const fresh = this.painted === tile.paintedAt && t - tile.t0 < SETTLED_MS;
      const from = fresh ? tile.t0 : t;
      const shifted = !instantAll && !!opts.remap;
      if (shifted) {
        // Restart the spring from now, from where the window now has to be (its speed scaled alike).
        const c = this.at(tile, from);
        const v = this.velocity(tile, from);
        const m = opts.remap!(c.x, c.y, c.s);
        const k = m.s / c.s;
        this.retarget(tile, tile.target, { ...c, ...m, w: c.w * k, h: c.h * k }, { ...v, x: v.x * k, y: v.y * k, w: v.w * k, h: v.h * k }, t);
      }
      const cur = this.at(tile, shifted ? t : from);
      const vel = this.velocity(tile, shifted ? t : from);
      // Hidden, a window keeps the geometry it has (focus mode gives every window the full rect).
      const rect = target.hidden ? tile.target : target.rect;
      const next = geo(rect, target.hidden ? 0 : 1);
      const wasHidden = tile.hidden;
      tile.hidden = target.hidden;
      const instant = instantAll || target.instant;
      // Showing a window that's out of sight: it's put in place first, then fades in.
      const appearing = wasHidden && !target.hidden && cur.o < 0.01;
      if (instant || ((opts.swap || instantAll) && wasHidden !== target.hidden)) {
        this.retarget(tile, next, next, zero(), t);
      } else if (appearing) {
        this.retarget(tile, next, { ...next, o: 0 }, zero(), t);
      } else if (shifted || KEYS.some((k) => next[k] !== tile.target[k])) {
        this.retarget(tile, next, cur, vel, t);
        if (next.w !== cur.w / cur.s || next.h !== cur.h / cur.s) this.freeze(tile);
      } else continue;
      this.write(tile, this.at(tile, t));
    }
    this.booted ||= els.size > 0 && !opts.instant;
    this.schedule();
  }

  /** Every window at rest where it belongs (tests, and before reading layout). */
  finish(): void {
    for (const tile of this.tiles.values()) (tile.x0 = zero()), (tile.v0 = zero()), this.write(tile, tile.target), this.thaw(tile);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.afterPaint.close();
    for (const id of [...this.tiles.keys()]) this.drop(id);
  }

  private retarget(tile: Tile, target: Geo, from: Geo, vel: Geo, t: number) {
    tile.target = target;
    tile.t0 = t;
    tile.paintedAt = this.painted;
    for (const k of KEYS) (tile.x0[k] = from[k] - target[k]), (tile.v0[k] = vel[k]);
  }

  private at(tile: Tile, t: number): Geo {
    const s = (t - tile.t0) / 1000;
    const g = zero();
    for (const k of KEYS) g[k] = tile.target[k] + (tile.x0[k] || tile.v0[k] ? spring(tile.x0[k], tile.v0[k], s)[0] : 0);
    return g;
  }

  private velocity(tile: Tile, t: number): Geo {
    const s = (t - tile.t0) / 1000;
    const v = zero();
    for (const k of KEYS) v[k] = tile.x0[k] || tile.v0[k] ? spring(tile.x0[k], tile.v0[k], s)[1] : 0;
    return v;
  }

  private schedule() {
    if (this.raf) return;
    const t = now();
    const moving = [...this.tiles.values()].some((tile) => !this.isResting(tile, t));
    if (moving) this.raf = requestAnimationFrame(this.frame);
  }

  private isResting(tile: Tile, t: number): boolean {
    const s = (t - tile.t0) / 1000;
    const x = zero();
    const v = zero();
    for (const k of KEYS) [x[k], v[k]] = tile.x0[k] || tile.v0[k] ? spring(tile.x0[k], tile.v0[k], s) : [0, 0];
    return resting(x, v);
  }

  private frame = () => {
    this.raf = 0;
    this.afterPaint.postMessage(0);
    const t = now();
    let moving = false;
    for (const tile of this.tiles.values()) {
      if (this.isResting(tile, t)) {
        tile.x0 = zero();
        tile.v0 = zero();
        this.write(tile, tile.target);
        this.thaw(tile);
      } else {
        moving = true;
        this.write(tile, this.at(tile, t));
      }
    }
    if (moving) this.raf = requestAnimationFrame(this.frame);
  };

  private write(tile: Tile, g: Geo) {
    const s = tile.el.style;
    const p = tile.shown;
    if (g.x !== p.x || g.y !== p.y || g.s !== p.s) s.transform = `translate(${g.x}px, ${g.y}px)${g.s === 1 ? "" : ` scale(${g.s})`}`;
    // Shown size and scale glide on their own, so what's on screen grows or shrinks
    // steadily; the layout size is what's left (their quotient).
    if (g.w !== p.w || g.s !== p.s) s.width = `${g.w / g.s}px`;
    if (g.h !== p.h || g.s !== p.s) s.height = `${g.h / g.s}px`;
    const o = Math.max(0, Math.min(1, g.o));
    if (o !== p.o) {
      s.opacity = o >= 1 ? "" : String(o);
      // Out of sight once faded: no pointer, no focus, nothing painted. Attributes, not
      // classes: React owns the class name and rewrites it.
      tile.el.toggleAttribute("data-hidden", o <= 0 && tile.hidden);
    }
    const morphing = KEYS.some((k) => tile.x0[k] || tile.v0[k]);
    if (tile.el.hasAttribute("data-morphing") !== morphing) tile.el.toggleAttribute("data-morphing", morphing);
    tile.shown = { ...g, o };
  }

  /**
   * Hold the content (everything in the body but the title bar) at the larger of
   * its size now and its size at the target, so it's laid out once for the whole
   * glide; the window clips it. Released at rest, when it takes the final size.
   */
  private freeze(tile: Tile) {
    const body = tile.el.querySelector<HTMLElement>(":scope > .tile-body");
    if (!body) return;
    const box = tile.el.getBoundingClientRect();
    const scale = box.width / Math.max(1, tile.el.offsetWidth) || 1; // the canvas zooms the track
    const dw = tile.target.w - tile.el.offsetWidth;
    const dh = tile.target.h - tile.el.offsetHeight;
    for (const c of body.children) {
      if (!(c instanceof HTMLElement) || c.classList.contains("tile-title")) continue;
      const r = c.getBoundingClientRect();
      const w = r.width / scale;
      const h = r.height / scale;
      if (!w || !h) continue;
      // Already held (interrupted): keep the size it holds if that's larger.
      const held = tile.frozen.includes(c);
      const hw = held ? parseFloat(c.style.width) : 0;
      const hh = held ? parseFloat(c.style.height) : 0;
      c.style.width = `${Math.max(w + Math.max(0, dw), hw)}px`;
      c.style.height = `${Math.max(h + Math.max(0, dh), hh)}px`;
      c.setAttribute("data-held", "");
      if (!held) tile.frozen.push(c);
    }
  }

  private thaw(tile: Tile) {
    for (const c of tile.frozen) {
      c.style.width = "";
      c.style.height = "";
      c.removeAttribute("data-held");
    }
    tile.frozen = [];
  }

  private drop(id: string) {
    const tile = this.tiles.get(id);
    if (tile) this.thaw(tile), tile.el.removeAttribute("data-morphing");
    this.tiles.delete(id);
  }
}
