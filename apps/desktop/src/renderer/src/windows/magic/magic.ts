// Live progress of Magic builds (docs/56, "Magic on V3"), from the core's magic.stream
// events. Kept out of the main store: progress re-renders only the window it belongs to.

import { useSyncExternalStore } from "react";
import type { CoreEvent, MagicStep, WindowId } from "@cmd/protocol";

export interface MagicLive {
  /** A run is going (since magic.run, until done or error). */
  running: boolean;
  steps: MagicStep[];
  /** The widget's title, once the agent wrote its manifest. */
  title?: string;
  /** cmd is checking the result (after the agent finished a turn). */
  verifying?: boolean;
  /** What cmd's check sent back to the agent. */
  repair?: string;
}

const EMPTY: MagicLive = { running: false, steps: [] };
const live = new Map<WindowId, MagicLive>();
const listeners = new Map<WindowId, Set<() => void>>();

function set(id: WindowId, next: MagicLive): void {
  live.set(id, next);
  for (const fn of listeners.get(id) ?? []) fn();
}

export function handleMagicEvent(e: Extract<CoreEvent, { type: "magic.stream" }>): void {
  const cur = live.get(e.id) ?? EMPTY;
  const p = e.progress;
  // A new run's first event resets what the last one left.
  const base = cur.running ? cur : { ...EMPTY, running: true };
  switch (p.type) {
    case "step": {
      const steps = [...base.steps];
      const i = steps.findIndex((s) => s.id === p.step.id);
      if (i >= 0) steps[i] = p.step;
      else steps.push(p.step);
      set(e.id, { ...base, steps, verifying: false });
      return;
    }
    case "title":
      set(e.id, { ...base, title: p.title });
      return;
    case "verify":
      set(e.id, { ...base, verifying: true });
      return;
    case "repair":
      set(e.id, { ...base, repair: p.reason, verifying: false });
      return;
    case "done":
    case "error":
      set(e.id, { ...cur, running: false, verifying: false });
      return;
  }
}

/** Forget a window's progress (a new run starts). */
export function resetMagic(id: WindowId): void {
  set(id, { ...EMPTY, running: true });
}

export function useMagicLive(id: WindowId): MagicLive {
  return useSyncExternalStore(
    (fn) => {
      let set = listeners.get(id);
      if (!set) listeners.set(id, (set = new Set()));
      set.add(fn);
      return () => void set!.delete(fn);
    },
    () => live.get(id) ?? EMPTY,
  );
}
