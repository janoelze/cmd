// Live progress of Magic windows (docs/12-magic-windows.md), from the core's
// magic.stream / magic.data events. Kept out of the main store: streaming
// bodies and refreshes re-render only the window they belong to.

import { useSyncExternalStore } from "react";
import type { CoreEvent, MagicStep, WindowId } from "@cmd/protocol";

export interface MagicLive {
  /** A run is streaming (since the first event after magic.run). */
  running: boolean;
  steps: MagicStep[];
  header?: { title: string; loading: string[]; kind: "widget" | "terminal"; size: string };
  /** The widget body so far. */
  body?: string;
  repair?: string;
  /** The latest refresh of the data source. */
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
  switch (p.type) {
    case "step": {
      const steps = cur.running ? [...cur.steps] : [];
      const i = steps.findIndex((s) => s.id === p.step.id);
      if (i >= 0) steps[i] = p.step;
      else steps.push(p.step);
      // A new run's first event resets what the last one left.
      set(e.id, cur.running ? { ...cur, steps } : { running: true, steps, data: cur.data });
      return;
    }
    case "header":
      set(e.id, { ...(cur.running ? cur : { ...EMPTY, data: cur.data }), running: true, header: { title: p.title, loading: p.loading, kind: p.kind, size: p.size }, body: undefined });
      return;
    case "body":
      set(e.id, { ...cur, running: true, body: p.html });
      return;
    case "repair":
      set(e.id, { ...cur, running: true, repair: p.reason, body: undefined });
      return;
    case "done":
    case "error":
      set(e.id, { ...cur, running: false });
      return;
  }
}

/** Forget a window's progress (it was closed, or a new run starts). */
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
