// Scoring a written day (docs/28 §6, D3; docs/24 "Not yet"): checks a model's
// answer against the digest it was given, before the writer's fallbacks hide
// what it skipped, so a prompt or rule change is measured instead of eyeballed.
// Deterministic: the same answer always scores the same. `scripts/evals/journal.ts`
// runs it over a corpus of real days (kept out of the repo) and the fixture day.

import type { WrittenDay } from "./writer.ts";
import { ENTRY_KINDS, OUTCOMES } from "./writer.ts";

/** One day to write: the digest the model gets, and what a good answer must do. */
export interface JournalCase {
  name: string;
  digest: string;
  /** Refs of threads that aren't minor, by group: every group must be in some entry. */
  groups: string[][];
  /** Refs of minor threads (allowed in entries, never required). */
  minor: string[];
  /** Words a good day mentions somewhere (titles, summaries, headline), case-insensitive. */
  mention?: string[];
  /** Bounds on the number of entries. */
  entries?: [number, number];
}

export interface Score {
  /** 0–1, the mean of the checks. */
  score: number;
  checks: Record<string, number>;
  problems: string[];
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export function scoreDay(c: JournalCase, w: WrittenDay): Score {
  const problems: string[] = [];
  const known = new Set([...c.groups.flat(), ...c.minor]);
  const entries = Array.isArray(w?.entries) ? w.entries : [];
  const refs = entries.flatMap((e) => (Array.isArray(e.refs) ? e.refs : []));
  // Refs the model made up.
  const bad = refs.filter((r) => !known.has(r));
  if (bad.length) problems.push(`unknown refs: ${[...new Set(bad)].join(", ")}`);
  const validRefs = refs.length ? 1 - bad.length / refs.length : 0;
  // Every group in some entry (the writer would add the missing ones from data; that's the fallback, not the model).
  const used = new Set(refs);
  const missing = c.groups.filter((g) => !g.some((r) => used.has(r)));
  if (missing.length) problems.push(`groups left out: ${missing.map((g) => g.join("+")).join(", ")}`);
  const coverage = c.groups.length ? 1 - missing.length / c.groups.length : 1;
  // Titles 2–4 words, summaries at most 40, the headline at most 25; kinds and outcomes from the lists.
  const titles = entries.filter((e) => typeof e.title === "string" && words(e.title) >= 2 && words(e.title) <= 4 && !/\.$/.test(e.title.trim())).length;
  for (const e of entries) if (!(words(e.title ?? "") >= 2 && words(e.title ?? "") <= 4)) problems.push(`title "${e.title}" isn't 2–4 words`);
  const summaries = entries.filter((e) => typeof e.summary === "string" && words(e.summary) > 0 && words(e.summary) <= 40).length;
  const kinds = entries.filter((e) => (ENTRY_KINDS as string[]).includes(e.kind) && (e.outcome === null || (OUTCOMES as string[]).includes(e.outcome))).length;
  const headline = typeof w?.headline === "string" && words(w.headline) > 0 && words(w.headline) <= 25 ? 1 : 0;
  if (!headline) problems.push("headline missing or over 25 words");
  const n = entries.length || 1;
  // What the day must mention.
  const text = [w?.headline ?? "", ...entries.flatMap((e) => [e.title ?? "", e.summary ?? ""])].join(" ").toLowerCase();
  const mention = c.mention?.length ? c.mention.filter((m) => text.includes(m.toLowerCase())).length / c.mention.length : 1;
  for (const m of c.mention ?? []) if (!text.includes(m.toLowerCase())) problems.push(`doesn't mention "${m}"`);
  const [lo, hi] = c.entries ?? [1, Number.MAX_SAFE_INTEGER];
  const count = entries.length >= lo && entries.length <= hi ? 1 : 0;
  if (!count) problems.push(`${entries.length} entries, expected ${lo}–${hi}`);
  const checks = { validRefs, coverage, titles: titles / n, summaries: summaries / n, kinds: kinds / n, headline, mention, count };
  const vals = Object.values(checks);
  return { score: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000, checks, problems };
}
