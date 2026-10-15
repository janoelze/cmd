// Per-pane resource usage: memory and CPU of each terminal's whole process tree
// (shell, agent, and everything they spawned), sampled by the procinfo helper.

import type { PaneUsage, ProcessStat } from "@cmd/protocol";
import type { ProcUsage, TreeUsage } from "../agents/procinfo.ts";
import { classify } from "../agents/procinfo.ts";
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
  #soon: NodeJS.Timeout | undefined;
  #prev = new Map<number, { cpu: number; at: number }>();
  #busy = false;

  #watched: () => boolean;

  /** watched: whether any UI could show the samples (the status bar, the Task Manager); none are taken while not. */
  constructor(panes: PaneManager, sample: TreeSampler, intervalMs = 2000, watched: () => boolean = () => true) {
    this.#panes = panes;
    this.#sample = sample;
    this.#watched = watched;
    if (intervalMs > 0) {
      this.#timer = setInterval(() => void this.tick(), intervalMs);
      this.#timer.unref();
    }
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.#busy || !this.#watched()) return;
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

  /** A sample shortly, not at the next tick: a new terminal, or a UI that starts showing them. */
  soon(delayMs = 250): void {
    if (this.#soon) return;
    this.#soon = setTimeout(() => {
      this.#soon = undefined;
      void this.tick();
    }, delayMs);
    this.#soon.unref();
  }

  close(): void {
    clearInterval(this.#timer);
    clearTimeout(this.#soon);
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

/** CPU and memory of a group of processes. */
export type ProcessUse = { cpu: number; memory: number };
/** cmd's own use (a widget's app.usage): the app's processes, and the background ones (the core and the PTY host). */
export type OwnUse = { app: ProcessUse | null; background: ProcessUse | null; at: number };

/** A sample of cmd's own use this recent is answered again (the widget topic and the verb share it). */
const OWN_FRESH_MS = 1500;
/** CPU% needs two samples: without one this recent, a first is taken and the answer waits this long for the second. */
const OWN_PRIME_AFTER_MS = 10_000;
const OWN_PRIME_MS = 400;

/**
 * Usage of single processes (the core, the PTY host) for the Task Manager,
 * sampled when asked; CPU% is over the time since the previous ask. With a
 * tree sampler, also cmd's own use as the Task Manager adds it up (own()):
 * the app's process tree (the app tells its pid, app.attach) and the
 * background processes.
 */
export class ProcessSampler {
  #sample: ProcSampler;
  #trees: TreeSampler | null;
  #prev = new Map<number, { cpu: number; at: number }>();
  #prevTree = new Map<number, { cpu: number; at: number }>();
  #own: { at: number; value: Promise<OwnUse> } | null = null;
  /** The app's main process, as it said when it connected (null: no app has). */
  app: number | null = null;

  constructor(sample: ProcSampler, trees: TreeSampler | null = null) {
    this.#sample = sample;
    this.#trees = trees;
  }

  /** The app's main process (app.attach). */
  attach(pid: number): void {
    this.app = Number.isInteger(pid) && pid > 0 ? pid : null;
    this.#own = null;
  }

  /** cmd's own use now: `host` is the PTY host's pid. Shared by callers within OWN_FRESH_MS; the first ever waits a moment for CPU%. */
  own(host: number | null, now = Date.now()): Promise<OwnUse> {
    if (this.#own && now - this.#own.at < OWN_FRESH_MS) return this.#own.value;
    const primed = this.#own && now - this.#own.at < OWN_PRIME_AFTER_MS;
    const value = (async () => {
      if (!primed) {
        await this.#ownNow(host, Date.now());
        await new Promise((r) => setTimeout(r, OWN_PRIME_MS));
      }
      return this.#ownNow(host, Date.now());
    })();
    this.#own = { at: now, value };
    value.catch(() => this.#own?.value === value && (this.#own = null));
    return value;
  }

  async #ownNow(host: number | null, now: number): Promise<OwnUse> {
    const pids = host ? [process.pid, host] : [process.pid];
    const procs = await this.sample(pids, now);
    const background = procs.size ? [...procs.values()].reduce<ProcessUse>((t, p) => ({ cpu: t.cpu + p.cpu, memory: t.memory + p.memory }), { cpu: 0, memory: 0 }) : null;
    let app: ProcessUse | null = null;
    if (this.app && this.#trees) {
      // The app started this core (its parent): its tree holds the core's, terminals and all, which aren't the app's.
      const nested = process.ppid === this.app;
      const trees = new Map((await this.#trees(nested ? [this.app, process.pid] : [this.app])).map((t) => [t.pid, t]));
      const use = (pid: number): ProcessUse | null => {
        const t = trees.get(pid);
        if (!t) return null;
        const cpu = cpuPercent(this.#prevTree.get(pid), t.cpu, now);
        this.#prevTree.set(pid, { cpu: t.cpu, at: now });
        return { cpu, memory: t.mem };
      };
      const whole = use(this.app);
      const inner = nested ? use(process.pid) : null;
      if (whole) app = { cpu: Math.max(0, Math.round((whole.cpu - (inner?.cpu ?? 0)) * 10) / 10), memory: Math.max(0, whole.memory - (inner?.memory ?? 0)) };
      else this.app = null; // the app is gone
    }
    return { app, background: background && { cpu: Math.round(background.cpu * 10) / 10, memory: background.memory }, at: now };
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
