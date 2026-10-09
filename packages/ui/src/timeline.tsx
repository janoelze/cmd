// Time: a Ribbon of the hours worked (one bar per item, on its own lane where items
// overlap, hour ticks under it) and a Timeline of entries (a time, a mark on a rail,
// the entry). Each item takes a hue (a kind's or a project's colour), drawn with
// --mark. The Journal widget's day is both, a ribbon picking its entries.

import type { CSSProperties, ReactNode } from "react";

export interface RibbonItem {
  id: string;
  /** Start and end, in the same unit as from and to (ms since the epoch). */
  start: number;
  end: number;
  hue: number;
  /** Its tooltip and accessible name. */
  label: string;
}

/** Items as bars between `from` and `to`, ticks under them; a click picks one. */
export function Ribbon({ items, from, to, ticks, picked, onPick }: { items: readonly RibbonItem[]; from: number; to: number; ticks: readonly { at: number; label: string }[]; picked?: string | null; onPick?: (id: string) => void }) {
  const span = Math.max(1, to - from);
  const x = (t: number) => ((Math.min(Math.max(t, from), to) - from) / span) * 100;
  // Greedy lanes, so parallel work (two agents at once) shows as such.
  const lanes: number[] = [];
  const lane = new Map<string, number>();
  for (const e of [...items].sort((a, b) => a.start - b.start)) {
    let i = lanes.findIndex((end) => end <= e.start);
    if (i < 0) i = lanes.push(0) - 1;
    lanes[i] = e.end;
    lane.set(e.id, i);
  }
  return (
    <div className="ui-ribbon" style={{ "--lanes": Math.max(1, lanes.length) } as CSSProperties}>
      <div className="ui-ribbon-track">
        {items.map((e) => (
          <button
            key={e.id}
            type="button"
            className="ui-ribbon-bar"
            data-picked={picked === e.id || undefined}
            data-tip={e.label}
            aria-label={e.label}
            aria-pressed={picked === e.id}
            onClick={() => onPick?.(e.id)}
            style={{ left: `${x(e.start)}%`, width: `max(4px, ${x(e.end) - x(e.start)}%)`, top: `calc(${lane.get(e.id)} * var(--lane))`, "--hue": e.hue } as CSSProperties}
          />
        ))}
      </div>
      <div className="ui-ribbon-ticks">
        {ticks.map((t) => (
          <span key={t.at} style={{ left: `${x(t.at)}%` }}>
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Entries down a rail, newest or oldest first as given. */
export function Timeline({ children }: { children: ReactNode }) {
  return <div className="ui-timeline">{children}</div>;
}

/** One entry: its time, a mark in its hue on the rail (`label` its tooltip), then what happened. `picked` rings the mark. */
export function TimelineEntry({ id, time, hue, label, picked, children }: { id?: string; time: ReactNode; hue: number; label?: string; picked?: boolean; children: ReactNode }) {
  return (
    <article className="ui-tl-entry" id={id} data-picked={picked || undefined} style={{ "--hue": hue } as CSSProperties}>
      <div className="ui-tl-time">{time}</div>
      <div className="ui-tl-rail">
        <span className="ui-tl-mark" data-tip={label} />
      </div>
      <div className="ui-tl-body">{children}</div>
    </article>
  );
}
