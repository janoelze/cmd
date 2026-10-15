// How much of a widget's console reaches clients (`widget.log`, for `cmd widget dev`): a token
// bucket per window, about 50 lines a second with a short burst, so a widget that logs in a
// loop can't flood the app and every CLI connection. What doesn't fit is dropped and counted;
// a second after the first drop one line says how many ("312 lines dropped"), then counting
// starts again, so a flood that goes on costs one more line a second. The core's own log
// takes the same lines (host.ts), so a flood doesn't fill core.log either.

import type { WidgetHostLog } from "@cmd/protocol";
import { LOG_LIMIT } from "../limits.ts";

export interface LogLimitOptions {
  /** Lines a second, kept up. */
  rate: number;
  /** Lines at once, after a quiet spell. */
  burst: number;
  /** How long after the first drop the count is said. */
  reportMs: number;
}


export class LogLimit {
  #emit: (l: WidgetHostLog) => void;
  #o: LogLimitOptions;
  #now: () => number;
  #tokens: number;
  #at: number;
  #dropped = 0;
  #timer: NodeJS.Timeout | null = null;

  constructor(emit: (l: WidgetHostLog) => void, o: LogLimitOptions = LOG_LIMIT, now: () => number = Date.now) {
    this.#emit = emit;
    this.#o = o;
    this.#now = now;
    this.#tokens = o.burst;
    this.#at = now();
  }

  /** A line from the widget: sent if the bucket has room (true), else counted (false). */
  push(l: WidgetHostLog): boolean {
    const t = this.#now();
    this.#tokens = Math.min(this.#o.burst, this.#tokens + ((t - this.#at) / 1000) * this.#o.rate);
    this.#at = t;
    if (this.#tokens >= 1) {
      this.#tokens--;
      this.#emit(l);
      return true;
    }
    this.#dropped++;
    this.#timer ??= setTimeout(() => this.#report(), this.#o.reportMs);
    this.#timer.unref?.();
    return false;
  }

  #report(): void {
    this.#timer = null;
    const n = this.#dropped;
    this.#dropped = 0;
    if (n) this.#emit({ level: "warn", message: `… ${n} ${n === 1 ? "line" : "lines"} dropped (it logs more than ${this.#o.rate} a second)` });
  }

  /** Stop: say what was dropped now, and keep no timer. */
  close(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#report();
  }
}
