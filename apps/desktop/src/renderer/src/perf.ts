// Counters for performance work (docs/14-performance.md): renders of the heavy
// components and store events by type, read by e2e/perf.mjs as window.__cmdPerf.
// Plain integer increments, so they stay in production builds.

export const perf = {
  renders: {} as Record<string, number>,
  events: {} as Record<string, number>,
  /** Store notifications (each may re-render subscribers). */
  sets: 0,
};

(window as unknown as { __cmdPerf: typeof perf }).__cmdPerf = perf;

/** Call at the top of a component's body. */
export function countRender(name: string): void {
  perf.renders[name] = (perf.renders[name] ?? 0) + 1;
}

export function countEvent(type: string): void {
  perf.events[type] = (perf.events[type] ?? 0) + 1;
}
