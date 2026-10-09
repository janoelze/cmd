// Rings Timer widgets (windows/builtin.ts timerType) from the core, so a timer
// ends on time whether or not its workspace is on screen or the app is open: one
// setTimeout per running timer, set again whenever its window changes. When it
// fires, the window is marked rung and a notification goes out.

import type { AppWindow, WindowId } from "@cmd/protocol";
import type { WindowManager } from "./windows/index.ts";
import { durationLabel, type TimerState } from "./windows/builtin.ts";

/** setTimeout's limit; a longer wait is set again when it fires. */
const MAX_WAIT = 2 ** 31 - 1;

export class TimerAlarms {
  #windows: WindowManager;
  #ring: (w: AppWindow, title: string, body: string) => void;
  #timers = new Map<WindowId, { endsAt: number; timer: NodeJS.Timeout }>();

  constructor(windows: WindowManager, ring: (w: AppWindow, title: string, body: string) => void) {
    this.#windows = windows;
    this.#ring = ring;
    windows.on("updated", (w) => this.#sync(w));
    windows.on("removed", (id) => this.#clear(id));
    for (const w of windows.list()) this.#sync(w);
  }

  #sync(w: AppWindow): void {
    if (w.kind !== "timer") return;
    const endsAt = (w.state as TimerState).endsAt;
    const cur = this.#timers.get(w.id);
    if (cur?.endsAt === endsAt) return;
    this.#clear(w.id);
    if (typeof endsAt !== "number") return;
    const timer = setTimeout(() => this.#fire(w.id, endsAt), Math.min(MAX_WAIT, Math.max(0, endsAt - Date.now())));
    timer.unref();
    this.#timers.set(w.id, { endsAt, timer });
  }

  #fire(id: WindowId, endsAt: number): void {
    this.#timers.delete(id);
    const w = this.#windows.list().find((x) => x.id === id);
    if (!w || (w.state as TimerState).endsAt !== endsAt) return;
    if (endsAt > Date.now() + 1000) return this.#sync(w); // waited MAX_WAIT; more to go
    // A timer that ended long ago (the Mac slept, cmd wasn't running) still rings once.
    const late = Date.now() - endsAt > 60_000;
    const updated = this.#windows.update(id, { state: { action: "ring" } });
    const s = updated.state as TimerState;
    this.#ring(updated, `${durationLabel(s.duration)} timer · done`, late ? `Ended at ${new Date(endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Time's up");
  }

  #clear(id: WindowId): void {
    const cur = this.#timers.get(id);
    if (cur) clearTimeout(cur.timer);
    this.#timers.delete(id);
  }

  close(): void {
    for (const id of [...this.#timers.keys()]) this.#clear(id);
  }
}
