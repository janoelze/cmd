// The macOS login session a process belongs to. The core and the PTY host
// outlive the app on purpose, and so can outlive a logout: they then keep the
// old session's Mach bootstrap namespace, where system services can't be
// looked up any more, and so does every shell they start (no DNS, pasteboard
// or keychain: `scutil --dns` says "No DNS configuration available"). A
// process can't read another's audit session, but each login starts its own
// loginwindow, run as the user: what started before it is from an earlier login.

import { execFile } from "node:child_process";

/** Rounding of `ps` start times (whole seconds), and then some. */
const SLACK_MS = 2000;

/** A `ps` elapsed time, `[[dd-]hh:]mm:ss`, in ms; null when it isn't one. */
export function parseEtime(s: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  const [, d = "0", h = "0", min, sec] = m;
  return (((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec)) * 1000;
}

export interface Proc {
  pid: number;
  /** Effective uid. */
  uid: number;
  /** Epoch ms. */
  startedAt: number;
  command: string;
}

/** Processes from `ps -ax -o pid=,uid=,etime=,comm=` output, taken at `now`. */
export function parsePs(out: string, now: number): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const [, pid, uid, etime = "", command = ""] = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line) ?? [];
    const elapsed = parseEtime(etime);
    if (pid && elapsed !== null) procs.push({ pid: Number(pid), uid: Number(uid), startedAt: now - elapsed, command: command.trim() });
  }
  return procs;
}

/**
 * When the current login session started: the start of `uid`'s loginwindow
 * (its effective uid; its real uid is root's, so `ps -x` doesn't list it).
 */
export function loginOf(procs: Proc[], uid = process.getuid?.() ?? -1): number | null {
  const lw = procs.filter((p) => p.uid === uid && /(^|\/)loginwindow$/.test(p.command));
  return lw.length ? Math.max(...lw.map((p) => p.startedAt)) : null;
}

/** Whether a process that started at `startedAt` is from an earlier login than the one that started at `login`. */
export function fromEarlierLogin(startedAt: number, login: number | null): boolean {
  return login !== null && startedAt < login - SLACK_MS;
}

/** Every process; empty where `ps` can't run (not macOS, a sandbox). */
export function allProcs(): Promise<Proc[]> {
  if (process.platform !== "darwin") return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      execFile("/bin/ps", ["-ax", "-o", "pid=,uid=,etime=,comm="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? [] : parsePs(out, Date.now())));
    } catch {
      resolve([]); // a sandbox refuses the spawn itself (EPERM)
    }
  });
}

/**
 * Whether process `pid`, or one that started at `startedAt`, is from an
 * earlier login than this one. False when unknown: no loginwindow (no GUI
 * login, not macOS) or no `ps`.
 */
export async function staleSession(p: { pid: number } | { startedAt: number }): Promise<boolean> {
  const procs = await allProcs();
  const startedAt = "startedAt" in p ? p.startedAt : procs.find((q) => q.pid === p.pid)?.startedAt;
  return startedAt !== undefined && fromEarlierLogin(startedAt, loginOf(procs));
}
