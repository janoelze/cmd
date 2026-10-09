// Journal, a built-in widget (docs/23-journal.md): what happened in a workspace,
// as a work log people can read at a glance. A day is a headline, a ribbon of
// the hours worked and a few entries ("Released v0.14.4", "Investigated a
// corrupt database"), which the core writes from what it recorded (agent
// sessions, commands, commits, pages) with AI. Journal draws days it's given
// (stories pass made-up ones); JournalView fetches them. Drawn with the kit: a View,
// each day a Ribbon of its hours and a Timeline of its entries (the window-design skill).

import { Badge, Button, Chip, IconButton, Inline, Ribbon, Spinner, Stack, StatusLine, Text, Timeline, TimelineEntry, View, type Tone } from "@cmd/ui";
import { useState, type ReactNode } from "react";
import type { JournalDay, JournalEntry, JournalEntryKind, JournalOutcome, JournalWeek } from "@cmd/protocol";
import { projectHue } from "../model.ts";

/** Each kind's colour on the rail and the ribbon; the project is the chip. */
const KIND: Record<JournalEntryKind, { label: string; hue: number }> = {
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

const OUTCOME: Record<JournalOutcome, { tone: Tone; label: string }> = {
  shipped: { tone: "accent", label: "Shipped" },
  merged: { tone: "success", label: "Merged" },
  fixed: { tone: "success", label: "Fixed" },
  answered: { tone: "success", label: "Answered" },
  open: { tone: "warning", label: "Open" },
  dropped: { tone: "neutral", label: "Dropped" },
};

const COUNT_LABEL: Partial<Record<keyof JournalEntry["counts"], [string, string]>> = {
  agents: ["agent", "agents"],
  commands: ["command", "commands"],
  commits: ["commit", "commits"],
  pages: ["page", "pages"],
  files: ["file", "files"],
};

/** A work day starts at 04:00 (the core's DAY_STARTS_AT). */
const DAY_START_H = 4;
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** A work day runs 04:00 to 04:00 (the core's DAY_STARTS_AT): at 2 am, today is still yesterday's. */
function dayName(date: number, now: number): string {
  const day = 86_400_000;
  const today = new Date(now - DAY_START_H * 3600_000).setHours(0, 0, 0, 0);
  if (date === today) return "Today";
  if (date === today - day) return "Yesterday";
  return new Date(date).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

function spanText(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

const countsText = (c: JournalEntry["counts"]) =>
  (Object.keys(COUNT_LABEL) as (keyof typeof COUNT_LABEL)[])
    .filter((k) => c[k])
    .map((k) => `${c[k]} ${COUNT_LABEL[k]![c[k] === 1 ? 0 : 1]}`)
    .join(" · ");

/** The day's hours as a strip: one bar per entry, in its kind's colour; the work day runs 04:00 to 04:00. */
function DayRibbon({ day, onPick, picked }: { day: JournalDay; onPick: (id: string) => void; picked: string | null }) {
  const h = 3_600_000;
  const clip = (t: number) => Math.min(Math.max(t, day.date + DAY_START_H * h), day.date + (DAY_START_H + 24) * h);
  // Hours of the work day that had work in them.
  const from = Math.floor((Math.min(...day.entries.map((e) => clip(e.start))) - day.date) / h);
  const to = Math.ceil((Math.max(...day.entries.map((e) => clip(e.end))) - day.date) / h);
  const hours = Math.max(1, to - from);
  const ticks = Array.from({ length: hours + 1 }, (_, i) => from + i)
    .filter((_, i) => hours <= 8 || i % 2 === 0)
    .map((x) => ({ at: day.date + x * h, label: String(x % 24).padStart(2, "0") }));
  return (
    <Ribbon
      items={day.entries.map((e) => ({ id: e.id, start: clip(e.start), end: clip(e.end), hue: KIND[e.kind].hue, label: `${e.title} · ${time(e.start)}–${time(e.end)}` }))}
      from={day.date + from * h}
      to={day.date + (from + hours) * h}
      ticks={ticks}
      picked={picked}
      onPick={onPick}
    />
  );
}

function Entry({ e, picked, showProject }: { e: JournalEntry; picked: boolean; showProject: boolean }) {
  const k = KIND[e.kind];
  const o = e.outcome && OUTCOME[e.outcome];
  return (
    <TimelineEntry id={`journal-${e.id}`} time={time(e.start)} hue={k.hue} label={k.label} picked={picked}>
      <Stack gap="xs">
        <Inline gap="sm">
          <Text strong size="base">
            {e.title}
          </Text>
          {o && (
            <Badge size="sm" tone={o.tone}>
              {o.label}
            </Badge>
          )}
        </Inline>
        <Text tone="dim">{e.summary}</Text>
        <Inline gap="md" wrap>
          {showProject && e.repo && <Chip hue={projectHue(base(e.repo))}>{base(e.repo)}</Chip>}
          <Text tone="dim" size="xs">
            {[spanText(e.end - e.start), countsText(e.counts)].join(" · ")}
          </Text>
        </Inline>
      </Stack>
    </TimelineEntry>
  );
}

/** A day's or the week's heading: its name large, a note beside it, an action at the end. */
function Heading({ title, note, action }: { title: string; note?: string; action?: ReactNode }) {
  return (
    <Inline gap="md" align="baseline" justify="between">
      <Inline gap="md" align="baseline">
        <Text size="lg" strong>
          {title}
        </Text>
        {note && (
          <Text tone="dim" size="sm">
            {note}
          </Text>
        )}
      </Inline>
      {action}
    </Inline>
  );
}

export function Journal({
  days,
  week,
  now = Date.now(),
  showProject = true,
  summarising,
  onRefresh,
  onSetUpAi,
}: {
  days: JournalDay[];
  /** The week so far, rolled up from its days: its threads of work above the days. */
  week?: JournalWeek | null;
  now?: number;
  /** Projects as chips (off when the workspace is one project). */
  showProject?: boolean;
  /** Writing the newest entries: a line in the footer. */
  summarising?: string | null;
  onRefresh?: () => void;
  /** No AI provider: the journal can't be written, and says how to fix that. */
  onSetUpAi?: () => void;
}) {
  // A bar in the ribbon picks its entry: highlighted and scrolled to.
  const [picked, setPicked] = useState<string | null>(null);
  const pick = (id: string) => {
    setPicked((p) => (p === id ? null : id));
    document.getElementById(`journal-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const empty = days.length === 0 && !summarising;
  return (
    <View
      inset
      state={
        empty && onSetUpAi
          ? { kind: "empty", icon: "sparkles", title: "Your journal needs AI", text: "cmd writes up what happened from your agents, terminals and git. Add an API key and it starts with the last few days.", action: <Button onClick={onSetUpAi}>Set Up AI…</Button> }
          : empty
            ? { kind: "empty", icon: "book", title: "Nothing yet", text: "What you and your agents do in this workspace shows up here, a few lines a day." }
            : null
      }
      footer={
        summarising ? (
          <StatusLine>
            <Spinner size={10} /> {summarising}
          </StatusLine>
        ) : undefined
      }
    >
      <Stack gap="2xl">
        {week && week.themes.length > 0 && days.length > 0 && (
          <Stack gap="md">
            <Heading title="This week" />
            <Text>{week.headline}</Text>
            <Stack gap="sm">
              {week.themes.map((t) => (
                <Stack key={t.title} gap="2xs">
                  <Text strong>{t.title}</Text>
                  <Text tone="dim">{t.summary}</Text>
                </Stack>
              ))}
            </Stack>
          </Stack>
        )}
        {days.map((d) => (
          <Stack key={d.date} gap="md">
            <Heading title={dayName(d.date, now)} note={d.entries.length > 0 ? `${time(Math.min(...d.entries.map((e) => e.start)))}–${time(Math.max(...d.entries.map((e) => e.end)))}` : undefined} action={onRefresh && d === days[0] ? <IconButton size="sm" icon="arrow.clockwise" label="Write Again" onClick={onRefresh} /> : undefined} />
            <Text>{d.headline}</Text>
            {d.entries.length > 0 && <DayRibbon day={d} picked={picked} onPick={pick} />}
            <Timeline>
              {[...d.entries]
                .sort((a, b) => b.start - a.start)
                .map((e) => (
                  <Entry key={e.id} e={e} picked={picked === e.id} showProject={showProject} />
                ))}
            </Timeline>
          </Stack>
        ))}
      </Stack>
    </View>
  );
}
