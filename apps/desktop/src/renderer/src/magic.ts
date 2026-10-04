// Live progress of Magic windows (docs/14-magic-v2.md), from the core's
// magic.stream / magic.data events. Kept out of the main store: progress and
// refreshes re-render only the window they belong to.

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
  /** The latest data run. */
  data?: { data: unknown; at: number; error?: string };
}

const EMPTY: MagicLive = { running: false, steps: [] };
const live = new Map<WindowId, MagicLive>();
const listeners = new Map<WindowId, Set<() => void>>();

function set(id: WindowId, next: MagicLive): void {
  live.set(id, next);
  for (const fn of listeners.get(id) ?? []) fn();
}

export function handleMagicEvent(e: Extract<CoreEvent, { type: "magic.stream" | "magic.data" }>): void {
  const cur = live.get(e.id) ?? EMPTY;
  if (e.type === "magic.data") {
    set(e.id, { ...cur, data: e.error ? { data: cur.data?.data, at: cur.data?.at ?? e.at, error: e.error } : { data: e.data, at: e.at } });
    return;
  }
  const p = e.progress;
  // A new run's first event resets what the last one left.
  const base = cur.running ? cur : { ...EMPTY, running: true, data: cur.data };
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
  const cur = live.get(id);
  set(id, { ...EMPTY, running: true, data: cur?.data });
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

/** Choices for a widget's refresh interval, in seconds (0: only on Refresh Now). */
export const REFRESH_CHOICES = [2, 5, 10, 30, 60, 300, 900, 3600, 0];

export function intervalLabel(s: number): string {
  const [n, unit] = s % 3600 === 0 ? [s / 3600, "Hour"] : s % 60 === 0 ? [s / 60, "Minute"] : [s, "Second"];
  return s === 0 ? "Never" : `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** The interval choices including the current one (the model may have picked 3 s). */
export function refreshChoices(cur: number): number[] {
  return REFRESH_CHOICES.includes(cur) ? REFRESH_CHOICES : [...REFRESH_CHOICES.slice(0, -1), cur].sort((x, y) => x - y).concat(0);
}
