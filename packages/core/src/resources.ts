// Per-pane resource usage: memory and CPU of each terminal's whole process tree
// (shell, agent, and everything they spawned), sampled by the procinfo helper.

import type { PaneUsage, ProcessStat } from "@cmd/protocol";
import type { ProcUsage, TreeUsage } from "./agents/procinfo.ts";
import { classify } from "./agents/procinfo.ts";
import type { PaneManager } from "./panes.ts";

export type TreeSampler = (pids: number[]) => Promise<TreeUsage[]>;
export type ProcSampler = (pids: number[]) => Promise<ProcUsage[]>;

/** CPU% between two samples of cumulative CPU time (ns); 100% = one full core (like Activity Monitor). */
function cpuPercent(prev: { cpu: number; at: number } | undefined, cpu: number, now: number): number {
  const pct = prev && now > prev.at ? Math.max(0, ((cpu - prev.cpu) / ((now - prev.at) * 1e6)) * 100) : 0;
  return Math.round(pct * 10) / 10;
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Friendly process name: agents by their kind (Claude's binary is named after its version). */
export function processName(name: string, path: string): string {
  const c = classify({ path, argv: [name] });
  return c.kind === "agent" ? c.agent : name || basename(path);
}

export class ResourceMonitor {
  #panes: PaneManager;
  #sample: TreeSampler;
  #timer: NodeJS.Timeout | undefined;
  #prev = new Map<number, { cpu: number; at: number }>();
  #busy = false;

  constructor(panes: PaneManager, sample: TreeSampler, intervalMs = 2000) {
    this.#panes = panes;
    this.#sample = sample;
    if (intervalMs > 0) {
      this.#timer = setInterval(() => void this.tick(), intervalMs);
      this.#timer.unref();
    }
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const panes = this.#panes.list().filter((p) => p.exitCode === null && p.pid > 0);
      const results = await this.#sample(panes.map((p) => p.pid));
      const byPid = new Map(results.map((r) => [r.pid, r]));
      const seen = new Set<number>();
      for (const pane of panes) {
        const r = byPid.get(pane.pid);
        if (!r) continue;
        seen.add(pane.pid);
        const prev = this.#prev.get(pane.pid);
        const cpu = cpuPercent(prev, r.cpu, now);
        this.#prev.set(pane.pid, { cpu: r.cpu, at: now });
        const usage: PaneUsage = {
          memory: r.mem,
          cpu,
          processes: r.procs,
          top: r.top.map((t) => ({ pid: t.pid, name: processName(t.name, t.path), memory: t.mem })),
          sampledAt: now,
        };
        this.#panes.setUsage(pane.id, usage);
      }
      for (const pid of this.#prev.keys()) if (!seen.has(pid)) this.#prev.delete(pid);
    } finally {
      this.#busy = false;
    }
  }

  close(): void {
    clearInterval(this.#timer);
  }
}

/** Whether a new sample differs enough from the last to be worth broadcasting. */
export function usageChanged(a: PaneUsage | null, b: PaneUsage): boolean {
  if (!a) return true;
  return (
    Math.abs(a.memory - b.memory) >= 1024 * 1024 ||
    Math.abs(a.cpu - b.cpu) >= 1 ||
    a.processes !== b.processes ||
    a.top[0]?.name !== b.top[0]?.name
  );
}

/**
 * Usage of single processes (the core, the PTY host) for the Task Manager,
 * sampled when asked; CPU% is over the time since the previous ask.
 */
export class ProcessSampler {
  #sample: ProcSampler;
  #prev = new Map<number, { cpu: number; at: number }>();

  constructor(sample: ProcSampler) {
    this.#sample = sample;
  }

  async sample(pids: number[], now = Date.now()): Promise<Map<number, ProcessStat>> {
    const out = new Map<number, ProcessStat>();
    for (const r of await this.#sample(pids)) {
      out.set(r.pid, { pid: r.pid, memory: r.mem, cpu: cpuPercent(this.#prev.get(r.pid), r.cpu, now) });
      this.#prev.set(r.pid, { cpu: r.cpu, at: now });
    }
    for (const pid of this.#prev.keys()) if (!out.has(pid)) this.#prev.delete(pid);
    return out;
  }
}
