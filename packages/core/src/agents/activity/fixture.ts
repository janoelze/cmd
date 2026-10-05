// Recorded sessions as test fixtures: one JSON line per hook event as the agent
// sent it ({ms, agent, name, env, payload}, ms from the first event), with paths
// rewritten so no user's home or temp dirs are checked in. Written by
// `cmd agents record` (or test/fixtures/agents/record.ts from a spool folder);
// tests replay them through normalize and reduce.

import type { ActivityEvent } from "@cmd/protocol";
import { HOME_ENV, type RawEvent } from "./normalize.ts";

/** Fixtures' events start here (any fixed time works). */
export const FIXTURE_EPOCH = 1_800_000_000_000;

/** Replaces each `from` (longest first) in every string of `v`. */
function rewrite(v: unknown, subs: [string, string][]): unknown {
  if (typeof v === "string") return subs.reduce((s, [from, to]) => s.split(from).join(to), v);
  if (Array.isArray(v)) return v.map((x) => rewrite(x, subs));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x, subs)]));
  return v;
}

/** `subs`: path → placeholder, e.g. the work dir → "/work/repo", the home dir → "/Users/me". */
export function toFixture(events: RawEvent[], subs: Record<string, string> = {}): string {
  const pairs = Object.entries(subs).sort((a, b) => b[0].length - a[0].length);
  const t0 = events[0]?.at ?? 0;
  return events.map((e) => JSON.stringify(rewrite({ ms: Math.round(e.at - t0), agent: e.agent, name: e.name, ...(e.env ? { env: e.env } : {}), payload: e.payload }, pairs))).join("\n") + "\n";
}

export function readFixture(text: string): RawEvent[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const f = JSON.parse(l) as { ms: number; agent: string | null; name: string; env?: Record<string, string>; payload: Record<string, unknown> };
      return { at: FIXTURE_EPOCH + f.ms, agent: f.agent, name: f.name, payload: f.payload, ...(f.env ? { env: f.env } : {}) };
    });
}

/** Raw events back from the log (agent.events with raw: true); core notes are left out. */
export function rawFromLog(events: ActivityEvent[]): RawEvent[] {
  return events
    .filter((e) => e.source === "hook" && e.raw)
    .map((e) => {
      const name = e.agent ? HOME_ENV[e.agent] : undefined;
      return { at: e.at, agent: e.agent, name: e.name, payload: e.raw!, ...(e.home && name ? { env: { [name]: e.home } } : {}) };
    });
}
