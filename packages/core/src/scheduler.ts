// Background work on a budget (docs/34-startup-scheduler.md). The core is one
// thread: while it rebuilds a view or records a transcript, keystrokes wait.
// Long jobs run as a series of steps that `yield` between them; the scheduler
// lets each slice run for BUDGET_MS, then pauses long enough that background
// work takes at most SHARE of wall time, so requests always get the thread
// within a slice. Startup jobs (what used to run before the socket opened) are
// run through here after `listen`, and the phase and their labels are reported
// as core.startup, so the UI can say what the core is doing instead of
// "Connecting to core…".
//
// The watchdog measures how long the event loop was blocked: a timer that fires
// late means something ran that long without yielding. A stall over STALL_MS
// is logged with the activity that was running (a request, a job) so the cause
// names itself in core.log, and the last few show in core.info.
//
// A mark names one synchronous run only: it ends at the next microtask
// boundary (the first `await`) even if `done()` comes later, because whatever
// runs while the marked code waits (another request, a timer, a job's step) is
// not it. `yield()` names the job again for its next step.

import { EventEmitter } from "node:events";
import { logger } from "@cmd/protocol/node";
import type { Stall, StartupStatus } from "@cmd/protocol";

const log = logger("scheduler");
const lag = logger("lag");

/** How long one slice of background steps may run before the scheduler pauses. */
export const BUDGET_MS = 12;
/** Of wall time, how much background work may take while it has steps to run. */
const SHARE = 0.3;
/** The longest pause after a slice (a slow step doesn't earn a long rest). */
const MAX_PAUSE_MS = 250;
/** Stalls of the event loop at least this long are logged and kept. */
export const STALL_MS = 100;
const TICK_MS = 50;
const STALLS_KEPT = 20;

/** What a long job needs from the scheduler: a yield between steps and a name for the watchdog. Tests pass `inlinePacer`. */
export interface Pacer {
  yield(): Promise<void>;
  mark(activity: string): () => void;
}

/** A pacer that only gives the next tick: tests, the lab, views built in memory. */
export const inlinePacer: Pacer = { yield: () => new Promise<void>((r) => setImmediate(r)), mark: () => () => {} };

/** One mark: `done()` and the steps `yield()` names again share it. */
interface Token {
  activity: string;
}
/** A mark's synchronous run: from its start (or a yield's return) to `done()` or the run's end. */
interface Run {
  token: Token;
  since: number;
}

export interface SchedulerOptions {
  budgetMs?: number;
  share?: number;
  /** Tests: no watchdog timer. */
  watchdog?: boolean;
}

export class Scheduler extends EventEmitter<{ startup: [StartupStatus]; stall: [Stall] }> implements Pacer {
  #budget: number;
  #share: number;
  /** When the current slice of background work began, or null between slices. */
  #sliceAt: number | null = null;
  /** The marks open in this synchronous run, innermost last; emptied at its end (#flush). */
  #open: Run[] = [];
  #flushing = false;
  /**
   * Activities that ended lately, with how long each ran: a stall's timer fires
   * only once the thread is free, after the culprit ended, and the one that ran
   * longest since the stall began is the likely one (a trivial request answered
   * right after the block isn't).
   */
  #ended: { activity: string; ms: number; at: number }[] = [];
  #stalls: Stall[] = [];
  #tick: ReturnType<typeof setInterval> | null = null;
  #expected = 0;
  #tasks = new Map<string, string>();
  #phase: StartupStatus["phase"] = "starting";
  #startedAt = Date.now();
  #pending = 0;

  constructor(o: SchedulerOptions = {}) {
    super();
    this.#budget = o.budgetMs ?? BUDGET_MS;
    this.#share = o.share ?? SHARE;
    if (o.watchdog !== false) this.#watch();
  }

  /**
   * Names what runs now, for the watchdog's blame, until `done()` or the end of
   * this synchronous run, whichever comes first: a name held across an `await`
   * would stick to whatever runs in the gap. Nested marks end innermost first,
   * so a request answered inside a job's step hands the name back to the job.
   */
  mark(activity: string): () => void {
    const token: Token = { activity };
    this.#enter(token);
    return () => {
      const i = this.#open.findLastIndex((r) => r.token === token);
      if (i < 0) return; // its run ended at an await: already counted
      this.#ran(activity, this.#open[i]!.since);
      this.#open.splice(i, 1);
    };
  }

  #enter(token: Token): void {
    this.#open.push({ token, since: performance.now() });
    if (this.#flushing) return;
    this.#flushing = true;
    queueMicrotask(this.#flush);
  }

  /** The end of a synchronous run: what is still open ran until now, and stops being named. */
  #flush = (): void => {
    this.#flushing = false;
    for (const r of this.#open) this.#ran(r.token.activity, r.since);
    this.#open.length = 0;
  };

  #ran(activity: string, since: number): void {
    const now = performance.now();
    this.#ended.push({ activity, ms: now - since, at: now });
    if (this.#ended.length > 64) this.#ended.splice(0, this.#ended.length - 64);
  }

  /**
   * Between steps of a long job: returns at once while the slice has budget,
   * else after a pause that keeps background work to its share. Call it every
   * few hundred rows, and at least every few ms of work.
   */
  yield(): Promise<void> {
    const now = performance.now();
    this.#sliceAt ??= now;
    const used = now - this.#sliceAt;
    // The job's name, for its next step: its run ends at the caller's await. Named again after resolving, so the
    // caller's continuation runs before the end of that run (#flush): `await pace.yield()` directly, not through a wrapper.
    const held = this.#open.at(-1)?.token;
    return new Promise<void>((resolve) => {
      const resume = () => {
        resolve();
        if (held) this.#enter(held);
      };
      if (used < this.#budget) setImmediate(resume);
      else {
        const pause = Math.min(MAX_PAUSE_MS, (used * (1 - this.#share)) / this.#share);
        setTimeout(() => {
          this.#sliceAt = performance.now();
          resume();
        }, pause);
      }
    });
  }

  /**
   * A startup job: shown in core.startup under `label` until it finishes. Jobs
   * run one after another, in the order given, each starting on its own tick so
   * the socket answers first. The phase turns "ready" when the last one is done.
   */
  startup(id: string, label: string, job: () => void | Promise<void>): void {
    this.#tasks.set(id, label);
    this.#pending++;
    this.#emitStartup();
    this.#queue = this.#queue.then(async () => {
      await new Promise<void>((r) => setImmediate(r));
      const t0 = performance.now();
      const done = this.mark(`startup: ${id}`);
      try {
        await job();
      } catch (err) {
        if (!this.#disposed) log.error(`startup job ${id} failed`, err);
      } finally {
        done();
        this.#tasks.delete(id);
        this.#pending--;
        const ms = Math.round(performance.now() - t0);
        if (ms > this.#budget) log.info(`startup: ${id}`, { ms });
        this.#emitStartup();
      }
    });
  }
  #queue: Promise<void> = Promise.resolve();

  /** Every startup job is queued: the phase turns "ready" once they have run (at once when there were none). */
  ready(): void {
    this.#queue = this.#queue.then(() => {
      if (this.#phase !== "starting") return;
      this.#phase = "ready";
      log.info("startup done", { ms: Date.now() - this.#startedAt, longestStallMs: this.longestStall() });
      this.#emitStartup();
    });
  }

  /** Tests, the core's close: every startup job has run. */
  async idle(): Promise<void> {
    await this.#queue;
  }

  status(): StartupStatus {
    return { phase: this.#phase, since: this.#startedAt, tasks: [...this.#tasks].map(([id, label]) => ({ id, label })) };
  }

  /** The last few stalls, newest last. */
  stalls(): Stall[] {
    return [...this.#stalls];
  }

  longestStall(): number {
    return this.#stalls.reduce((m, s) => Math.max(m, s.ms), 0);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#tick) clearInterval(this.#tick);
    this.#tick = null;
  }
  #disposed = false;

  #emitStartup(): void {
    this.emit("startup", this.status());
  }

  #watch(): void {
    this.#expected = performance.now() + TICK_MS;
    this.#tick = setInterval(() => {
      const now = performance.now();
      const late = now - this.#expected;
      this.#expected = now + TICK_MS;
      if (late < STALL_MS) return;
      // The block ended before this timer could run, and every mark's run with it: blamed on the run that took longest
      // among those that ended since the timer came due, if it was a good part of the block, else on nothing marked.
      const began = now - late;
      const ended = this.#ended.filter((e) => e.at >= began).sort((a, b) => b.ms - a.ms)[0];
      const blame = (ended && ended.ms >= late / 4 ? ended.activity : null) ?? "(idle: timers, I/O callbacks)";
      const stall: Stall = { at: Date.now() - late, ms: Math.round(late), in: blame };
      this.#stalls.push(stall);
      if (this.#stalls.length > STALLS_KEPT) this.#stalls.shift();
      lag.warn(`${stall.ms} ms in ${blame}`);
      this.emit("stall", stall);
    }, TICK_MS);
    this.#tick.unref();
  }
}
