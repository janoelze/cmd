// Weeks (docs/23 "Next" 5): a week is its days' entries rolled up into a few
// themes and a headline ("This week: v0.11 to v0.14.4, sidebars, summaries,
// drag and drop"). Written by a model from the days already written (titles,
// kinds, outcomes, summaries), never from raw events again, through the context
// builder; kept, and written again only when one of its days changed. A week
// runs Monday 04:00 to Monday 04:00, like days. WEEK_FORMAT covers the prompt,
// the schema and the checks here.

import { createHash } from "node:crypto";
import type { JournalDay, JournalWeek } from "@cmd/protocol";

export const WEEK_FORMAT = 1;

export const WEEK_SYSTEM = `You write the weekly summary of a developer's work log. The input is the week's days, each with its entries (kind, outcome, title, summary). You group the week's entries into a few themes, the way a person would sum up their week to their team.

- themes: 2 to 6, the main threads of work, most important first. A theme names the work, 2 to 5 words, sentence case, no trailing period ("Data layer refactor", "Released v0.15", "Drag and drop"). Its summary is one or two sentences, at most 45 words, past tense: what got done, what shipped, what's still open. Name versions, features and outcomes from the entries; never invent any.
- entries: the ids of the entries a theme covers (from the input, in brackets). Every entry that isn't a chore belongs to a theme; chores may be left out. An entry belongs to one theme.
- headline: one sentence, at most 25 words, the week at a glance: the main things, not a list of everything. No "This week".
- Use only what the input shows. Leave out secrets and personal data. Write in English.`;

export const WEEK_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    themes: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, summary: { type: "string" }, entries: { type: "array", items: { type: "string" } } },
        required: ["title", "summary", "entries"],
        additionalProperties: false,
      },
    },
  },
  required: ["headline", "themes"],
  additionalProperties: false,
} as const;

export interface WrittenWeek {
  headline: string;
  themes: { title: string; summary: string; entries: string[] }[];
}

/** Monday 00:00 (local) of the week a work day falls in. */
export function weekOf(dayDate: number): number {
  const d = new Date(dayDate);
  const back = (d.getDay() + 6) % 7; // Monday = 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
}

/** The local midnights of the seven work days of a week. */
export function daysOfWeek(start: number): number[] {
  const d = new Date(start);
  return [...Array(7).keys()].map((i) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + i).getTime());
}

/** What the days said, hashed: a week is written again when a day was written again. */
export function daysHash(days: JournalDay[]): string {
  const h = createHash("sha256");
  for (const d of [...days].sort((a, b) => a.date - b.date)) h.update(`${d.date}\0${d.inputHash}\0${d.writtenAt}\n`);
  return h.digest("hex").slice(0, 16);
}

/** The week's days as text for the model: each entry with an id the answer refers to. */
export function weekDigest(days: JournalDay[]): { text: string; ids: Map<string, { day: number; entry: string }> } {
  const ids = new Map<string, { day: number; entry: string }>();
  const lines: string[] = [];
  let n = 0;
  for (const d of [...days].sort((a, b) => a.date - b.date)) {
    lines.push(`${new Date(d.date).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}: ${d.headline}`);
    for (const e of d.entries) {
      const id = `E${++n}`;
      ids.set(id, { day: d.date, entry: e.id });
      lines.push(`  [${id}] ${e.kind}${e.outcome ? `/${e.outcome}` : ""} · ${e.title}: ${e.summary}`);
    }
    lines.push("");
  }
  return { text: lines.join("\n").trim(), ids };
}

/** The model's answer as a week: ids resolved, unknown ones dropped, non-chores it left out gathered in "Also". */
export function toWeek(w: WrittenWeek, days: JournalDay[], ids: Map<string, { day: number; entry: string }>, o: { start: number; scope: string; writtenBy: string | null }): JournalWeek {
  const used = new Set<string>();
  const themes = w.themes
    .map((t) => {
      const entries = t.entries.map((r) => ids.get(r.trim())).filter((x): x is { day: number; entry: string } => !!x && !used.has(`${x.day}|${x.entry}`));
      for (const e of entries) used.add(`${e.day}|${e.entry}`);
      return { title: t.title.trim().replace(/\.$/, ""), summary: t.summary.trim(), entries };
    })
    .filter((t) => t.entries.length);
  const missed = days.flatMap((d) => d.entries.filter((e) => e.kind !== "chore" && !used.has(`${d.date}|${e.id}`)).map((e) => ({ day: d.date, entry: e.id, title: e.title })));
  if (missed.length) themes.push({ title: "Also", summary: missed.map((m) => m.title).join("; "), entries: missed.map(({ day, entry }) => ({ day, entry })) });
  return { start: o.start, scope: o.scope, headline: w.headline.trim(), themes, days: days.map((d) => d.date).sort((a, b) => a - b), writtenBy: o.writtenBy, writtenAt: Date.now(), format: WEEK_FORMAT, daysHash: daysHash(days) };
}
