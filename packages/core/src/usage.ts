// Anonymous usage stats: counters of a few events (app launches, windows opened
// by type, agents started by kind, crashes and internal errors by process;
// crashes are recorded by every process, see countForUsage), sent once a minute with the app version,
// macOS version, processor type and the install's random machineId (the one
// crash reports use). Only names from the fixed lists below are counted, never
// paths, commands, titles or anything typed; the totals are public at
// endtime-instruments.org/cmd/usage (website/). Batches without events are
// skipped, except one a day so an idle install still counts as active. Release
// builds send; development builds only when $CMD_USAGE_URL is set, and nothing
// does when it is "off" (CI and e2e, whose fresh CMD_HOMEs look like new installs). The
// `diagnostics.usageStats` setting turns it off. The server can slow senders
// down (429 or 503 with Retry-After) or stop them (410, until the core restarts).
// Release builds sign each batch with a key of their version (baked into the
// app, see electron.vite.config.ts) so the server can turn away batches that
// didn't come from a release; it can't prove more than that, since the key is
// in the app.

import { createHmac } from "node:crypto";
import os from "node:os";
import { logger, takeUsageCounts } from "@cmd/protocol/node";

export const USAGE_URL = "https://endtime-instruments.org/cmd/usage/ingest.php";

const WINDOW_KINDS: ReadonlySet<string> = new Set(["terminal", "browser", "files", "text", "markdown", "magic"]);
const AGENT_KINDS: ReadonlySet<string> = new Set(["claude", "codex", "gemini", "opencode", "qwen", "copilot"]);
const INTERVAL_MS = 60_000;
const TIMEOUT_MS = 5_000;
const BACKOFF_MS = 10 * 60_000;
/** Crash counts from other processes (crash.<process>, error), checked before they're sent on. */
const CRASH_NAME = /^(crash\.[a-z]+|error)$/;

const log = logger("usage");

export interface UsageOptions {
  /** Where batches go; null: nothing is counted or sent. */
  url: string | null;
  /** The version's key: batches carry an HMAC of their body in x-cmd-signature. Null: unsigned. */
  key?: string | null;
  enabled: () => boolean;
  /** The install's random id (machineId); null: can't send. */
  id: () => string | null;
  version: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** 0: no timer, flush() is called by hand (tests). */
  intervalMs?: number;
  /** Crash counts recorded since the last call (default: takeUsageCounts). */
  crashes?: () => Record<string, number>;
}

export interface UsageBatch {
  v: 1;
  id: string;
  version: string;
  os: string;
  arch: string;
  counts: Record<string, number>;
}

export class UsageStats {
  #o: UsageOptions;
  #counts = new Map<string, number>();
  /** UTC day of the last batch sent. */
  #sentDay: string | null = null;
  #sending = false;
  /** Retry-After from the server. */
  #pausedUntil = 0;
  /** 410 from the server: no more batches from this core. */
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(o: UsageOptions) {
    this.#o = o;
    const ms = o.intervalMs ?? INTERVAL_MS;
    if (o.url && ms > 0) {
      this.#timer = setInterval(() => void this.flush(), ms);
      this.#timer.unref();
    }
  }

  launch(): void {
    this.#add("app.launch");
  }

  window(kind: string): void {
    this.#add(`window.${WINDOW_KINDS.has(kind) ? kind : "other"}`);
  }

  agent(kind: string): void {
    this.#add(`agent.${AGENT_KINDS.has(kind) ? kind : "other"}`);
  }

  /** Send what was counted; true when a batch went out. */
  async flush(): Promise<boolean> {
    const { url } = this.#o;
    if (!url || this.#sending || this.#stopped) return false;
    const crashes = (this.#o.crashes ?? takeUsageCounts)();
    if (!this.#o.enabled()) {
      this.#counts.clear();
      return false;
    }
    for (const [k, n] of Object.entries(crashes)) if (CRASH_NAME.test(k)) this.#counts.set(k, (this.#counts.get(k) ?? 0) + n);
    const now = (this.#o.now ?? Date.now)();
    if (now < this.#pausedUntil) return false;
    const day = new Date(now).toISOString().slice(0, 10);
    if (!this.#counts.size && this.#sentDay === day) return false;
    const id = this.#o.id();
    if (!id) return false;
    const counts = Object.fromEntries(this.#counts);
    this.#counts.clear();
    const batch: UsageBatch = { v: 1, id, version: this.#o.version, os: macosVersion(), arch: process.arch, counts };
    const body = JSON.stringify(batch);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#o.key) headers["x-cmd-signature"] = createHmac("sha256", this.#o.key).update(body).digest("hex");
    this.#sending = true;
    try {
      const res = await (this.#o.fetch ?? fetch)(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 410) {
        log.info("the usage stats server asked to stop");
        this.#stopped = true;
        this.#counts.clear();
        return false;
      }
      if (res.status === 429 || res.status === 503) {
        const after = Number(res.headers.get("retry-after"));
        this.#pausedUntil = now + (Number.isFinite(after) && after > 0 ? after * 1000 : BACKOFF_MS);
        throw new Error(`HTTP ${res.status}, again in ${Math.round((this.#pausedUntil - now) / 1000)} s`);
      }
      if (res.status >= 400 && res.status < 500) {
        log.warn(`batch rejected: HTTP ${res.status}`); // retrying won't help: drop it
        return false;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.#sentDay = day;
      return true;
    } catch (err) {
      // Offline or the server is down: keep the counts for the next minute.
      for (const [k, n] of Object.entries(counts)) this.#counts.set(k, (this.#counts.get(k) ?? 0) + n);
      log.debug(`not sent: ${(err as Error).message}`);
      return false;
    } finally {
      this.#sending = false;
    }
  }

  close(): void {
    clearInterval(this.#timer);
  }

  #add(key: string): void {
    if (!this.#o.url || !this.#o.enabled()) return;
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
  }
}

/** "26" for macOS 26: from the Darwin major (20 = macOS 11 … 24 = macOS 15, then 25 = macOS 26). */
export function macosVersion(platform: string = process.platform, release: string = os.release()): string {
  const d = Number.parseInt(release, 10);
  if (platform !== "darwin" || !Number.isFinite(d)) return platform;
  return String(d >= 25 ? d + 1 : d - 9);
}
