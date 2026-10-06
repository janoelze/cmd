// Journal, a built-in widget (docs/23-journal.md): what happened in a Space,
// as a work log people can read at a glance. A day is a headline, a ribbon of
// the hours worked and a few entries ("Released v0.14.4", "Investigated a
// corrupt database"), which the core writes from what it recorded (agent
// sessions, commands, commits, pages) with AI. Journal draws days it's given
// (stories pass made-up ones); JournalView fetches them.

import { Badge, Button, Chip, EmptyState, IconButton, Panel, PanelBody, Spinner, type Tone } from "@cmd/ui";
import { useState, type CSSProperties } from "react";
import type { JournalDay, JournalEntry, JournalEntryKind, JournalOutcome, JournalWeek } from "@cmd/protocol";
import { projectHue } from "../model.ts";
import "./journal.css";

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

/** The day's hours as a strip: one bar per entry, in its project's colour, on its own lane where entries overlap. */
function Ribbon({ day, onPick, picked }: { day: JournalDay; onPick: (id: string) => void; picked: string | null }) {
  // Hours of the work day (04:00 to 04:00) that had work in them.
  const clip = (t: number) => Math.min(Math.max(t, day.date + DAY_START_H * 3_600_000), day.date + (DAY_START_H + 24) * 3_600_000);
  const starts = day.entries.map((e) => clip(e.start)), ends = day.entries.map((e) => clip(e.end));
  const from = Math.floor((Math.min(...starts) - day.date) / 3_600_000);
  const to = Math.ceil((Math.max(...ends) - day.date) / 3_600_000);
  const hours = Math.max(1, to - from);
  const x = (t: number) => (((t - day.date) / 3_600_000 - from) / hours) * 100;
  // Greedy lanes, so parallel work (two agents at once) shows as such.
  const lanes: number[] = [];
  const lane = new Map<string, number>();
  for (const e of [...day.entries].sort((a, b) => a.start - b.start)) {
    let i = lanes.findIndex((end) => end <= e.start);
    if (i < 0) i = lanes.push(0) - 1;
    lanes[i] = e.end;
    lane.set(e.id, i);
  }
  const ticks = Array.from({ length: hours + 1 }, (_, i) => from + i).filter((h, i) => hours <= 8 || i % 2 === 0);
  return (
    <div className="journal-ribbon" style={{ "--lanes": lanes.length } as CSSProperties}>
      <div className="journal-ribbon-track">
        {day.entries.map((e) => (
          <button
            key={e.id}
            type="button"
            className="journal-ribbon-bar"
            data-picked={picked === e.id || undefined}
            data-tip={`${e.title} · ${time(e.start)}–${time(e.end)}`}
            onClick={() => onPick(e.id)}
            style={{ left: `${x(clip(e.start))}%`, width: `max(4px, ${x(clip(e.end)) - x(clip(e.start))}%)`, top: `calc(${lane.get(e.id)} * var(--lane))`, "--hue": KIND[e.kind].hue } as CSSProperties}
          />
        ))}
      </div>
      <div className="journal-ribbon-ticks">
        {ticks.map((h) => (
          <span key={h} style={{ left: `${((h - from) / hours) * 100}%` }}>
            {String(h % 24).padStart(2, "0")}
          </span>
        ))}
      </div>
    </div>
  );
}

function Entry({ e, picked, showProject }: { e: JournalEntry; picked: boolean; showProject: boolean }) {
  const k = KIND[e.kind];
  const o = e.outcome && OUTCOME[e.outcome];
  return (
    <article className="journal-entry" data-picked={picked || undefined} id={`journal-${e.id}`} style={{ "--hue": k.hue } as CSSProperties}>
      <div className="journal-entry-time">{time(e.start)}</div>
      <div className="journal-entry-rail">
        <span className="journal-entry-mark" data-tip={k.label} />
      </div>
      <div className="journal-entry-body">
        <div className="journal-entry-head">
          <span className="journal-entry-title">{e.title}</span>
          {o && (
            <Badge size="sm" tone={o.tone}>
              {o.label}
            </Badge>
          )}
        </div>
        <p className="journal-entry-summary">{e.summary}</p>
        <div className="journal-entry-meta">
          {showProject && e.repo && <Chip hue={projectHue(base(e.repo))}>{base(e.repo)}</Chip>}
          <span>{[spanText(e.end - e.start), countsText(e.counts)].join(" · ")}</span>
        </div>
      </div>
    </article>
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
  /** Projects as chips (off when the Space is one project). */
  showProject?: boolean;
  /** Writing the newest entries: a line at the top. */
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
  return (
    <Panel className="journal">
      <PanelBody>
        {summarising && (
          <div className="journal-writing">
            <Spinner size={11} />
            <span>{summarising}</span>
          </div>
        )}
        {days.length === 0 && !summarising && onSetUpAi && (
          <EmptyState
            compact
            icon="sparkles"
            title="Your journal needs AI"
            action={
              <Button size="sm" onClick={onSetUpAi}>
                Set Up AI…
              </Button>
            }
          >
            cmd writes up what happened from your agents, terminals and git. Add an API key and it starts with the last few days.
          </EmptyState>
        )}
        {days.length === 0 && !summarising && !onSetUpAi && (
          <EmptyState compact icon="book" title="Nothing yet">
            What you and your agents do in this Space shows up here, a few lines a day.
          </EmptyState>
        )}
        {week && week.themes.length > 0 && days.length > 0 && (
          <section className="journal-day journal-week">
            <header className="journal-day-head">
              <h3>This week</h3>
            </header>
            <p className="journal-day-headline">{week.headline}</p>
            <ul className="journal-week-themes">
              {week.themes.map((t) => (
                <li key={t.title}>
                  <span className="journal-entry-title">{t.title}</span>
                  <p className="journal-entry-summary">{t.summary}</p>
                </li>
              ))}
            </ul>
          </section>
        )}
        {days.map((d) => (
          <section key={d.date} className="journal-day">
            <header className="journal-day-head">
              <h3>{dayName(d.date, now)}</h3>
              <span className="journal-day-span">{d.entries.length > 0 && `${time(Math.min(...d.entries.map((e) => e.start)))}–${time(Math.max(...d.entries.map((e) => e.end)))}`}</span>
              {onRefresh && d === days[0] && <IconButton size="sm" icon="arrow.clockwise" label="Write Again" onClick={onRefresh} />}
            </header>
            <p className="journal-day-headline">{d.headline}</p>
            {d.entries.length > 0 && <Ribbon day={d} picked={picked} onPick={pick} />}
            <div className="journal-entries">
              {[...d.entries]
                .sort((a, b) => b.start - a.start)
                .map((e) => (
                  <Entry key={e.id} e={e} picked={picked === e.id} showProject={showProject} />
                ))}
            </div>
          </section>
        ))}
      </PanelBody>
    </Panel>
  );
}
