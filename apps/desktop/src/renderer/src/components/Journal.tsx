// Journal (prototype, pnpm workbench journal): what happened in a Space, as a
// work log people can read at a glance. A day is a headline, a ribbon of the
// hours worked and a few entries ("Released v0.14.4", "Investigated a corrupt
// database"), each made from the raw events the core records (agent sessions,
// commands, commits, pages, files) and summarised by AI. An entry opens to the
// events it was made from. Presentational only: the data comes as props, so the
// story can show what a summariser could make before one exists.

import { Badge, Chip, EmptyState, ICON, IconButton, iconNode, Panel, PanelBody, Spinner, type Tone } from "@cmd/ui";
import { useState, type CSSProperties } from "react";
import { projectHue } from "../model.ts";
import "./journal.css";

export type EntryKind = "release" | "investigation" | "feature" | "fix" | "design" | "research" | "chore";
export type Outcome = "shipped" | "fixed" | "merged" | "open" | "dropped";

/** A raw event an entry was made from. */
export interface JournalEvent {
  kind: "agent" | "command" | "commit" | "page" | "file" | "release" | "note";
  text: string;
  at: number;
  /** A failed command, a crashed agent. */
  failed?: boolean;
  /** Dim text after it: a duration, a branch, a host. */
  meta?: string;
}

export interface JournalEntry {
  id: string;
  kind: EntryKind;
  title: string;
  /** One or two sentences, in the past tense. */
  summary: string;
  start: number;
  end: number;
  project?: string;
  outcome?: Outcome;
  /** What it was made from, counted. */
  counts: Partial<Record<"agents" | "commands" | "commits" | "pages" | "files", number>>;
  events: JournalEvent[];
}

export interface JournalDay {
  /** Midnight, local time. A work day ends at 4 am, so a late night stays with the day it began on. */
  date: number;
  /** One sentence for the whole day. */
  headline: string;
  entries: JournalEntry[];
}

/** Each kind's colour on the rail and the ribbon; the project is the chip. */
const KIND: Record<EntryKind, { label: string; hue: number }> = {
  release: { label: "Release", hue: 210 },
  investigation: { label: "Investigation", hue: 25 },
  feature: { label: "Feature", hue: 275 },
  fix: { label: "Fix", hue: 145 },
  design: { label: "Design", hue: 330 },
  research: { label: "Research", hue: 185 },
  chore: { label: "Chore", hue: 220 },
};

const OUTCOME: Record<Outcome, { tone: Tone; label: string }> = {
  shipped: { tone: "accent", label: "Shipped" },
  fixed: { tone: "success", label: "Fixed" },
  merged: { tone: "success", label: "Merged" },
  open: { tone: "warning", label: "Open" },
  dropped: { tone: "neutral", label: "Dropped" },
};

const EVENT_ICON: Record<JournalEvent["kind"], string> = {
  agent: "sparkle",
  command: "terminal",
  commit: "point.topleft.down.to.point.bottomright.curvepath",
  page: "globe",
  file: "doc.text",
  release: "shippingbox",
  note: "text.bubble",
};

const COUNT_LABEL: Record<keyof JournalEntry["counts"], [string, string]> = {
  agents: ["agent", "agents"],
  commands: ["command", "commands"],
  commits: ["commit", "commits"],
  pages: ["page", "pages"],
  files: ["file", "files"],
};

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function dayName(date: number, now: number): string {
  const day = 86_400_000;
  const today = new Date(now).setHours(0, 0, 0, 0);
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
    .map((k) => `${c[k]} ${COUNT_LABEL[k][c[k] === 1 ? 0 : 1]}`)
    .join(" · ");

/** The day's hours as a strip: one bar per entry, in its project's colour, on its own lane where entries overlap. */
function Ribbon({ day, onPick, picked }: { day: JournalDay; onPick: (id: string) => void; picked: string | null }) {
  const starts = day.entries.map((e) => e.start), ends = day.entries.map((e) => e.end);
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
            style={{ left: `${x(e.start)}%`, width: `max(4px, ${x(e.end) - x(e.start)}%)`, top: `calc(${lane.get(e.id)} * var(--lane))`, "--hue": KIND[e.kind].hue } as CSSProperties}
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

function Entry({ e, open, onToggle, showProject }: { e: JournalEntry; open: boolean; onToggle: () => void; showProject: boolean }) {
  const k = KIND[e.kind];
  const o = e.outcome && OUTCOME[e.outcome];
  return (
    <article className="journal-entry" data-open={open || undefined} id={`journal-${e.id}`} style={{ "--hue": k.hue } as CSSProperties}>
      <div className="journal-entry-time">{time(e.start)}</div>
      <div className="journal-entry-rail">
        <span className="journal-entry-mark" data-tip={k.label} />
      </div>
      <div className="journal-entry-body">
        <button type="button" className="journal-entry-head" onClick={onToggle} aria-expanded={open}>
          <span className="journal-entry-title">{e.title}</span>
          {o && (
            <Badge size="sm" tone={o.tone}>
              {o.label}
            </Badge>
          )}
        </button>
        <p className="journal-entry-summary">{e.summary}</p>
        <div className="journal-entry-meta">
          {showProject && e.project && <Chip hue={projectHue(e.project)}>{e.project}</Chip>}
          <span>{[spanText(e.end - e.start), countsText(e.counts)].join(" · ")}</span>
        </div>
        {open && (
          <ul className="journal-events">
            {e.events.map((ev, i) => (
              <li key={i} data-failed={ev.failed || undefined}>
                <span className="journal-event-time">{time(ev.at)}</span>
                <IconGlyph name={EVENT_ICON[ev.kind]} />
                <span className={ev.kind === "command" || ev.kind === "commit" ? "journal-event-text mono" : "journal-event-text"}>{ev.text}</span>
                {ev.meta && <span className="journal-event-meta">{ev.meta}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

/** An SF Symbol through the kit's provider (ListMark's icon without its light). */
const IconGlyph = ({ name }: { name: string }) => <span className="journal-glyph">{iconNode(name, ICON.small)}</span>;

export function Journal({
  days,
  now = Date.now(),
  showProject = true,
  summarising,
  onRefresh,
  initialOpen = null,
}: {
  days: JournalDay[];
  now?: number;
  /** Projects as chips (off when the Space is one project). */
  showProject?: boolean;
  /** Writing the newest entries: a line at the top. */
  summarising?: string | null;
  onRefresh?: () => void;
  /** An entry shown open, with its events. */
  initialOpen?: string | null;
}) {
  const [open, setOpen] = useState<string | null>(initialOpen);
  const pick = (id: string) => {
    setOpen((o) => (o === id ? null : id));
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
        {days.length === 0 && !summarising && (
          <EmptyState compact icon="book" title="Nothing yet">
            What you and your agents do in this Space shows up here, a few lines a day.
          </EmptyState>
        )}
        {days.map((d) => (
          <section key={d.date} className="journal-day">
            <header className="journal-day-head">
              <h3>{dayName(d.date, now)}</h3>
              <span className="journal-day-span">{d.entries.length > 0 && `${time(Math.min(...d.entries.map((e) => e.start)))}–${time(Math.max(...d.entries.map((e) => e.end)))}`}</span>
              {onRefresh && d === days[0] && <IconButton size="sm" icon="arrow.clockwise" label="Write Again" onClick={onRefresh} />}
            </header>
            <p className="journal-day-headline">{d.headline}</p>
            {d.entries.length > 0 && <Ribbon day={d} picked={open} onPick={pick} />}
            <div className="journal-entries">
              {[...d.entries]
                .sort((a, b) => b.start - a.start)
                .map((e) => (
                  <Entry key={e.id} e={e} open={open === e.id} onToggle={() => setOpen((o) => (o === e.id ? null : e.id))} showProject={showProject} />
                ))}
            </div>
          </section>
        ))}
      </PanelBody>
    </Panel>
  );
}
