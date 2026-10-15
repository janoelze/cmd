// Work Log, a built-in widget package (docs/57, wave 2; the native Journal's job, read only):
// the last days of this workspace as the Journal wrote them (cmd.journal.days, API 1.2),
// newest first. A day is its name and the hours worked, a headline, a ribbon of those hours
// (a bar per entry in its kind's hue; a click rings the entry) and a timeline of its entries:
// title, outcome, summary, how long and what it took. A widget never has a day written (that
// runs the person's model): it reads what is there every few minutes, and says when the newest
// day was written; Read Again is the small button on the newest day's heading, where the native
// Journal has Write Again. Refused, it says what it needs; failed, it says so with Try Again.

import { Window, View, Stack, Inline, Text, Badge, IconButton, Ribbon, Timeline, TimelineEntry, StatusLine, useData, useNow, cmd, ApiCallError, type JournalDay, type JournalEntry } from "@cmd/widget-api";
import { useState } from "react";

/** Days read, and how often (seconds) it looks again: days are written elsewhere, so a slow look is enough. */
export const DAYS = 7;
export const EVERY = 300;

type Kind = JournalEntry["kind"];
type Outcome = NonNullable<JournalEntry["outcome"]>;

/** Each kind's colour on the rail and the ribbon (the native Journal's). */
export const KIND: Record<Kind, { label: string; hue: number }> = {
  release: { label: "Release", hue: 210 },
  investigation: { label: "Investigation", hue: 25 },
  feature: { label: "Feature", hue: 275 },
  fix: { label: "Fix", hue: 145 },
  design: { label: "Design", hue: 330 },
  refactor: { label: "Refactor", hue: 245 },
  research: { label: "Research", hue: 185 },
  review: { label: "Review", hue: 55 },
  ops: { label: "Setup", hue: 100 },
  chore: { label: "Chore", hue: 220 },
};

const OUTCOME: Record<Outcome, { tone: "accent" | "success" | "warning" | "neutral"; label: string }> = {
  shipped: { tone: "accent", label: "Shipped" },
  merged: { tone: "success", label: "Merged" },
  fixed: { tone: "success", label: "Fixed" },
  answered: { tone: "success", label: "Answered" },
  open: { tone: "warning", label: "Open" },
  dropped: { tone: "neutral", label: "Dropped" },
};

const COUNTS: [keyof JournalEntry["counts"], string, string][] = [
  ["agents", "agent", "agents"],
  ["commands", "command", "commands"],
  ["commits", "commit", "commits"],
  ["pages", "page", "pages"],
  ["files", "file", "files"],
];

const H = 3_600_000;
/** A work day runs 04:00 to 04:00 (the journal's): at 2 am, today is still yesterday's. */
const DAY_START_H = 4;
const pad = (n: number) => String(n).padStart(2, "0");
const clock = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** "Today", "Yesterday", else the date as the system writes it ("Monday, 12 October"). */
export function dayName(date: number, now: number): string {
  const today = new Date(now - DAY_START_H * H).setHours(0, 0, 0, 0);
  if (date === today) return "Today";
  if (date === new Date(today - 12 * H).setHours(0, 0, 0, 0)) return "Yesterday";
  return new Date(date).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

/** A span: "40 min", "2 h 5 min". */
export function span(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

/** What an entry took: "2 agents · 4 commands · 1 commit". */
export const countsText = (c: JournalEntry["counts"]) =>
  COUNTS.filter(([k]) => c[k])
    .map(([k, one, many]) => `${c[k]} ${c[k] === 1 ? one : many}`)
    .join(" · ");

/** The day's hours as a ribbon: one bar per entry in its kind's hue, the hours with work in them, ticks every hour (every other past 8). */
export function ribbonOf(day: JournalDay) {
  const clip = (t: number) => Math.min(Math.max(t, day.date + DAY_START_H * H), day.date + (DAY_START_H + 24) * H);
  const from = Math.floor((Math.min(...day.entries.map((e) => clip(e.start))) - day.date) / H);
  const to = Math.ceil((Math.max(...day.entries.map((e) => clip(e.end))) - day.date) / H);
  const hours = Math.max(1, to - from);
  return {
    items: day.entries.map((e) => ({ id: e.id, start: clip(e.start), end: Math.max(clip(e.end), clip(e.start) + 60_000), hue: KIND[e.kind]?.hue ?? 220, label: `${e.title} · ${clock(e.start)}–${clock(e.end)}` })),
    from: day.date + from * H,
    to: day.date + (from + hours) * H,
    ticks: Array.from({ length: hours + 1 }, (_, i) => from + i)
      .filter((_, i) => hours <= 8 || i % 2 === 0)
      .map((x) => ({ at: day.date + x * H, label: pad(x % 24) })),
  };
}

/** When the newest day was written: "Written at 14:02" today, else "Written Monday, 12 October". */
export function written(t: number, now: number): string {
  const sameDay = new Date(t).toDateString() === new Date(now).toDateString();
  return sameDay ? `Written at ${clock(t)}` : `Written ${new Date(t).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}`;
}

function Entry({ e, picked }: { e: JournalEntry; picked: boolean }) {
  const k = KIND[e.kind] ?? { label: e.kind, hue: 220 };
  const o = e.outcome ? OUTCOME[e.outcome] : null;
  return (
    <TimelineEntry time={clock(e.start)} hue={k.hue} label={k.label} picked={picked}>
      <Stack gap={1}>
        <Inline gap={1.5} wrap>
          <Text strong size="base">
            {e.title}
          </Text>
          {o && (
            <Badge size="sm" tone={o.tone}>
              {o.label}
            </Badge>
          )}
        </Inline>
        {e.summary && <Text tone="dim">{e.summary}</Text>}
        <Text tone="dim" size="xs">
          {[span(e.end - e.start), countsText(e.counts)].filter(Boolean).join(" · ")}
        </Text>
      </Stack>
    </TimelineEntry>
  );
}

function Day({ day, now, picked, onPick, onRead }: { day: JournalDay; now: number; picked: string | null; onPick: (id: string) => void; onRead?: { busy: boolean; run: () => void } }) {
  const r = day.entries.length ? ribbonOf(day) : null;
  const hours = day.entries.length ? `${clock(Math.min(...day.entries.map((e) => e.start)))}–${clock(Math.max(...day.entries.map((e) => e.end)))}` : null;
  return (
    <Stack gap={2}>
      <Inline gap={2} align="baseline" justify="between">
        <Inline gap={2} align="baseline">
          <Text size="lg" strong>
            {dayName(day.date, now)}
          </Text>
          {hours && (
            <Text tone="dim" size="sm">
              {hours}
            </Text>
          )}
        </Inline>
        {onRead && <IconButton size="sm" icon="arrow.clockwise" label="Read Again" disabled={onRead.busy} onClick={onRead.run} />}
      </Inline>
      <Text>{day.headline}</Text>
      {r && <Ribbon items={r.items} from={r.from} to={r.to} ticks={r.ticks} picked={picked} onPick={onPick} />}
      <Timeline>
        {[...day.entries]
          .sort((a, b) => b.start - a.start)
          .map((e) => (
            <Entry key={e.id} e={e} picked={picked === e.id} />
          ))}
      </Timeline>
    </Stack>
  );
}

export default function WorkLog() {
  const served = cmd.env.has("journal.days");
  const { data, error, refreshing, refresh } = useData(() => (served ? cmd.journal.days({ count: DAYS }) : Promise.resolve([])), { every: EVERY });
  const [picked, setPicked] = useState<string | null>(null);
  const now = useNow(60_000);
  const days = (data ?? []).filter((d) => d.entries.length > 0 || d.headline);
  const refused = error instanceof ApiCallError && error.code === "permission";

  const state = !served
    ? { icon: "book", title: "Needs a newer cmd", text: "Update cmd to read the journal here." }
    : refused
      ? { kind: "error" as const, icon: "lock", title: "The journal isn't shared with this widget", text: error.message }
      : data === undefined && error
        ? { kind: "error" as const, title: "Couldn't read the journal", text: error.message, action: { label: "Try Again", run: refresh } }
        : data === undefined
          ? { kind: "loading" as const, title: "Reading the journal" }
          : days.length === 0
            ? { icon: "book", title: "Nothing written yet", text: "The Journal writes up each day from what you and your agents did. Open it to write today's." }
            : null;
  const newest = days.reduce((t, d) => Math.max(t, d.writtenAt), 0);

  return (
    <Window status={null}>
      <View inset state={state}>
        <Stack gap={6}>
          {days.map((d) => (
            <Day key={d.date} day={d} now={now} picked={picked} onPick={(id) => setPicked((p) => (p === id ? null : id))} onRead={d === days[0] ? { busy: refreshing, run: refresh } : undefined} />
          ))}
        </Stack>
        {newest > 0 && <StatusLine>{error ? "Couldn't read the journal again" : written(newest, now)}</StatusLine>}
      </View>
    </Window>
  );
}
