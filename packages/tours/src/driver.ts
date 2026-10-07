// The tour driver: what a tour script calls. It finds things by role and name
// (Playwright locators), works out where they are on screen, scrolls them into
// view when they aren't (visibly, with a trackpad gesture of the right length),
// plans human-looking motion and has the helper play it as real input. Every
// step waits on the app, not on fixed sleeps, except the pauses that pace the
// video for viewers.

import type { ElectronApplication, Locator, Page } from "playwright";
import type { Helper } from "./helper.ts";
import { aimAt, planMove, type Box, type Point } from "./motion.ts";
import { between, rng, type Rng } from "./random.ts";
import { planScroll } from "./scroll.ts";
import { planKeys, TYPING, type TypingProfile } from "./typing.ts";

/** Pacing for viewers, ms. */
export const PACE = {
  hover: [120, 300] as [number, number],
  hold: [80, 130] as [number, number],
  /** After a click, before the next step (a tour's own t.pause is for viewers to read). */
  after: [180, 400] as [number, number],
  /** Keep this far from a scroll container's edges when revealing, px. */
  margin: 32,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** TOUR_DEBUG=1: each step, as it starts. */
const debug = (...a: unknown[]) => process.env.TOUR_DEBUG && console.log("tour:", ...a);

export class Tour {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly helper: Helper;
  private r: Rng;
  /** Where the pointer is, screen points. */
  private at: Point = { x: 0, y: 0 };

  /**
   * The video's camera, rendered in post (post.ts): marks in the event log on
   * the frames' clock. Zooming happens in the video, not in the app.
   */
  readonly camera = {
    /** Zoom to a place (an element, or a box in screen points); `zoom` fits it with room if left out. */
    focus: async (target: Locator | Box, zoom?: number) => {
      const b = "x" in target ? target : await this.box(target);
      await this.helper.call("mark", { type: "camera", mode: "focus", rect: [b.x, b.y, b.width, b.height], ...(zoom ? { zoom } : {}) });
    },
    /** Stay zoomed in and follow the pointer smoothly (it drifts only when the pointer nears the view's edge). */
    follow: async (zoom = 1.6) => {
      await this.helper.call("mark", { type: "camera", mode: "follow", zoom });
    },
    /** Back to the whole window. */
    reset: async () => {
      await this.helper.call("mark", { type: "camera", mode: "fit" });
    },
  };

  /** Running shots: the polling of their region's boxes, and where the pointer was when each began. */
  private shots = new Map<string, { stop: () => void; from: Point }>();

  /**
   * Shots: named crops of the recording, rendered as their own videos (post's
   * renderShots), e.g. a square loop of the command palette for the website.
   * The region is UI, found by role and name: while a shot runs its boxes are
   * logged as they change (the palette appears, its list grows), and post frames
   * the union of them with padding at the aspect ratio. `loop` makes the clip
   * seamless (end with t.loopBack() so the last frames look like the first).
   */
  readonly shot = {
    start: async (name: string, o: { region: Locator[]; pad?: number; aspect?: number; loop?: boolean; framing?: "longest" | "union" }) => {
      await this.helper.call("mark", { type: "shot", name, phase: "start", pad: o.pad ?? 40, aspect: o.aspect ?? 1, loop: o.loop ?? true, framing: o.framing ?? "longest" });
      let last = "";
      let busy = false;
      const poll = async () => {
        if (busy) return;
        busy = true;
        try {
          const boxes = (await Promise.all(o.region.map((l) => l.boundingBox({ timeout: 100 }).catch(() => null)))).filter((b) => b !== null);
          if (!boxes.length) return;
          const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
          const x1 = Math.max(...boxes.map((b) => b.x + b.width)), y1 = Math.max(...boxes.map((b) => b.y + b.height));
          const box = await this.onScreen({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
          const key = [box.x, box.y, box.width, box.height].map(Math.round).join(" ");
          if (key === last) return;
          last = key;
          await this.helper.call("mark", { type: "shot-box", name, rect: [box.x, box.y, box.width, box.height] });
        } finally {
          busy = false;
        }
      };
      await poll();
      const timer = setInterval(() => void poll(), 200);
      this.shots.set(name, { stop: () => clearInterval(timer), from: { ...this.at } });
    },
    end: async (name: string) => {
      this.shots.get(name)?.stop();
      this.shots.delete(name);
      await this.helper.call("mark", { type: "shot", name, phase: "end" });
    },
  };

  /** For a looping shot: the pointer back to where it was when the shot began, so the end matches the start. */
  async loopBack(name?: string) {
    const s = name ? this.shots.get(name) : [...this.shots.values()].at(-1);
    if (s) await this.moveTo(s.from, 60);
  }

  constructor(app: ElectronApplication, page: Page, helper: Helper, seed = 1) {
    this.app = app;
    this.page = page;
    this.helper = helper;
    this.r = rng(seed);
  }

  /** The page's origin on screen and its zoom: page px × zoom + origin = screen points. */
  private async origin(): Promise<{ x: number; y: number; zoom: number }> {
    return this.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      const b = w.getContentBounds();
      return { x: b.x, y: b.y, zoom: w.webContents.getZoomFactor() };
    });
  }

  private async onScreen(b: Box): Promise<Box> {
    const o = await this.origin();
    return { x: o.x + b.x * o.zoom, y: o.y + b.y * o.zoom, width: b.width * o.zoom, height: b.height * o.zoom };
  }

  private async box(target: Locator): Promise<Box> {
    await target.waitFor({ state: "attached" });
    const b = await target.boundingBox();
    if (!b) throw new Error(`not visible: ${target}`);
    return this.onScreen(b);
  }

  /** The window's content area on screen, points. */
  async windowBox(): Promise<Box> {
    const b = await this.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentBounds());
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }

  /** For setup: jumps a scroll container (or the first one inside it: the strip in main) to its start, at once. */
  async scrollToStart(container: Locator) {
    await container.evaluate((root) => {
      for (const el of [root, ...root.querySelectorAll("*")]) {
        const cs = getComputedStyle(el);
        const x = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
        const y = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
        if (x || y) return el.scrollTo({ left: 0, top: 0, behavior: "instant" });
      }
    });
  }

  /** Puts the pointer somewhere without showing it (before recording). */
  async park(p: Point) {
    await this.helper.call("release");
    await this.helper.call("path", { points: [[0, p.x, p.y]] });
    this.at = p;
  }

  /** Parks the pointer at a share of the window (0.5, 0.6 = a bit below the middle). */
  async parkInWindow(fx = 0.5, fy = 0.6) {
    const b = await this.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentBounds());
    await this.park({ x: b.x + b.width * fx, y: b.y + b.height * fy });
  }

  /** Moves the pointer along a planned path to a point; `width` is the target's size (Fitts). */
  async moveTo(p: Point, width = 40, button?: "left" | "right") {
    const path = planMove(this.at, p, width, this.r);
    await this.helper.call("path", { points: path.map((s) => [s.t, s.x, s.y]), button });
    this.at = p;
  }

  /**
   * Scrolls the target into view if it isn't (to ~40% of the container's
   * height, not just inside the edge): the outermost scroll container
   * first, with a gesture of exactly the distance, the pointer over that
   * container. Repeats until it fits (nested containers, late layout).
   */
  async reveal(target: Locator) {
    for (let round = 0; round < 6; round++) {
      debug("reveal", round, String(target));
      const need = await target.evaluate((el, margin) => {
        const r = el.getBoundingClientRect();
        let outer: { box: { x: number; y: number; width: number; height: number }; d: number; axis: "x" | "y"; el: Element } | null = null;
        for (let p = el.parentElement; p; p = p.parentElement) {
          const cs = getComputedStyle(p);
          const b = p.getBoundingClientRect();
          const box = { x: b.left, y: b.top, width: p.clientWidth, height: p.clientHeight };
          // Down: out of view, bring it to ~40% of the container's height, where a viewer looks (not the edge).
          if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) {
            const out = r.top < b.top + margin || r.bottom > b.top + p.clientHeight - margin;
            let d = out ? r.top + r.height / 2 - (b.top + p.clientHeight * 0.4) : 0;
            d = Math.max(-p.scrollTop, Math.min(d, p.scrollHeight - p.clientHeight - p.scrollTop));
            if (Math.abs(d) >= 2) outer = { box, d, axis: "y", el: p };
          }
          // Sideways (the strip): out of view, centre it, or its start if it's wider than the view.
          if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) {
            const out = r.left < b.left + margin || r.right > b.left + p.clientWidth - margin;
            let d = !out ? 0 : r.width > p.clientWidth - 2 * margin ? r.left - (b.left + margin) : r.left + r.width / 2 - (b.left + p.clientWidth / 2);
            d = Math.max(-p.scrollLeft, Math.min(d, p.scrollWidth - p.clientWidth - p.scrollLeft));
            if (Math.abs(d) >= 2) outer = { box, d, axis: "x", el: p };
          }
        }
        if (!outer) return null;
        // Where to swipe: a point whose topmost element is in the container (in the strip,
        // floating sidebars cover part of it, and a swipe over them scrolls them).
        const { box: bx, el: sc } = outer;
        let spot: { x: number; y: number } | null = null;
        let best = Infinity;
        for (let i = 1; i < 10; i++)
          for (let j = 1; j < 6; j++) {
            const x = bx.x + (bx.width * i) / 10, y = bx.y + (bx.height * j) / 6;
            const hit = document.elementFromPoint(x, y);
            if (!hit || !sc.contains(hit)) continue;
            const far = Math.hypot(x - (bx.x + bx.width / 2), y - (bx.y + bx.height / 2));
            if (far < best) (best = far), (spot = { x, y });
          }
        return { box: outer.box, d: outer.d, axis: outer.axis, spot };
      }, PACE.margin);
      if (!need) return;
      debug("  scroll", need.axis, Math.round(need.d));
      const area = await this.onScreen(need.box);
      // Over the container where nothing covers it (or near the pointer, if it can't tell).
      const over = need.spot
        ? await this.onScreen({ x: need.spot.x, y: need.spot.y, width: 0, height: 0 })
        : { x: Math.min(Math.max(this.at.x, area.x + 40), area.x + area.width - 40), y: area.y + area.height * between(this.r, 0.4, 0.6) };
      await this.moveTo(over, Math.min(area.width, area.height));
      const o = await this.origin();
      const steps = planScroll(need.d * o.zoom);
      await this.helper.call("scroll", { x: over.x, y: over.y, axis: need.axis, steps: steps.map((s) => [s.t, s.d, s.phase]) });
      await sleep(150);
    }
  }

  /** Hovers a target: moves there and rests. */
  async hover(target: Locator, rest = between(this.r, ...PACE.hover)) {
    debug("hover", String(target));
    await this.reveal(target);
    const b = await this.box(target);
    const w = await this.windowBox();
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    if (cx < w.x || cx > w.x + w.width || cy < w.y || cy > w.y + w.height)
      throw new Error(`still off screen after revealing it (centre ${Math.round(cx)},${Math.round(cy)}, window ${w.x},${w.y} ${w.width}×${w.height}): ${target}`);
    await this.moveTo(aimAt(b, this.r), Math.min(b.width, b.height));
    await sleep(rest);
  }

  async click(target: Locator, opts: { button?: "left" | "right"; clicks?: 1 | 2 } = {}) {
    await this.hover(target);
    const button = opts.button ?? "left";
    for (let c = 1; c <= (opts.clicks ?? 1); c++) {
      await this.helper.call("down", { ...this.at, button, clicks: c });
      await sleep(between(this.r, ...PACE.hold));
      await this.helper.call("up", { ...this.at, button, clicks: c });
      if (c < (opts.clicks ?? 1)) await sleep(90);
    }
    await sleep(between(this.r, ...PACE.after));
  }

  /** Drags a target onto another: press, a small slow start past the drag threshold, the move, a settle, release. */
  async drag(from: Locator, to: Locator) {
    await this.hover(from);
    await this.helper.call("down", { ...this.at, button: "left" });
    await sleep(100);
    const nudge = { x: this.at.x + 6, y: this.at.y + 4 };
    await this.helper.call("path", { points: [[60, nudge.x, nudge.y]], button: "left" });
    this.at = nudge;
    const b = await this.box(to);
    const p = aimAt(b, this.r);
    await this.helper.call("path", { points: planMove(this.at, p, Math.min(b.width, b.height), this.r).map((s) => [s.t, s.x, s.y]), button: "left" });
    this.at = p;
    await sleep(between(this.r, 100, 200));
    await this.helper.call("up", { ...this.at, button: "left" });
    await sleep(between(this.r, ...PACE.after));
  }

  /**
   * Chooses an item in the open native menu (a context menu after a right
   * click, or a menu-bar menu) by its title: the start of it, so "Rename…"
   * matches "Rename… (F2)". Found through macOS Accessibility.
   */
  async menuItem(title: string) {
    const pid = this.app.process().pid;
    type Item = { title: string; x: number; y: number; w: number; h: number; enabled: boolean };
    let item: Item | undefined;
    for (let i = 0; i < 40 && !item; i++) {
      const { items } = (await this.helper.call("menu-items", { pid })) as unknown as { items: Item[] };
      item = items.find((x) => x.title === title) ?? items.find((x) => x.title.startsWith(title));
      if (!item) await sleep(50);
    }
    if (!item) throw new Error(`no open menu item "${title}"`);
    if (!item.enabled) throw new Error(`menu item "${title}" is disabled`);
    // Menu rows are wide: aim near the label, like a person would.
    const at = aimAt({ x: item.x, y: item.y, width: Math.min(item.w, 120), height: item.h }, this.r);
    await this.moveTo(at, item.h);
    await sleep(between(this.r, ...PACE.hover));
    await this.helper.call("down", { ...at, button: "left" });
    await sleep(between(this.r, ...PACE.hold));
    await this.helper.call("up", { ...at, button: "left" });
    await sleep(between(this.r, ...PACE.after));
  }

  /** Drags a target by an offset (points): a resize edge, a slider. */
  async dragBy(from: Locator, dx: number, dy = 0) {
    await this.hover(from);
    await this.helper.call("down", { ...this.at, button: "left" });
    await sleep(100);
    const to = { x: this.at.x + dx, y: this.at.y + dy };
    await this.helper.call("path", { points: planMove(this.at, to, 80, this.r).map((s) => [s.t, s.x, s.y]), button: "left" });
    this.at = to;
    await sleep(between(this.r, 100, 200));
    await this.helper.call("up", { ...this.at, button: "left" });
    await sleep(between(this.r, ...PACE.after));
  }

  /**
   * Where typing goes, on screen: the text cursor's spot (xterm's hidden
   * textarea sits at the terminal's cursor; editors have a selection; fields
   * their box), widened a little so it reads as a place, not a point.
   */
  private async caretBox(): Promise<Box | null> {
    const b = await this.page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      let r: DOMRect | null = null;
      if (el.isContentEditable) {
        const sel = getSelection();
        if (sel?.rangeCount) r = sel.getRangeAt(0).getBoundingClientRect();
      }
      if (!r || (r.width === 0 && r.height === 0)) r = el.getBoundingClientRect();
      // A terminal's or editor's line: some room to the right for what's typed, a few lines around it.
      const host = el.closest('[role="group"][aria-label]')?.getBoundingClientRect();
      const w = Math.min(host?.width ?? 600, 640);
      const x = Math.max(host?.left ?? r.left, Math.min(r.left - 40, (host?.right ?? r.left + w) - w));
      return { x, y: r.top - 60, width: w, height: Math.max(r.height, 20) + 120 };
    });
    return b ? this.onScreen(b) : null;
  }

  /**
   * Types into whatever has focus. Before typing, the pointer drifts near the
   * text cursor if it's far from it (people do, and it keeps the shot on the
   * work), and the spot is logged so the automatic camera frames the typing.
   * `{ stay: true }` leaves the pointer where it is.
   */
  async type(text: string, profile: TypingProfile = TYPING.terminal, o: { stay?: boolean } = {}) {
    const caret = await this.caretBox().catch(() => null);
    if (caret) {
      await this.helper.call("mark", { type: "typing", rect: [caret.x, caret.y, caret.width, caret.height] });
      const near = { x: caret.x + caret.width * 0.75, y: caret.y + caret.height + 40 };
      const w = await this.windowBox();
      near.x = Math.min(Math.max(near.x, w.x + 30), w.x + w.width - 30);
      near.y = Math.min(Math.max(near.y, w.y + 50), w.y + w.height - 50);
      if (!o.stay && Math.hypot(near.x - this.at.x, near.y - this.at.y) > 280) await this.moveTo(near, 200);
    }
    const k = planKeys(text, this.r, profile);
    await this.helper.call("type", { text: k.keys, delays: k.delays });
  }

  /** A key, with modifiers ("cmd", "shift", "alt", "ctrl"). */
  async press(key: string, ...mods: string[]) {
    await this.helper.call("key", { key, mods });
    await sleep(between(this.r, ...PACE.after));
  }

  /** Scrolls a container by px (down, or `x` sideways), or until a target inside it is in view. */
  async scroll(container: Locator, opts: { by?: number; x?: number; to?: Locator }) {
    if (opts.to) return this.reveal(opts.to);
    await this.hover(container);
    await this.swipeHere(opts.x ?? opts.by ?? 0, opts.x !== undefined ? "x" : "y");
  }

  /**
   * A sideways trackpad swipe where the pointer is: positive moves along to
   * the right (the strip's next windows). Lands exactly `px` further.
   */
  async swipe(px: number) {
    await this.swipeHere(px, "x");
  }

  /**
   * Pans the canvas: a two-finger drag of (dx, dy) points over empty canvas
   * (over a window it would scroll that window instead). Positive dx shows
   * what's to the right.
   */
  async pan(dx: number, dy: number) {
    await this.moveTo(await this.emptyCanvasPoint());
    const o = await this.origin();
    const d = Math.hypot(dx, dy);
    const steps = planScroll(d * o.zoom);
    await this.helper.call("scroll", { ...this.at, dir: [dx / d, dy / d], steps: steps.map((s) => [s.t, s.d, s.phase]) });
    await sleep(150);
  }

  /** Zooms the canvas at the pointer with ⌘-scroll: positive zooms in. Over empty canvas unless `at` is given. */
  async zoom(amount: number, at?: Locator) {
    if (at) await this.hover(at);
    else await this.moveTo(await this.emptyCanvasPoint());
    const o = await this.origin();
    const steps = planScroll(-amount * o.zoom);
    await this.helper.call("scroll", { ...this.at, axis: "y", mods: ["cmd"], steps: steps.map((s) => [s.t, s.d, s.phase]) });
    await sleep(200);
  }

  /** A point in the main area with no window under it (nearest the middle), screen points. */
  private async emptyCanvasPoint(): Promise<Point> {
    const spot = await this.page.getByRole("main").evaluate((m) => {
      const b = m.getBoundingClientRect();
      let best: { x: number; y: number } | null = null;
      let far = Infinity;
      for (let i = 1; i < 16; i++)
        for (let j = 1; j < 10; j++) {
          const x = b.left + (b.width * i) / 16, y = b.top + (b.height * j) / 10;
          const hit = document.elementFromPoint(x, y);
          if (!hit || !m.contains(hit) || hit.closest('[role="group"][aria-label]') || hit.closest("svg")) continue;
          const d = Math.hypot(x - (b.left + b.width / 2), y - (b.top + b.height / 2));
          if (d < far) (far = d), (best = { x, y });
        }
      return best;
    });
    if (!spot) throw new Error("no empty canvas to pan on: every point is a window");
    return this.onScreen({ x: spot.x, y: spot.y, width: 0, height: 0 }).then((b) => ({ x: b.x, y: b.y }));
  }

  private async swipeHere(px: number, axis: "x" | "y") {
    const o = await this.origin();
    const steps = planScroll(px * o.zoom);
    await this.helper.call("scroll", { ...this.at, axis, steps: steps.map((s) => [s.t, s.d, s.phase]) });
    await sleep(150);
  }

  /** Runs an app command (its menu item) without showing a pointer: a cut, or setup. */
  async command(id: string) {
    await this.app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), id);
  }

  /**
   * Moves the pointer off what it rests on, a little way into the window:
   * after clicking a button, its hover state and tooltip would stay up.
   */
  async away() {
    const b = await this.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentBounds());
    const dx = this.at.x > b.x + b.width / 2 ? -1 : 1;
    const dy = this.at.y > b.y + b.height / 2 ? -1 : 1;
    const to = {
      x: Math.min(Math.max(this.at.x + dx * between(this.r, 120, 220), b.x + 40), b.x + b.width - 40),
      y: Math.min(Math.max(this.at.y + dy * between(this.r, 80, 160), b.y + 60), b.y + b.height - 60),
    };
    await this.moveTo(to, 200);
  }

  /**
   * Waits until a terminal window's screen shows some text. Terminals draw on
   * a canvas, so their text isn't in the page: the core reads the pane.
   * `win` is the window's group (its data-pane is the pane id).
   */
  async waitForText(win: Locator, text: RegExp | string, timeout = 60_000) {
    const paneId = await win.getAttribute("data-pane", { timeout });
    if (!paneId) throw new Error(`not a terminal window: ${win}`);
    const until = Date.now() + timeout;
    const re = typeof text === "string" ? new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : text;
    while (Date.now() < until) {
      const screen = await this.page.evaluate(
        (paneId) => (window as unknown as { cmd: { call: (m: string, p: unknown) => Promise<{ text: string }> } }).cmd.call("pane.read", { paneId, lines: 200 }),
        paneId,
      );
      if (re.test(screen.text)) return;
      await sleep(250);
    }
    throw new Error(`terminal never showed ${re}`);
  }

  /**
   * A deliberate pause, for viewers (to read a result, to see a change land):
   * marked in the log so post keeps it, while it cuts time spent waiting on
   * the app. Waits (waitFor, waitForText) aren't marked and get cut.
   */
  async pause(ms: number) {
    await this.helper.call("mark", { type: "hold", ms });
    await sleep(ms);
  }
}
