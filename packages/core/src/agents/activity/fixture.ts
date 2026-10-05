// Recorded sessions as test fixtures: a header line ({fixture: FIXTURE_FORMAT,
// agent, agentVersion, recordedBy, hook, …}: what recorded it), then one JSON line
// per hook event as the agent sent it ({ms, agent, name, env, payload}, ms from
// the first event), with paths rewritten so no user's home or temp dirs are checked in. Written by
// `cmd agents record` (or test/fixtures/agents/record.ts from a spool folder);
// tests replay them through normalize and reduce.

import type { ActivityEvent } from "@cmd/protocol";
import { HOME_ENV, type RawEvent } from "./normalize.ts";

export const FIXTURE_FORMAT = 1;

/** What a fixture says about itself (its first line). */
export interface FixtureMeta {
  agent: string | null;
  agentVersion: string | null;
  /** The cmd that recorded it (ActivityEvent.recorded.cmd), or how ("claude -p --settings …"). */
  recordedBy: string | null;
  /** The hook record format. */
  hook: number | null;
  [more: string]: unknown;
}

/** Fixtures' events start here (any fixed time works). */
export const FIXTURE_EPOCH = 1_800_000_000_000;

/** Replaces each `from` (longest first) in every string of `v`. */
export function rewrite(v: unknown, subs: [string, string][]): unknown {
  if (typeof v === "string") return subs.reduce((s, [from, to]) => s.split(from).join(to), v);
  if (Array.isArray(v)) return v.map((x) => rewrite(x, subs));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x, subs)]));
  return v;
}

/** `subs`: path → placeholder, e.g. the work dir → "/work/repo", the home dir → "/Users/me". */
export function toFixture(events: RawEvent[], subs: Record<string, string> = {}, meta?: FixtureMeta): string {
  const pairs = Object.entries(subs).sort((a, b) => b[0].length - a[0].length);
  const t0 = events[0]?.at ?? 0;
  const head = meta ? [JSON.stringify(rewrite({ fixture: FIXTURE_FORMAT, ...meta }, pairs))] : [];
  return [...head, ...events.map((e) => JSON.stringify(rewrite({ ms: Math.round(e.at - t0), agent: e.agent, name: e.name, ...(e.hook ? { hook: e.hook } : {}), ...(e.env ? { env: e.env } : {}), payload: e.payload }, pairs)))].join("\n") + "\n";
}

/** A fixture's header, if it has one. */
export function fixtureMeta(text: string): FixtureMeta | null {
  const first = text.split("\n").find((l) => l.trim());
  const o = first ? (JSON.parse(first) as Record<string, unknown>) : null;
  return o && typeof o.fixture === "number" ? (o as unknown as FixtureMeta) : null;
}

export function readFixture(text: string): RawEvent[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { fixture?: number; ms: number; agent: string | null; name: string; hook?: number; env?: Record<string, string>; payload: Record<string, unknown> })
    .filter((f) => f.fixture === undefined)
    .map((f) => ({ at: FIXTURE_EPOCH + f.ms, agent: f.agent, name: f.name, payload: f.payload, ...(f.hook ? { hook: f.hook } : {}), ...(f.env ? { env: f.env } : {}) }));
}

/** Raw events back from the log (agent.events with raw: true); core notes are left out. */
export function rawFromLog(events: ActivityEvent[]): RawEvent[] {
  return events
    .filter((e) => e.source === "hook" && e.raw)
    .map((e) => {
      const name = e.agent ? HOME_ENV[e.agent] : undefined;
      return { at: e.at, agent: e.agent, name: e.name, payload: e.raw!, ...(e.recorded?.hook ? { hook: e.recorded.hook } : {}), ...(e.home && name ? { env: { [name]: e.home } } : {}) };
    });
}
