// Usage Stats, a built-in widget package (docs/57; the native Stats window's job, docs/49): how
// you and your agents used cmd in this workspace (or in every one, from the title menu), as one
// page read top to bottom. A sentence, headline numbers with their change and a sparkline, then
// a pane per area: agent time per bucket, how turns ended and how long agents waited on you, the
// commands run most and how often they failed, when you work, where agent time went (projects),
// tokens by model, cmd's own model calls, and cmd itself (its core's memory and stalls, the event
// log's size). Every number opens its detail: a bigger chart with its change and spread, split by
// what the stat can be split by, and its ranking.
//
// Each number is a live stat (`useStat`, API 1.3): cmd counts it again soon after it records
// something for it, and each minute for time spent, so nothing here polls. What has no workspace
// (your active time, cmd's model calls, cmd's own pane) is every workspace's in both scopes, as
// on the native page. When cmd refuses a stat, the page says why, with Try Again.

import {
  Window,
  View,
  WindowToolbar,
  ToolbarSegmented,
  ToolbarButton,
  ToolbarSpacer,
  Stack,
  Text,
  Tiles,
  Stat,
  Sparkline,
  Panes,
  Pane,
  TimeBars,
  TimeSeries,
  Ranking,
  Proportion,
  PunchCard,
  Calendar,
  StatusLine,
  useStat,
  useEnv,
  useStoredState,
  fmt,
  type StatQuery,
  type StatResult,
} from "@cmd/widget-api";
import { Component, type ReactNode } from "react";

export type Range = "today" | "week" | "month" | "year";
type Scope = "workspace" | "all";

export const RANGES: { value: Range; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];
const PERIOD: Record<Range, [string, string]> = { today: ["Today", "yesterday"], week: ["This week", "last week"], month: ["This month", "last month"], year: ["This year", "last year"] };

/** The page's results by name. */
export type Page = Partial<Record<"time" | "active" | "turns" | "waiting" | "runs" | "fail" | "tokens" | "projects" | "heat" | "ai" | "memory" | "stalls" | "worst" | "size", StatResult>>;

/** Stats with no workspace (yours, cmd's model calls, cmd's own): every workspace's, whatever the scope. */
export const UNSCOPED = new Set(["you.active", "ai.calls", "core.memory", "core.stalls", "data.size"]);

/** A query in the window's scope: this workspace's, or every one's; what has no workspace is every one's. */
export const scoped = (q: StatQuery, scope: Scope): StatQuery => (scope === "all" || UNSCOPED.has(q.stat) ? { ...q, scope: "all" } : q);

/** The page's queries, the native page's: the same in both scopes, but for what they count. */
export function pageQueries(range: Range, scope: Scope): [keyof Page, StatQuery][] {
  const heat = "you.active";
  const qs: [keyof Page, StatQuery][] = [
    ["time", { stat: "agents.time", range, by: "agent", compare: true }],
    ["active", { stat: "you.active", range, compare: true }],
    ["turns", { stat: "agents.turns", range, by: "outcome", compare: true }],
    ["waiting", { stat: "agents.waiting", range, measure: "sum", quantiles: true }],
    ["runs", { stat: "commands.runs", range, by: "command", top: 8, compare: true }],
    ["fail", { stat: "commands.failrate", range, by: "command", top: 50, compare: true }],
    ["tokens", { stat: "agents.tokens", range, by: "model", filter: { token: ["in", "out"] }, compare: true }],
    ["projects", { stat: "agents.time", range, by: "project", top: 6 }],
    ["heat", range === "year" ? { stat: heat, range: "365d", grain: "day" } : range === "today" ? { stat: heat, range: "today" } : { stat: heat, range: "30d", grain: "hour" }],
    ["ai", { stat: "ai.calls", range, by: "purpose", top: 6 }],
    ["memory", { stat: "core.memory", range }],
    ["stalls", { stat: "core.stalls", range }],
    ["worst", { stat: "core.stalls", range, measure: "max" }],
    ["size", { stat: "data.size", range }],
  ];
  return qs.map(([k, q]) => [k, scoped(q, scope)]);
}

// ── numbers and words as the Stats window writes them ──

const val = (r: StatResult, v = r.total) => fmt.value(v, r.stat.unit);

/** Which way a change went. */
export const trendOf = (cur: number, prev: number) => (Math.abs(cur - prev) <= Math.abs(prev) * 0.005 ? "flat" : cur > prev ? "up" : "down");

/** A stat's change against the range before, as a Delta: its text, which way, and which way is good. */
export function change(r: StatResult | undefined): { text: string; trend: "up" | "down" | "flat"; good?: "up" | "down" } | null {
  if (!r?.previous) return null;
  const text = fmt.delta(r.total, r.previous.total, r.stat.unit);
  return text ? { text, trend: trendOf(r.total, r.previous.total), ...(r.stat.good ? { good: r.stat.good } : {}) } : null;
}

/** Each bucket's short label (x axis) and long one (readout), by grain and range, in the app's locale. */
export function bucketLabels(r: StatResult, range: Range | "detail", locale?: string): { labels: string[]; longLabels: string[] } {
  const d = (t: number) => new Date(t);
  const g = r.grain;
  const labels = r.buckets.map((t, i) =>
    g === "hour"
      ? String(d(t).getHours()).padStart(2, "0")
      : g === "day"
        ? range === "week" || r.buckets.length <= 7
          ? d(t).toLocaleDateString(locale, { weekday: "narrow" })
          : String(d(t).getDate())
        : g === "week"
          ? i === 0 || d(t).getMonth() !== d(r.buckets[i - 1]!).getMonth()
            ? d(t).toLocaleDateString(locale, { month: "short" })
            : ""
          : d(t).toLocaleDateString(locale, { month: "short" }),
  );
  const longLabels = r.buckets.map((t) =>
    g === "hour"
      ? d(t).toLocaleString(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" })
      : g === "week"
        ? `Week of ${d(t).toLocaleDateString(locale, { day: "numeric", month: "short" })}`
        : g === "month"
          ? d(t).toLocaleDateString(locale, { month: "long", year: "numeric" })
          : d(t).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" }),
  );
  return { labels, longLabels };
}

/** The bucket now falls in, if it's on the chart. */
export function currentIndex(r: StatResult, now = Date.now()): number | null {
  const i = r.buckets.findIndex((b, k) => b <= now && now < (r.buckets[k + 1] ?? r.to));
  return i >= 0 ? i : null;
}

/** All series added up per bucket (a sparkline of the whole). */
const totals = (r: StatResult) => r.buckets.map((_, i) => (r.series.every((s) => s.values[i] === null) ? null : r.series.reduce((a, s) => a + (s.values[i] ?? 0), 0)));

/** The page's opening line: what happened, in words, from the numbers. */
export function sentence(page: Page, range: Range): string {
  const [when, before] = PERIOD[range];
  const t = page.time;
  if (!t) return "";
  if (!t.total) return `${when}: no agent work yet.`;
  const projects = page.projects?.ranking?.length ?? 0;
  const d = t.previous ? fmt.delta(t.total, t.previous.total) : "";
  const more = d && d !== "new" && d !== "±0%" ? `, ${d.replace(/^[+−]/, "")} ${trendOf(t.total, t.previous!.total) === "up" ? "more" : "less"} than ${before}` : "";
  return `${when}: agents worked ${val(t)}${projects > 1 ? ` across ${projects} projects` : ""}${more}.`;
}

/** The week's first day in a locale (Monday where the runtime can't tell). */
export function firstDay(locale?: string): 0 | 1 | 6 {
  try {
    const d = (new Intl.Locale(locale ?? Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & { getWeekInfo?(): { firstDay: number } }).getWeekInfo?.().firstDay ?? 1;
    return d === 7 ? 0 : d === 6 ? 6 : 1;
  } catch {
    return 1;
  }
}

/** When you work: today by hour, a week or month as weekday × hour over the last 30 days, a year as a calendar. */
function heatChart(r: StatResult, range: Range, locale: string | undefined, now: number) {
  const values = r.series[0]?.values ?? [];
  if (range === "year") {
    const start = r.buckets[0] ?? r.from;
    const dayLabels = values.map((_, i) => new Date(new Date(start).setDate(new Date(start).getDate() + i)).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" }));
    return <Calendar start={start} values={values} unit="ms" label={`Active ${val(r)} this year`} dayLabels={dayLabels} />;
  }
  if (range === "today") return <TimeBars {...bucketLabels(r, "today", locale)} buckets={r.buckets} series={r.series} current={currentIndex(r, now)} unit="ms" label="Active time per hour" summary={`Active ${val(r)}`} />;
  // Hours of the last 30 days, folded into the week: rows from the locale's first day of the week.
  const first = firstDay(locale);
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  r.buckets.forEach((b, i) => {
    const d = new Date(b);
    grid[(d.getDay() - first + 7) % 7]![d.getHours()]! += values[i] ?? 0;
  });
  const rows = Array.from({ length: 7 }, (_, k) => new Date(2024, 0, 7 + first + k).toLocaleDateString(locale, { weekday: "short" }));
  return <PunchCard values={grid} rows={rows} unit="ms" label={`Active ${val(r)} in 30 days`} />;
}

/** Live stats by name, one `useStat` each. The list is the same length every render (`pageQueries`), so the hooks keep their order. */
function useStats<K extends string>(queries: [K, StatQuery][]): Partial<Record<K, StatResult>> {
  const out: Partial<Record<K, StatResult>> = {};
  for (const [k, q] of queries) {
    const r = useStat(q);
    if (r) out[k] = r;
  }
  return out;
}

/**
 * What a stat cmd refused (or couldn't count) leaves: the page in its error state, saying why,
 * with Try Again, which subscribes again. A change of range, scope or stat starts over (`key`).
 */
class Counted extends Component<{ toolbar: ReactNode; children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  override render() {
    if (this.state.error === null) return this.props.children;
    return <View state={{ kind: "error", title: "Couldn't count", text: this.state.error, action: { label: "Try Again", run: () => this.setState({ error: null }) } }}>{this.props.toolbar}</View>;
  }
}

const scopeMenu = (scope: Scope, setScope: (s: Scope) => void) => [
  { label: "This Workspace", checked: scope === "workspace", run: () => setScope("workspace") },
  { label: "All Workspaces", checked: scope === "all", run: () => setScope("all") },
];

export default function UsageStats() {
  const [scope, setScope] = useStoredState<Scope>("scope", "workspace");
  const [range, setRange] = useStoredState<Range>("range", "week");
  // The open detail is the window's, so it is still open after a reload.
  const [open, setOpen] = useStoredState<{ stat: string; by: string | null } | null>("open", null);
  const ranges = <ToolbarSegmented label="Range" value={range} onChange={(v) => setRange(v as Range)} options={RANGES} />;
  const back = <ToolbarButton icon="chevron.left" label="Stats" showLabel secondary onClick={() => setOpen(null)} />;
  return (
    <Window menu={scopeMenu(scope, setScope)}>
      {open ? (
        <Counted key={`${scope}:${range}:${open.stat}:${open.by}`} toolbar={<WindowToolbar label="Stat">{back}{ranges}</WindowToolbar>}>
          <Detail scope={scope} range={range} stat={open.stat} by={open.by} onBy={(by) => setOpen({ ...open, by })} ranges={ranges} back={back} />
        </Counted>
      ) : (
        <Counted key={`${scope}:${range}`} toolbar={<WindowToolbar label="Stats">{ranges}</WindowToolbar>}>
          <Overview scope={scope} range={range} ranges={ranges} onOpen={(stat) => setOpen({ stat, by: null })} />
        </Counted>
      )}
    </Window>
  );
}

function Overview({ scope, range, ranges, onOpen }: { scope: Scope; range: Range; ranges: ReactNode; onOpen: (stat: string) => void }) {
  const queries = pageQueries(range, scope);
  const page = useStats(queries);
  const { locale } = useEnv();
  const now = Date.now();
  const toolbar = <WindowToolbar label="Stats">{ranges}</WindowToolbar>;
  // As the native page: loading until every number is in.
  if (queries.some(([k]) => !page[k])) return <View state={{ kind: "loading" }}>{toolbar}</View>;

  const { time, turns, waiting, runs, fail, tokens, projects, heat, ai, memory, stalls, worst, size } = page as Required<Page>;
  const partial = Object.values(page).find((r) => r?.partial)?.partial;
  const tile = (key: keyof Page, label: string, r = page[key]!) => {
    const d = change(r);
    return (
      <Stat key={key} label={label} value={val(r)} {...(d ? { delta: d.text, trend: d.trend, good: d.good } : {})} onSelect={() => onOpen(r.stat.id)}>
        <Sparkline values={totals(r)} color={key === "time" ? "current" : "neutral"} />
      </Stat>
    );
  };
  const failBy = new Map((fail.ranking ?? []).map((x) => [x.key, x.value]));
  return (
    <View inset>
      {toolbar}
      <Stack gap={6}>
        <Text>{sentence(page, range)}</Text>
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
          <Pane title="Agent time" aside={`per ${time.grain}`}>
            <TimeBars {...bucketLabels(time, range, locale)} buckets={time.buckets} series={time.series} previous={time.series.length === 1 ? time.previous?.values : undefined} current={currentIndex(time, now)} unit="ms" average label="Agent time" summary={time.series.length > 1 ? `${time.series[0]!.label} ${Math.round((100 * time.series[0]!.total) / (time.total || 1))}%` : "All agents"} onSelect={() => onOpen(time.stat.id)} />
          </Pane>
          <Pane title="Turns" aside="how they ended">
            <Stack gap={4}>
              <Proportion unit={turns.stat.unit} parts={turns.series.map((s) => ({ key: s.key, label: s.label, value: s.total }))} />
              {waiting.total > 0 && <Text tone="dim">{`Agents waited on you ${val(waiting)}${waiting.quantiles ? `, ${val(waiting, waiting.quantiles.p50)} at a time` : ""}.`}</Text>}
            </Stack>
          </Pane>
          <Pane title="Commands" aside="runs">
            <Ranking unit={runs.stat.unit} rows={(runs.ranking ?? []).map((x) => ({ key: x.key, label: x.label || "Other", value: x.value, note: failBy.get(x.key) ? `${fmt.value(failBy.get(x.key)!, "percent")} failed` : "" }))} onSelect={() => onOpen(runs.stat.id)} empty="No commands yet" />
          </Pane>
          <Pane title="When you work" aside={range === "year" ? "per day" : range === "today" ? "per hour" : "last 30 days"} wide={range === "year"}>
            {heatChart(heat, range, locale, now)}
          </Pane>
          <Pane title="Projects" aside="agent time">
            <Ranking unit="ms" rows={(projects.ranking ?? []).map((x) => ({ key: x.key, label: x.label || "Other", value: x.value }))} empty="No agent work yet" />
          </Pane>
          <Pane title="Tokens" aside="by model">
            <TimeBars {...bucketLabels(tokens, range, locale)} buckets={tokens.buckets} series={tokens.series} current={currentIndex(tokens, now)} unit="tokens" label="Tokens by model" summary={`${val(tokens)} in and out`} onSelect={() => onOpen(tokens.stat.id)} />
          </Pane>
          <Pane title="cmd's model calls" aside="by feature">
            <Ranking unit={ai.stat.unit} rows={(ai.ranking ?? []).map((x) => ({ key: x.key, label: x.label || "Other", value: x.value }))} onSelect={() => onOpen(ai.stat.id)} empty="No model calls yet" />
          </Pane>
          <Pane title="cmd" aside="core memory">
            <Stack gap={2}>
              <TimeSeries {...bucketLabels(memory, range, locale)} buckets={memory.buckets} series={memory.series} current={currentIndex(memory, now)} unit="bytes" label="Core memory" summary={`${val(memory)} on average`} height={90} onSelect={() => onOpen(memory.stat.id)} />
              <Text tone="dim">{`${stalls.total ? `${stalls.total} ${stalls.total === 1 ? "stall" : "stalls"} of the core${worst.total ? `, the worst ${val(worst)}` : ""}` : "No stalls of the core"}${size.total ? ` · event log ${val(size)}` : ""}.`}</Text>
            </Stack>
          </Pane>
        </Panes>
      </Stack>
      <StatusLine>{partial ? `Counting since ${new Date(partial.since).toLocaleDateString(locale, { day: "numeric", month: "short" })}` : `Updated ${new Date(time.asOf ?? now).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`}</StatusLine>
    </View>
  );
}

interface DetailProps {
  scope: Scope;
  range: Range;
  stat: string;
  by: string | null;
  onBy: (by: string | null) => void;
  ranges: ReactNode;
  back: ReactNode;
}

/** The detail's query: the whole range compared, its spread, and with a split its ranking. */
export const detailQuery = (stat: string, range: Range, by: string | null, scope: Scope): StatQuery => scoped({ stat, range, compare: true, quantiles: true, ...(by ? { by, top: 12 } : {}) }, scope);

/** One stat on its own: its chart large with its change and spread, split by one of its dimensions, and its ranking. */
function Detail({ scope, range, stat, by, onBy, ranges, back }: DetailProps) {
  const r = useStat(detailQuery(stat, range, by, scope));
  const { locale } = useEnv();
  // Split by what has few values (a ranking is for the many); in one workspace, never by workspace.
  const dims = (r?.stat.dims ?? []).filter((d) => !d.many && (scope === "all" || UNSCOPED.has(stat) || d.id !== "workspace")).slice(0, 3);
  const toolbar = (
    <WindowToolbar label="Stat">
      {back}
      {ranges}
      <ToolbarSpacer />
      {dims.length > 0 && <ToolbarSegmented label="Split by" value={by ?? ""} onChange={(v) => onBy(v || null)} options={[{ value: "", label: "Total" }, ...dims.map((d) => ({ value: d.id, label: d.title }))]} />}
    </WindowToolbar>
  );
  if (!r) return <View state={{ kind: "loading" }}>{toolbar}</View>;
  const line = r.stat.kind === "gauge" || r.stat.kind === "distribution" || r.stat.unit === "percent";
  const d = change(r);
  const props = {
    ...bucketLabels(r, "detail", locale),
    buckets: r.buckets,
    series: r.series,
    previous: r.series.length === 1 ? r.previous?.values : undefined,
    current: currentIndex(r),
    unit: r.stat.unit,
    label: r.stat.title,
    height: 200,
    summary: val(r),
    ...(d ? { delta: d } : {}),
    ...(r.quantiles ? { note: `median ${val(r, r.quantiles.p50)}, 90% under ${val(r, r.quantiles.p90)}` } : {}),
  };
  const ranked = r.stat.dims.find((x) => x.id === by) ?? r.stat.dims.find((x) => x.many);
  return (
    <View inset>
      {toolbar}
      <Panes>
        <Pane title={r.stat.title} aside={r.measure === "p50" ? "median" : `per ${r.grain}`} wide>
          {line ? <TimeSeries {...props} /> : <TimeBars {...props} average />}
        </Pane>
        {r.ranking && r.ranking.length > 0 && (
          <Pane title={`By ${ranked?.title.toLowerCase() ?? "value"}`} aside={r.stat.unit === "ms" ? "time" : r.stat.unit}>
            <Ranking unit={r.stat.unit} rows={r.ranking.map((x) => ({ key: x.key, label: x.label || "Other", value: x.value }))} />
          </Pane>
        )}
      </Panes>
      <StatusLine>{r.stat.description}</StatusLine>
    </View>
  );
}
