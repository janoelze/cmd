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
import { planTyping, TYPING, type TypingProfile } from "./typing.ts";

/** Pacing for viewers, ms. */
export const PACE = {
  hover: [150, 400] as [number, number],
  hold: [80, 130] as [number, number],
  after: [300, 800] as [number, number],
  /** Keep this far from a scroll container's edges when revealing, px. */
  margin: 32,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Tour {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly helper: Helper;
  private r: Rng;
  /** Where the pointer is, screen points. */
  private at: Point = { x: 0, y: 0 };

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
   * Scrolls the target into view if it isn't: the outermost scroll container
   * first, with a gesture of exactly the distance, the pointer over that
   * container. Repeats until it fits (nested containers, late layout).
   */
  async reveal(target: Locator) {
    for (let round = 0; round < 6; round++) {
      const need = await target.evaluate((el, margin) => {
        const r = el.getBoundingClientRect();
        let outer: { box: { x: number; y: number; width: number; height: number }; dy: number } | null = null;
        for (let p = el.parentElement; p; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (!/(auto|scroll)/.test(cs.overflowY) || p.scrollHeight <= p.clientHeight + 1) continue;
          const b = p.getBoundingClientRect();
          const top = b.top + margin, bottom = b.top + p.clientHeight - margin;
          let dy = r.top < top ? r.top - top : r.bottom > bottom ? Math.min(r.bottom - bottom, r.top - top) : 0;
          dy = Math.max(-p.scrollTop, Math.min(dy, p.scrollHeight - p.clientHeight - p.scrollTop));
          if (Math.abs(dy) >= 2) outer = { box: { x: b.left, y: b.top, width: p.clientWidth, height: p.clientHeight }, dy };
        }
        return outer;
      }, PACE.margin);
      if (!need) return;
      const area = await this.onScreen(need.box);
      // Over the container, near where the pointer already is.
      const over = {
        x: Math.min(Math.max(this.at.x, area.x + 40), area.x + area.width - 40),
        y: area.y + area.height * between(this.r, 0.4, 0.6),
      };
      await this.moveTo(over, Math.min(area.width, area.height));
      const o = await this.origin();
      const steps = planScroll(need.dy * o.zoom);
      await this.helper.call("scroll", { x: over.x, y: over.y, steps: steps.map((s) => [s.t, s.dy, s.phase]) });
      await sleep(150);
    }
  }

  /** Hovers a target: moves there and rests. */
  async hover(target: Locator, rest = between(this.r, ...PACE.hover)) {
    await this.reveal(target);
    const b = await this.box(target);
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

  /** Types into whatever has focus. */
  async type(text: string, profile: TypingProfile = TYPING.terminal) {
    await this.helper.call("type", { text, delays: planTyping(text, this.r, profile) });
  }

  /** A key, with modifiers ("cmd", "shift", "alt", "ctrl"). */
  async press(key: string, ...mods: string[]) {
    await this.helper.call("key", { key, mods });
    await sleep(between(this.r, ...PACE.after));
  }

  /** Scrolls a container by px, or until a target inside it is in view. */
  async scroll(container: Locator, opts: { by?: number; to?: Locator }) {
    if (opts.to) return this.reveal(opts.to);
    await this.hover(container);
    const o = await this.origin();
    const steps = planScroll((opts.by ?? 0) * o.zoom);
    await this.helper.call("scroll", { ...this.at, steps: steps.map((s) => [s.t, s.dy, s.phase]) });
    await sleep(150);
  }

  /** Runs an app command (its menu item) without showing a pointer: a cut, or setup. */
  async command(id: string) {
    await this.app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), id);
  }

  async pause(ms: number) {
    await sleep(ms);
  }
}
