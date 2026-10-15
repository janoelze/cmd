// Chart presets (docs/49 "Pieces"): what dashboards and the Stats widget draw, each a few marks
// in a Plot or a few rows of HTML. A chart says what it shows in its header (`summary`) and,
// while the cursor is on a bucket, that bucket's values in the same place (no floating
// tooltip, nothing moves). Values reach the kit already formatted by the caller's `format`.

import { useState, type ReactNode } from "react";
import { Bars, Line, Plot, Rule, seriesColor, Ticks, useSize, type ChartSeries } from "./plot.tsx";

type Fmt = (v: number) => string;
const sum = (s: readonly ChartSeries[], i: number) => s.reduce((a, x) => a + (x.values[i] ?? 0), 0);
const anyAt = (s: readonly ChartSeries[], i: number) => s.some((x) => x.values[i] !== null && x.values[i] !== undefined);

/** A chart's header: the summary, replaced by the bucket under the cursor while scrubbing. One line, always the same height. */
export function ChartHead({ summary, readout }: { summary?: ReactNode; readout?: ReactNode }) {
  if (summary === undefined && readout === undefined) return null;
  return (
    <div className="ui-chart-head" data-reading={readout !== undefined && readout !== null ? true : undefined}>
      {readout ?? summary}
    </div>
  );
}

/** A change against the period before: "▲ 18%" in green when up is good, red when it isn't, dim when flat or neither. */
export function Delta({ text, trend, good }: { text: string; trend: "up" | "down" | "flat"; good?: "up" | "down" }) {
  if (!text) return null;
  const tone = trend === "flat" || !good ? undefined : trend === good ? "success" : "danger";
  return (
    <span className="ui-delta" data-tone={tone}>
      {trend === "up" ? "▲" : trend === "down" ? "▼" : ""}
      {trend !== "flat" && " "}
      {text.replace(/^[+−-]/, "")}
    </span>
  );
}

/** A stat's detail as a chart's `summary`: the value bold, its change (a Delta), then dim words ("median 4m, 90% under 12m"). */
export function ChartSummary({ value, delta, note }: { value: ReactNode; delta?: ReactNode; note?: ReactNode }) {
  return (
    <>
      <b className="ui-chart-value">{value}</b>
      {delta}
      {note != null && note !== "" && <span>{note}</span>}
    </>
  );
}

function Readout({ value, label, parts }: { value: string; label: string; parts?: { label: string; value: string; color: string }[] }) {
  return (
    <>
      <b className="ui-chart-value">{value}</b>
      <span className="ui-chart-when">{label}</span>
      {parts?.map((p) => (
        <span key={p.label} className="ui-chart-part" style={{ color: p.color }}>
          <i />
          <span>
            {p.label} <span className="ui-chart-part-value">{p.value}</span>
          </span>
        </span>
      ))}
    </>
  );
}

export interface TimeChartProps {
  /** Each bucket's start (ms). */
  buckets: readonly number[];
  /** One series, or several (stacked bars, overlaid lines). */
  series: readonly ChartSeries[];
  /** The same buckets one period earlier: ticks over bars, a dashed line under lines. */
  previous?: readonly (number | null)[];
  /** The bucket that matters (today), in the accent. */
  current?: number | null;
  /** Values (header, readout) and the y axis. */
  format?: Fmt;
  ticks?: "number" | "duration";
  /** A bucket's short label on the x axis ("M", "14"), and its long one in the readout ("Mon 14 Oct"). */
  xLabel: (t: number, i: number) => string;
  longLabel?: (t: number, i: number) => string;
  /** What the chart shows, in words: its header, its accessible name. */
  summary?: ReactNode;
  label: string;
  /** A dashed line at the mean of the buckets that have data. */
  average?: boolean;
  height?: number | "fill";
  onSelect?: (i: number) => void;
}

function useReadout(p: TimeChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const fmt = p.format ?? String;
  const long = p.longLabel ?? p.xLabel;
  const readout =
    hover !== null && anyAt(p.series, hover) ? (
      <Readout
        value={fmt(sum(p.series, hover))}
        label={long(p.buckets[hover]!, hover)}
        parts={p.series.length > 1 ? p.series.filter((s) => s.values[hover]).map((s) => ({ label: s.label, value: fmt(s.values[hover]!), color: seriesColor(p.series.indexOf(s)) })) : undefined}
      />
    ) : undefined;
  const describe = (i: number) => (anyAt(p.series, i) ? `${long(p.buckets[i]!, i)}: ${fmt(sum(p.series, i))}` : `${long(p.buckets[i]!, i)}: no data`);
  return { readout, setHover, describe, fmt };
}

/** Bars over time buckets: the current one in the accent, the period before as ticks, an average line. The chart most stats want. */
export function TimeBars(p: TimeChartProps) {
  const { readout, setHover, describe, fmt } = useReadout(p);
  const totals = p.buckets.map((_, i) => sum(p.series, i));
  const known = p.buckets.map((_, i) => i).filter((i) => anyAt(p.series, i));
  const max = Math.max(0, ...totals, ...(p.previous ?? []).map((v) => v ?? 0));
  const avg = known.length ? known.reduce((a, i) => a + totals[i]!, 0) / known.length : 0;
  return (
    <div className="ui-chart" data-fill={p.height === "fill" || undefined}>
      <ChartHead summary={p.summary} readout={readout} />
      <Plot n={p.buckets.length} max={max} height={p.height ?? 120} format={(v) => fmt(v)} ticks={p.ticks} xLabel={(i) => p.xLabel(p.buckets[i]!, i)} current={p.current ?? null} label={p.label} describe={describe} onHover={setHover} onSelect={p.onSelect}>
        <Bars series={p.series} />
        {p.previous && <Ticks values={p.previous} />}
        {p.average && known.length > 1 && <Rule y={avg} label="avg" />}
      </Plot>
      {p.series.length > 1 && <Legend series={p.series} />}
    </div>
  );
}

/** Lines over time buckets, filled under when there's one; the period before dashed. For gauges, rates and running totals. */
export function TimeSeries(p: TimeChartProps & { area?: boolean }) {
  const { readout, setHover, describe, fmt } = useReadout(p);
  const max = Math.max(0, ...p.series.flatMap((s) => s.values.map((v) => v ?? 0)), ...(p.previous ?? []).map((v) => v ?? 0));
  return (
    <div className="ui-chart" data-fill={p.height === "fill" || undefined}>
      <ChartHead summary={p.summary} readout={readout} />
      <Plot n={p.buckets.length} max={max} height={p.height ?? 120} format={(v) => fmt(v)} ticks={p.ticks} xLabel={(i) => p.xLabel(p.buckets[i]!, i)} current={p.current ?? null} label={p.label} describe={describe} onHover={setHover} onSelect={p.onSelect} cursor>
        {p.previous && <Line values={p.previous} color="var(--chart-neutral)" dashed weight={0.66} />}
        {p.series.map((s, i) => (
          <Line key={s.key} values={s.values} color={p.series.length === 1 ? "var(--chart-current)" : seriesColor(i)} area={(p.area ?? true) && p.series.length === 1} />
        ))}
      </Plot>
      {p.series.length > 1 && <Legend series={p.series} />}
    </div>
  );
}

/** Series names and colours, for a chart with more than one: each name in its series' colour, its swatch centred on the letters. */
export function Legend({ series }: { series: readonly { label?: string; name?: string }[] }) {
  return (
    <div className="ui-legend">
      {series.map((s, i) => (
        <span key={(s.label ?? s.name)!} className="ui-legend-item" style={{ color: seriesColor(i) }}>
          <i />
          <span>{s.label ?? s.name}</span>
        </span>
      ))}
    </div>
  );
}

export interface RankingRow {
  key: string;
  label: ReactNode;
  value: number;
  /** A second number after the value ("9% failed"). */
  note?: ReactNode;
}

/** A ranked list with a bar per row (Screen Time's most used): label, bar, value. Rows are buttons when `onSelect` is given. */
export function Ranking({ rows, format = String, max, onSelect, empty = "Nothing yet" }: { rows: readonly RankingRow[]; format?: Fmt; max?: number; onSelect?: (key: string) => void; empty?: ReactNode }) {
  if (!rows.length) return <div className="ui-ranking-empty">{empty}</div>;
  const top = max ?? Math.max(...rows.map((r) => r.value));
  return (
    <div className="ui-ranking" role="list">
      {rows.map((r) => {
        const Row = onSelect ? "button" : "div";
        return (
          <Row key={r.key} className="ui-ranking-row" role="listitem" type={onSelect ? "button" : undefined} onClick={onSelect ? () => onSelect(r.key) : undefined}>
            <span className="ui-ranking-label">{r.label}</span>
            <span className="ui-ranking-track">
              <i style={{ width: `${top ? Math.max(0.5, (100 * r.value) / top) : 0}%` }} />
            </span>
            <span className="ui-ranking-value">{format(r.value)}</span>
            {r.note !== undefined && <span className="ui-ranking-note">{r.note}</span>}
          </Row>
        );
      })}
    </div>
  );
}

/** One value against a scale (Few's bullet graph): muted bands, the value as a bar, a target as a tick. For budgets and limits. */
export function Meter({ value, max, target, bands = [], format = String, label }: { value: number; max: number; target?: number; bands?: readonly number[]; format?: Fmt; label?: ReactNode }) {
  const pct = (v: number) => `${Math.max(0, Math.min(100, (100 * v) / (max || 1)))}%`;
  return (
    <div className="ui-meter">
      {label !== undefined && (
        <div className="ui-meter-head">
          <span>{label}</span>
          <span className="ui-meter-value">
            {format(value)}
            <span className="ui-meter-of"> / {format(max)}</span>
          </span>
        </div>
      )}
      <div className="ui-meter-track" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
        {[...bands].sort((a, b) => b - a).map((b, i) => (
          <i key={b} className="ui-meter-band" data-level={i} style={{ width: pct(b) }} />
        ))}
        <i className="ui-meter-bar" data-over={value > max || undefined} style={{ width: pct(value) }} />
        {target !== undefined && <i className="ui-meter-target" style={{ left: pct(target) }} />}
      </div>
    </div>
  );
}

/** Shares of a whole as one bar split by part, with labels and percentages below. Instead of pies and donuts. */
export function Proportion({ parts, format = String }: { parts: readonly { key: string; label: string; value: number }[]; format?: Fmt }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div className="ui-proportion">
      <div className="ui-proportion-bar" role="img" aria-label={shown.map((p) => `${p.label} ${Math.round((100 * p.value) / (total || 1))}%`).join(", ")}>
        {shown.map((p) => (
          <i key={p.key} style={{ flexGrow: p.value, background: seriesColor(parts.indexOf(p)) }} />
        ))}
      </div>
      <div className="ui-legend">
        {shown.map((p) => (
          <span key={p.key} className="ui-legend-item" style={{ color: seriesColor(parts.indexOf(p)) }}>
            <i />
            <span>
              {p.label}
              <span className="ui-proportion-value">
                {format(p.value)} · {Math.round((100 * p.value) / (total || 1))}%
              </span>
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Heat levels 0–4 for values: 0 for nothing, quartiles of the rest for 1–4. */
export function heatLevels(values: readonly (number | null)[]): (number | null)[] {
  const xs = values.filter((v): v is number => !!v).sort((a, b) => a - b);
  const q = (f: number) => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))] ?? 0;
  const [a, b, c] = [q(0.25), q(0.5), q(0.75)];
  return values.map((v) => (v === null ? null : !v ? 0 : v <= a ? 1 : v <= b ? 2 : v <= c ? 3 : 4));
}

/** A year (or any run of days) as weeks × weekdays, five levels of one hue, empty days still visible (GitHub's contributions). */
export function Calendar({ start, values, format = String, firstDay = 1, label, dayLabel = (t) => new Date(t).toDateString(), onSelect }: { start: number; values: readonly (number | null)[]; format?: Fmt; firstDay?: number; label: string; dayLabel?: (t: number) => string; onSelect?: (t: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const levels = heatLevels(values);
  const lead = (new Date(start).getDay() - (firstDay % 7) + 7) % 7;
  const weeks = Math.ceil((lead + values.length) / 7);
  const C = 11;
  const G = 2;
  const L = 28;
  const day = (i: number) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d.getTime();
  };
  const months: { x: number; text: string }[] = [];
  for (let i = 0; i < values.length; i++) {
    const d = new Date(day(i));
    if (d.getDate() === 1 || i === 0) months.push({ x: Math.floor((lead + i) / 7) * (C + G), text: d.toLocaleDateString(undefined, { month: "short" }) });
  }
  const readout = hover !== null && values[hover] !== null ? <Readout value={format(values[hover]!)} label={dayLabel(day(hover))} /> : undefined;
  return (
    <div className="ui-chart">
      <ChartHead summary={label} readout={readout} />
      <div className="ui-calendar">
        <svg width={L + weeks * (C + G)} height={14 + 7 * (C + G)} role="img" aria-label={label} onPointerLeave={() => setHover(null)}>
          {[1, 3, 5].map((r) => (
            <text key={r} className="ui-plot-tick" x={0} y={14 + r * (C + G) + C - 2}>
              {new Date(2024, 0, firstDay + r).toLocaleDateString(undefined, { weekday: "short" })}
            </text>
          ))}
          {months.filter((m, i) => i === 0 || m.x - months[i - 1]!.x >= 3 * (C + G)).map((m) => (
            <text key={m.x} className="ui-plot-tick" x={L + m.x} y={9}>
              {m.text}
            </text>
          ))}
          {values.map((v, i) => {
            const k = lead + i;
            return (
              <rect key={i} className="ui-heat" data-level={levels[i] ?? undefined} data-state={i === hover ? "hover" : undefined} x={L + Math.floor(k / 7) * (C + G)} y={14 + (k % 7) * (C + G)} width={C} height={C} rx={2} onPointerEnter={() => setHover(i)} onClick={onSelect && v !== null ? () => onSelect(day(i)) : undefined}>
                <title>{`${dayLabel(day(i))}: ${v === null ? "no data" : format(v)}`}</title>
              </rect>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/** When things happen: weekdays × hours of the day, five levels of one hue, as wide as its pane (cells stretch, rows stay short). `values[row][hour]`, rows in the order of `rows`. */
export function PunchCard({ values, rows, format = String, label }: { values: readonly (readonly number[])[]; rows: readonly string[]; format?: Fmt; label: string }) {
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [ref, size] = useSize<HTMLDivElement>();
  const levels = heatLevels(values.flat());
  const G = 2;
  const L = 28;
  // Columns share the width (no narrower than 6 px); rows are as tall as a column is wide, between 12 and 20 px.
  const W = Math.max(6, ((size.w || L + 24 * 14) - L + G) / 24 - G);
  const H = Math.min(20, Math.max(12, W));
  const readout = hover ? <Readout value={format(values[hover[0]]![hover[1]]!)} label={`${rows[hover[0]]} ${String(hover[1]).padStart(2, "0")}:00`} /> : undefined;
  return (
    <div className="ui-chart">
      <ChartHead summary={label} readout={readout} />
      <div className="ui-calendar" ref={ref}>
        <svg width={L + 24 * (W + G) - G} height={rows.length * (H + G) + 14} role="img" aria-label={label} onPointerLeave={() => setHover(null)}>
          {rows.map((r, y) => (
            <text key={r} className="ui-plot-tick" x={0} y={y * (H + G) + H / 2 + 3}>
              {r}
            </text>
          ))}
          {[0, 6, 12, 18].map((h) => (
            <text key={h} className="ui-plot-tick" x={L + h * (W + G)} y={rows.length * (H + G) + 11}>
              {String(h).padStart(2, "0")}
            </text>
          ))}
          {values.map((row, y) =>
            row.map((_, h) => <rect key={`${y}-${h}`} className="ui-heat" data-level={levels[y * 24 + h] ?? 0} data-state={hover && hover[0] === y && hover[1] === h ? "hover" : undefined} x={L + h * (W + G)} y={y * (H + G)} width={W} height={H} rx={2} onPointerEnter={() => setHover([y, h])} />),
          )}
        </svg>
      </div>
    </div>
  );
}

/** How values spread (durations, sizes): a histogram over log-scale bins, the median and 90th percentile as rules. */
export function Distribution({ bins, p50, p90, format = String, label, height = 90 }: { bins: readonly { lo: number; hi: number; n: number }[]; p50?: number; p90?: number; format?: Fmt; label: string; height?: number }) {
  const series = [{ key: "n", label: "Count", values: bins.map((b) => b.n) }];
  const at = (v: number | undefined) => (v === undefined ? -1 : bins.findIndex((b) => v >= b.lo && v < b.hi));
  const [hover, setHover] = useState<number | null>(null);
  const summary = p50 !== undefined ? <Readout value={format(p50)} label={`median${p90 !== undefined ? `, 90% under ${format(p90)}` : ""}`} /> : undefined;
  const readout = hover !== null ? <Readout value={String(bins[hover]!.n)} label={`${format(bins[hover]!.lo)}–${format(bins[hover]!.hi)}`} /> : undefined;
  const p50i = at(p50);
  const p90i = at(p90);
  return (
    <div className="ui-chart">
      <ChartHead summary={summary} readout={readout} />
      <Plot n={bins.length} max={Math.max(0, ...bins.map((b) => b.n))} height={height} label={label} onHover={setHover} xLabel={(i) => (i === p50i ? "p50" : i === p90i ? "p90" : i === 0 || i === bins.length - 1 ? format(i === 0 ? bins[0]!.lo : bins[i]!.hi) : "")} current={p50i >= 0 ? p50i : null}>
        <Bars series={series} />
      </Plot>
    </div>
  );
}
