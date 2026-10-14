// Fits that can wait (terminals.ts): a terminal whose window changed size while out of
// sight (a mode switch resizes every window) is fitted when the renderer is idle, off
// the glide's frames. A fit costs a reflow of the scrollback and a redraw (5-10 ms).

import type { PaneId } from "@cmd/protocol";

/** An idle moment with this much time left takes a fit; past the timeout, one per task. */
const IDLE_FIT_MS = 4;
const IDLE_FIT_TIMEOUT = 1000;

/** Whether an element is inside the app window (layout is fresh in a ResizeObserver callback). */
export function onScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
}

export class IdleFits {
  #fits = new Map<PaneId, () => void>();
  #task: number | null = null;

  /** Fit a terminal whose size changed: at once while `el` is on screen, else when idle. */
  fit(el: HTMLElement, id: PaneId, fit: () => void): void {
    if (onScreen(el)) return this.delete(id), fit();
    this.add(id, fit);
  }

  add(id: PaneId, fit: () => void): void {
    this.#fits.set(id, fit);
    this.#task ??= requestIdleCallback(this.#run, { timeout: IDLE_FIT_TIMEOUT });
  }

  delete(id: PaneId): void {
    this.#fits.delete(id);
  }

  #run = (deadline: IdleDeadline): void => {
    this.#task = null;
    for (const [id, fit] of this.#fits) {
      if (deadline.timeRemaining() < IDLE_FIT_MS && !deadline.didTimeout) break;
      this.#fits.delete(id);
      fit();
      if (deadline.didTimeout) break; // overdue (no idle time while something animates): one per task
    }
    if (this.#fits.size) this.#task = requestIdleCallback(this.#run, { timeout: IDLE_FIT_TIMEOUT });
  };
}
