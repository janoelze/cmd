// The core's health for the sidebar footer: connection, whether it runs this
// app's code, how fast it answers, and what it and the PTY host use. Polled
// while the window is visible; faster while the details are open.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { CoreInfo, ProcessStat } from "@cmd/protocol";
import { cmd } from "./bridge.ts";

export interface CoreHealth {
  info: CoreInfo | null;
  core: ProcessStat | null;
  ptyHost: ProcessStat | null;
  /** Round trip of the last core.info in ms; null while it hasn't answered. */
  latency: number | null;
  /** The core runs other code than this app (restart it to pick the changes up). */
  outdated: boolean;
  /** The last poll got no answer in time. */
  unresponsive: boolean;
}

const POLL_MS = 5000;
const POLL_OPEN_MS = 1500;
const TIMEOUT_MS = 2000;
/** Slower answers than this count as a struggling core. */
export const SLOW_MS = 500;

const EMPTY: CoreHealth = { info: null, core: null, ptyHost: null, latency: null, outdated: false, unresponsive: false };

export function useCoreHealth(connected: boolean, open: boolean): CoreHealth {
  const [health, setHealth] = useState<CoreHealth>(EMPTY);
  const [build, setBuild] = useState<string | null>(null);

  useEffect(() => void cmd.appInfo().then((a) => setBuild(a.build)), []);

  useEffect(() => {
    if (!connected) {
      setHealth(EMPTY);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight = false;
    const tick = async () => {
      if (inflight) return;
      clearTimeout(timer);
      if (document.visibilityState === "visible" || open) {
        inflight = true;
        const t0 = performance.now();
        let latency: number | null = null;
        const timeout = new Promise<null>((r) => setTimeout(() => r(null), TIMEOUT_MS));
        const [info, procs] = await Promise.all([
          Promise.race([cmd.call("core.info", {}).then((i) => ((latency = Math.round(performance.now() - t0)), i), () => null), timeout]),
          // CPU% is over the time since anyone last asked (the Task Manager asks too).
          Promise.race([cmd.call("core.processes", {}).catch(() => null), timeout]),
        ]);
        inflight = false;
        if (!live) return;
        setHealth((h) => ({
          info: info ?? h.info,
          core: procs ? procs.core : h.core,
          ptyHost: procs ? procs.ptyHost : h.ptyHost,
          latency,
          outdated: !!info && !!build && info.build !== build,
          unresponsive: !info,
        }));
      }
      if (live) timer = setTimeout(tick, open ? POLL_OPEN_MS : POLL_MS);
    };
    void tick();
    const onVisible = () => document.visibilityState === "visible" && void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connected, open, build]);

  return health;
}

// ── restart ──────────────────────────────────────────────
// One restart at a time, shared by the footer and the Restart Core command.
// Terminals keep running in the PTY host: nothing to confirm.

let restarting = false;
let restartError: string | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

export async function restartCore(): Promise<void> {
  if (restarting) return;
  restarting = true;
  restartError = null;
  changed();
  try {
    await cmd.restartCore();
  } catch (err) {
    restartError = (err as Error).message;
  } finally {
    restarting = false;
    changed();
  }
}

let snapshot: { restarting: boolean; error: string | null } = { restarting, error: restartError };
export function useRestart(): { restarting: boolean; error: string | null } {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => (snapshot.restarting === restarting && snapshot.error === restartError ? snapshot : (snapshot = { restarting, error: restartError })),
  );
}

/** "12s", "4m", "2h 5m", "3d 4h". */
export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
