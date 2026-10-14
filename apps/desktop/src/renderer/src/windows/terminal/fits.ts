// When terminals whose window changed size are fitted (terminals.ts). A fit costs a reflow
// of the scrollback and a redraw (5-10 ms), and a mode switch resizes every window at
// once: the focused terminal is fitted at once, others on screen as long as this frame's
// fits took less than FRAME_FIT_MS, the rest in the frames after (one glide keeps its
// frames), and those out of sight when the renderer is idle.

import type { PaneId } from "@cmd/protocol";

/** Fitting time a frame takes before further fits wait for the next one. */
const FRAME_FIT_MS = 4;
/** An idle moment with this much time left takes a fit; past the timeout, one per task. */
const IDLE_FIT_MS = 4;
const IDLE_FIT_TIMEOUT = 1000;

/** Whether an element is inside the app window (layout is fresh in a ResizeObserver callback). */
export function onScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
}

export class FitQueue {
  #frame = new Map<PaneId, () => void>();
  #idle = new Map<PaneId, () => void>();
  #raf = 0;
  #task: number | null = null;
  /** Fitting time spent since `#since` (this frame). */
  #spent = 0;
  #since = 0;

  /** Fit a terminal whose size changed (see the top). */
  fit(el: HTMLElement, id: PaneId, fit: () => void): void {
    this.delete(id);
    if (!onScreen(el)) {
      this.#idle.set(id, fit);
      this.#task ??= requestIdleCallback(this.#runIdle, { timeout: IDLE_FIT_TIMEOUT });
    } else if (el.contains(document.activeElement) || this.#budget()) this.#run(fit);
    else {
      this.#frame.set(id, fit);
      this.#raf ||= requestAnimationFrame(this.#runFrame);
    }
  }

  delete(id: PaneId): void {
    this.#frame.delete(id);
    this.#idle.delete(id);
  }

  #budget(): boolean {
    const now = performance.now();
    if (now - this.#since > 8) (this.#since = now), (this.#spent = 0);
    return this.#spent < FRAME_FIT_MS;
  }

  #run(fit: () => void): void {
    const t = performance.now();
    fit();
    this.#spent += performance.now() - t;
  }

  #runFrame = (): void => {
    this.#raf = 0;
    this.#since = performance.now();
    this.#spent = 0;
    for (const [id, fit] of this.#frame) {
      if (this.#spent >= FRAME_FIT_MS) break;
      this.#frame.delete(id);
      this.#run(fit);
    }
    if (this.#frame.size) this.#raf = requestAnimationFrame(this.#runFrame);
  };

  #runIdle = (deadline: IdleDeadline): void => {
    this.#task = null;
    for (const [id, fit] of this.#idle) {
      if (deadline.timeRemaining() < IDLE_FIT_MS && !deadline.didTimeout) break;
      this.#idle.delete(id);
      fit();
      if (deadline.didTimeout) break; // overdue (no idle time while something animates): one per task
    }
    if (this.#idle.size) this.#task = requestIdleCallback(this.#runIdle, { timeout: IDLE_FIT_TIMEOUT });
  };
}
