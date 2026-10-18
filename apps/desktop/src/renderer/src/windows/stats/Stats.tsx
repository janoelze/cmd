// Stats, a built-in widget (docs/49-stats.md): how you and your agents used cmd, as one page
// read top to bottom like Screen Time. A sentence, headline numbers with their change and a
// sparkline, then a section per area: agent time per day, how turns ended, the commands run
// most and how often they failed, when you work, where agent time went, tokens by model,
// cmd's own model calls. Every number opens its detail: a bigger chart, split by what the
// stat can be split by, and its ranking. Stats draws results it's given; StatsView asks the core.

import { Button, Calendar, Delta, Pane, Panes, Proportion, PunchCard, Ranking, Stack, Stat, StatusLine, Sparkline, Text, Tiles, TimeBars, TimeSeries, ToolbarButton, ToolbarSegmented, ToolbarSpacer, View, WindowToolbar } from "@cmd/ui";
import { formatDelta, formatValue, trendOf, type StatGrain, type StatResult } from "@cmd/protocol";
import type { ReactNode } from "react";

export type StatsRange = "today" | "week" | "month" | "year";
export const RANGES: { value: StatsRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];
const PERIOD: Record<StatsRange, [string, string]> = { today: ["Today", "yesterday"], week: ["This week", "last week"], month: ["This month", "last month"], year: ["This year", "last year"] };

/** The page's results by name (StatsView's queries). */
export type StatsData = Partial<Record<"time" | "active" | "turns" | "waiting" | "runs" | "fail" | "tokens" | "projects" | "heat" | "ai" | "memory" | "stalls" | "worst" | "size", StatResult>>;

const fmt = (r: StatResult) => (v: number) => formatValue(v, r.stat.unit);
const short = (r: StatResult) => (v: number) => formatValue(v, r.stat.unit, true);
const ticks = (r: StatResult) => (r.stat.unit === "ms" ? "duration" : "number");

/** A bucket's short label (x axis) and long one (readout), by grain and range. */
export function bucketLabels(r: StatResult, range: StatsRange | "detail") {
  const g: StatGrain = r.grain;
  const d = (t: number) => new Date(t);
  const xLabel = (t: number, i: number) =>
    g === "hour" ? String(d(t).getHours()).padStart(2, "0") : g === "day" ? (range === "week" || r.buckets.length <= 7 ? d(t).toLocaleDateString(undefined, { weekday: "narrow" }) : String(d(t).getDate())) : g === "week" ? (i === 0 || d(t).getMonth() !== d(r.buckets[i - 1]!).getMonth() ? d(t).toLocaleDateString(undefined, { month: "short" }) : "") : d(t).toLocaleDateString(undefined, { month: "short" });
  const longLabel = (t: number) => (g === "hour" ? d(t).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : g === "week" ? `Week of ${d(t).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : g === "month" ? d(t).toLocaleDateString(undefined, { month: "long", year: "numeric" }) : d(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }));
  return { xLabel, longLabel };
}

/** The bucket now falls in, if it's on the chart. */
export function currentIndex(r: StatResult, now = Date.now()): number | null {
  const i = r.buckets.findIndex((b, k) => b <= now && now < (r.buckets[k + 1] ?? r.to));
  return i >= 0 ? i : null;
}

function delta(r: StatResult | undefined): ReactNode {
  if (!r?.previous) return undefined;
  const text = formatDelta(r.total, r.previous.total, r.stat.unit);
  return text ? <Delta text={text} trend={trendOf(r.total, r.previous.total)} good={r.stat.good} /> : undefined;
}

/** All series added up per bucket (a sparkline of the whole). */
const totals = (r: StatResult) => r.buckets.map((_, i) => (r.series.every((s) => s.values[i] === null) ? null : r.series.reduce((a, s) => a + (s.values[i] ?? 0), 0)));

/** The page's opening line: what happened, in words, from the numbers (no model). */
export function sentence(data: StatsData, range: StatsRange): string {
  const [when, before] = PERIOD[range];
  const t = data.time;
  if (!t) return "";
  if (!t.total) return `${when}: no agent work yet.`;
  const projects = data.projects?.ranking?.length ?? 0;
  const d = t.previous ? formatDelta(t.total, t.previous.total) : "";
  const change = d && d !== "new" && d !== "±0%" ? `, ${d.replace(/^[+−]/, "")} ${trendOf(t.total, t.previous!.total) === "up" ? "more" : "less"} than ${before}` : "";
  return `${when}: agents worked ${formatValue(t.total, "ms")}${projects > 1 ? ` across ${projects} projects` : ""}${change}.`;
}

export interface StatsProps {
  range: StatsRange;
  data: StatsData | null;
  /** What failed to load, in words. */
  error?: string | null;
  onRange: (r: StatsRange) => void;
  /** Open a stat's detail. */
  onOpen: (stat: string) => void;
  onRetry?: () => void;
  now?: number;
}

/** The overview page. */
export function Stats({ range, data, error, onRange, onOpen, onRetry, now = Date.now() }: StatsProps) {
  const toolbar = (
    <WindowToolbar label="Stats">
      <ToolbarSegmented label="Range" value={range} onChange={onRange} options={RANGES} />
    </WindowToolbar>
  );
  const state = error ? { kind: "error" as const, title: "Couldn't count", text: error, action: onRetry ? <Button onClick={onRetry}>Try Again</Button> : undefined } : !data ? { kind: "loading" as const } : undefined;
  if (state || !data) return <View toolbar={toolbar} state={state} />;
  const partial = Object.values(data).find((r) => r?.partial)?.partial;
  const footer = <StatusLine>{partial ? `Counting since ${new Date(partial.since).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : `Updated ${new Date(data.time?.asOf ?? now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}</StatusLine>;
  const tile = (key: keyof StatsData, label: string, r = data[key]) =>
    r && (
      <Stat key={key} label={label} value={fmt(r)(r.total)} delta={delta(r)} onSelect={() => onOpen(r.stat.id)}>
        <Sparkline values={totals(r)} color={key === "time" ? "current" : "neutral"} />
      </Stat>
    );
  const { time, turns, waiting, runs, fail, tokens, projects, heat, ai, memory, stalls, worst, size } = data;
  const failBy = new Map((fail?.ranking ?? []).map((x) => [x.key, x.value]));
  return (
    <View inset toolbar={toolbar} footer={footer}>
      <Stack gap={6}>
        <Text>{sentence(data, range)}</Text>
        <Panes>
          <Pane wide>
            <Tiles min={120} gap={4}>
              {tile("time", "Agent time")}
              {tile("active", "Active time")}
              {tile("turns", "Turns")}
              {tile("runs", "Commands")}
              {tile("fail", "Failed commands")}
              {tile("tokens", "Tokens")}
            </Tiles>
          </Pane>
          {time && (
            <Pane title="Agent time" aside={time.grain === "hour" ? "per hour" : `per ${time.grain}`}>
              <TimeBars {...bucketLabels(time, range)} buckets={time.buckets} series={time.series} previous={time.series.length === 1 ? time.previous?.values : undefined} current={currentIndex(time, now)} format={short(time)} ticks={ticks(time)} average label="Agent time" summary={<>{time.series.length > 1 ? `${time.series[0]!.label} ${Math.round((100 * time.series[0]!.total) / (time.total || 1))}%` : "All agents"}</>} onSelect={() => onOpen(time.stat.id)} />
            </Pane>
          )}
          {turns && (
            <Pane title="Turns" aside="how they ended">
              <Stack gap={4}>
                <Proportion format={fmt(turns)} parts={turns.series.map((s) => ({ key: s.key, label: s.label, value: s.total }))} />
                {waiting && waiting.total > 0 && (
                  <Text tone="dim">
                    Agents waited on you {formatValue(waiting.total, "ms")}
                    {waiting.quantiles ? `, ${formatValue(waiting.quantiles.p50, "ms")} at a time` : ""}.
                  </Text>
                )}
              </Stack>
            </Pane>
          )}
          {runs && (
            <Pane title="Commands" aside="runs">
              <Ranking format={fmt(runs)} rows={(runs.ranking ?? []).map((x) => ({ key: x.key, label: x.label || "Other", value: x.value, note: failBy.get(x.key) ? `${formatValue(failBy.get(x.key)!, "percent")} failed` : "" }))} onSelect={() => onOpen(runs.stat.id)} empty="No commands yet" />
            </Pane>
          )}
          {heat && <Pane title="When you work" aside={range === "year" ? "per day" : range === "today" ? "per hour" : "last 30 days"} wide={range === "year"}>{heatChart(heat, range, now)}</Pane>}
          {projects && (
            <Pane title="Projects" aside="agent time">
              <Ranking format={fmt(projects)} rows={(projects.ranking ?? []).map((x) => ({ key: x.key, label: x.label || "Other", value: x.value }))} empty="No agent work yet" />
            </Pane>
          )}
          {tokens && (
            <Pane title="Tokens" aside="by model">
              <TimeBars {...bucketLabels(tokens, range)} buckets={tokens.buckets} series={tokens.series} current={currentIndex(tokens, now)} format={short(tokens)} label="Tokens by model" summary={`${fmt(tokens)(tokens.total)} in and out`} onSelect={() => onOpen(tokens.stat.id)} />
            </Pane>
          )}
          {ai && (
            <Pane title="cmd's model calls" aside="by feature">
              <Ranking format={fmt(ai)} rows={(ai.ranking ?? []).map((x) => ({ key: x.key, label: x.label || "Other", value: x.value }))} onSelect={() => onOpen(ai.stat.id)} empty="No model calls yet" />
            </Pane>
          )}
          {memory && (
            <Pane title="cmd" aside="core memory">
              <Stack gap={2}>
                <TimeSeries {...bucketLabels(memory, range)} buckets={memory.buckets} series={memory.series} current={currentIndex(memory, now)} format={short(memory)} label="Core memory" summary={`${fmt(memory)(memory.total)} on average`} height={90} onSelect={() => onOpen(memory.stat.id)} />
                <Text tone="dim">
                  {stalls?.total ? `${stalls.total} ${stalls.total === 1 ? "stall" : "stalls"} of the core${worst?.total ? `, the worst ${formatValue(worst.total, "ms")}` : ""}` : "No stalls of the core"}
                  {size?.total ? ` · event log ${formatValue(size.total, "bytes")}` : ""}.
                </Text>
              </Stack>
            </Pane>
          )}
        </Panes>
      </Stack>
    </View>
  );
}

/** When you work: today by hour, a week or month as weekday × hour over the last 30 days, a year as a calendar. */
function heatChart(r: StatResult, range: StatsRange, now: number) {
  const values = r.series[0]?.values ?? [];
  if (range === "year") return <Calendar start={r.buckets[0]!} values={values} format={(v) => formatValue(v, "ms")} label={`Active ${formatValue(r.total, "ms")} this year`} dayLabel={(t) => new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} />;
  if (range === "today") return <TimeBars {...bucketLabels(r, "today")} buckets={r.buckets} series={r.series} current={currentIndex(r, now)} format={short(r)} ticks="duration" label="Active time per hour" summary={`Active ${formatValue(r.total, "ms")}`} />;
  // Hours of the last 30 days, folded into the week: rows from the first day of the week.
  const first = (new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?(): { firstDay: number } }).getWeekInfo?.().firstDay ?? 1;
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  r.buckets.forEach((b, i) => {
    const d = new Date(b);
    grid[(d.getDay() - (first % 7) + 7) % 7]![d.getHours()]! += values[i] ?? 0;
  });
  const rows = Array.from({ length: 7 }, (_, k) => new Date(2024, 0, first + k).toLocaleDateString(undefined, { weekday: "short" }));
  return <PunchCard values={grid} rows={rows} format={(v) => formatValue(v, "ms")} label={`Active ${formatValue(r.total, "ms")} in 30 days`} />;
}

export interface StatDetailProps {
  result: StatResult | null;
  range: StatsRange;
  by: string | null;
  onBy: (by: string | null) => void;
  onRange: (r: StatsRange) => void;
  onBack: () => void;
  now?: number;
}

/** One stat on its own: its chart large, split by one of its dimensions, and its ranking. */
export function StatDetail({ result: r, range, by, onBy, onRange, onBack, now = Date.now() }: StatDetailProps) {
  const dims = r?.stat.dims.filter((d) => !d.many) ?? [];
  const many = r?.stat.dims.find((d) => d.many);
  const toolbar = (
    <WindowToolbar label="Stat">
      <ToolbarButton icon="caret-left" label="Stats" showLabel secondary onClick={onBack} />
      <ToolbarSegmented label="Range" value={range} onChange={onRange} options={RANGES} />
      <ToolbarSpacer />
      {dims.length > 0 && <ToolbarSegmented label="Split by" value={by ?? ""} onChange={(v) => onBy(v || null)} options={[{ value: "", label: "Total" }, ...dims.slice(0, 3).map((d) => ({ value: d.id, label: d.title }))]} />}
    </WindowToolbar>
  );
  if (!r) return <View toolbar={toolbar} state={{ kind: "loading" }} />;
  const line = r.stat.kind === "gauge" || r.stat.unit === "percent" || r.stat.kind === "distribution";
  const props = { ...bucketLabels(r, "detail"), buckets: r.buckets, series: r.series, current: currentIndex(r, now), format: short(r), ticks: ticks(r), label: r.stat.title, height: 200 } as const;
  const summary = (
    <>
      <b className="ui-chart-value">{fmt(r)(r.total)}</b>
      {delta(r)}
      {r.quantiles && <span>median {fmt(r)(r.quantiles.p50)}, 90% under {fmt(r)(r.quantiles.p90)}</span>}
    </>
  );
  return (
    <View inset toolbar={toolbar} footer={<StatusLine>{r.stat.description}</StatusLine>}>
      <Panes>
        <Pane title={r.stat.title} aside={r.measure === "p50" ? "median" : r.grain === "hour" ? "per hour" : `per ${r.grain}`} wide>
          {line ? <TimeSeries {...props} previous={r.series.length === 1 ? r.previous?.values : undefined} summary={summary} /> : <TimeBars {...props} previous={r.series.length === 1 ? r.previous?.values : undefined} average summary={summary} />}
        </Pane>
        {r.ranking && r.ranking.length > 0 && (
          <Pane title={`By ${(r.stat.dims.find((d) => d.id === by) ?? many)?.title.toLowerCase() ?? "value"}`} aside={r.stat.unit === "ms" ? "time" : r.stat.unit}>
            <Ranking format={fmt(r)} rows={r.ranking.map((x) => ({ key: x.key, label: x.label || "Other", value: x.value }))} />
          </Pane>
        )}
      </Panes>
    </View>
  );
}
