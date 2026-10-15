// Usage Stats, a built-in widget package (docs/57; the native Stats window's job, docs/49): how
// you and your agents used cmd in this workspace (or in every one, from the title menu), as one
// page read top to bottom. A sentence, headline numbers with their change, then a pane per area:
// agent time per bucket, how turns ended and how long agents waited on you, the commands run
// most and how often they failed, when work happens, tokens by model; with All Workspaces also
// your active time, projects and cmd's model calls. Every number opens its detail: a bigger
// chart, split by what the stat can be split by, and its ranking. Each pane is one
// `cmd.stats.query` (API 1.2); the page asks again when a command or an agent's turn is recorded
// (a few seconds later, once cmd has counted it) and once a minute (time spent grows without events). A stat the widget may
// not read leaves its pane out; when none can be read, the page says why.

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
  useEvents,
  useStoredState,
  cmd,
  type StatQuery,
  type StatResult,
  type Tone,
} from "@cmd/widget-api";
import { useEffect, useRef, useState } from "react";

export type Range = "today" | "week" | "month" | "year";
type Scope = "workspace" | "all";
type Unit = StatResult["stat"]["unit"];

export const RANGES: { value: Range; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];
const PERIOD: Record<Range, [string, string]> = { today: ["Today", "yesterday"], week: ["This week", "last week"], month: ["This month", "last month"], year: ["This year", "last year"] };

/** Asked again this long after a command or an agent's turn is recorded (cmd counts a second or two later), and this often anyway. */
export const SETTLE_MS = 2500;
export const REFRESH_MS = 60_000;

/** The page's results by name. */
export type Page = Partial<Record<"time" | "active" | "turns" | "waiting" | "waitingMedian" | "runs" | "fail" | "tokens" | "projects" | "heat" | "ai", StatResult>>;

/**
 * The page's queries. In one workspace: what can be told apart by workspace (or its folder's
 * project). With every workspace: also your active time (it has no workspace), projects and
 * cmd's model calls; "when you work" is then your active time, else the agents' time.
 */
export function pageQueries(range: Range, scope: Scope): [keyof Page, StatQuery][] {
  const all = scope === "all" ? ({ scope: "all" } as const) : {};
  const heat = scope === "all" ? "you.active" : "agents.time";
  const qs: [keyof Page, StatQuery][] = [
    ["time", { stat: "agents.time", range, by: "agent", compare: true }],
    ["turns", { stat: "agents.turns", range, by: "outcome", compare: true }],
    ["waiting", { stat: "agents.waiting", range, measure: "sum" }],
    ["waitingMedian", { stat: "agents.waiting", range, measure: "p50" }],
    ["runs", { stat: "commands.runs", range, by: "command", top: 8, compare: true }],
    ["fail", { stat: "commands.failrate", range, by: "command", top: 100, compare: true }],
    ["tokens", { stat: "agents.tokens", range, by: "model", filter: { token: ["in", "out"] }, compare: true }],
    ["heat", range === "year" ? { stat: heat, range: "365d", grain: "day" } : range === "today" ? { stat: heat, range: "today" } : { stat: heat, range: "30d", grain: "hour" }],
  ];
  if (scope === "all") qs.push(["active", { stat: "you.active", range, compare: true }], ["projects", { stat: "agents.time", range, by: "project", top: 6 }], ["ai", { stat: "ai.calls", range, by: "purpose", top: 6 }]);
  return qs.map(([k, q]) => [k, { ...q, ...all }]);
}

// ── numbers as the Stats window writes them ──

const one = (n: number) => (Math.round(n * 10) / 10).toString();
const whole = (n: number) => Math.round(n).toLocaleString("en-US");

/** 3h 12m, 48m, 12s; `short`: the largest unit only. */
export function duration(ms: number, short = false): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(ms / 60_000);
  if (m < 60) return short || s % 60 === 0 || m >= 10 ? `${m}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return short || m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return short || h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

const compact = (v: number) => {
  const a = Math.abs(v);
  const [d, s] = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "K"] : [1, ""];
  return `${Math.abs(v / d) >= 100 || !s ? whole(v / d) : one(v / d)}${s}`;
};

/** A value in its stat's unit. */
export function value(v: number, unit: Unit): string {
  if (unit === "ms") return duration(v);
  if (unit === "bytes") {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (v >= 1024 && i < units.length - 1) (v /= 1024), i++;
    return `${i ? one(v) : whole(v)} ${units[i]}`;
  }
  if (unit === "percent") return `${v < 10 && v > 0 ? one(v) : whole(v)}%`;
  return Math.abs(v) >= 10_000 ? compact(v) : v % 1 ? one(v) : whole(v);
}

/** The change from `prev` to `cur`: "+18%", "−4%", "new", "" (nothing either time); percentages by points. */
export function change(cur: number, prev: number, unit?: Unit): string {
  if (unit === "percent") {
    if (!cur && !prev) return "";
    const d = cur - prev;
    return Math.abs(d) < 0.05 ? "±0" : `${d > 0 ? "+" : "−"}${one(Math.abs(d))} pt`;
  }
  if (!prev) return cur ? "new" : "";
  const p = ((cur - prev) / prev) * 100;
  if (Math.abs(p) < 0.5) return "±0%";
  return `${p > 0 ? "+" : "−"}${Math.abs(p) >= 10 ? whole(Math.abs(p)) : one(Math.abs(p))}%`;
}

const trendOf = (cur: number, prev: number) => (Math.abs(cur - prev) <= Math.abs(prev) * 0.005 ? "flat" : cur > prev ? "up" : "down");

/** A stat's change against the range before, and its tone: green when it went the good way, red when not. */
export function delta(r: StatResult | undefined): { delta?: string; deltaTone?: Tone } {
  if (!r?.previous) return {};
  const text = change(r.total, r.previous.total, r.stat.unit);
  if (!text) return {};
  const trend = trendOf(r.total, r.previous.total);
  return { delta: text, ...(r.stat.good && trend !== "flat" ? { deltaTone: trend === r.stat.good ? "success" : "danger" } : {}) };
}

/** Each bucket's short label (x axis) and long one (readout), by grain and range. */
export function bucketLabels(r: StatResult, range: Range | "detail"): { labels: string[]; longLabels: string[] } {
  const d = (t: number) => new Date(t);
  const g = r.grain;
  const labels = r.buckets.map((t, i) =>
    g === "hour"
      ? String(d(t).getHours()).padStart(2, "0")
      : g === "day"
        ? range === "week" || r.buckets.length <= 7
          ? d(t).toLocaleDateString(undefined, { weekday: "narrow" })
          : String(d(t).getDate())
        : g === "week"
          ? i === 0 || d(t).getMonth() !== d(r.buckets[i - 1]!).getMonth()
            ? d(t).toLocaleDateString(undefined, { month: "short" })
            : ""
          : d(t).toLocaleDateString(undefined, { month: "short" }),
  );
  const longLabels = r.buckets.map((t) =>
    g === "hour"
      ? d(t).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
      : g === "week"
        ? `Week of ${d(t).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
        : g === "month"
          ? d(t).toLocaleDateString(undefined, { month: "long", year: "numeric" })
          : d(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }),
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
  const d = t.previous ? change(t.total, t.previous.total) : "";
  const more = d && d !== "new" && d !== "±0%" ? `, ${d.replace(/^[+−]/, "")} ${trendOf(t.total, t.previous!.total) === "up" ? "more" : "less"} than ${before}` : "";
  return `${when}: agents worked ${duration(t.total)}${projects > 1 ? ` across ${projects} projects` : ""}${more}.`;
}

/** The week's first day where the runtime knows it (Monday otherwise). */
function firstDay(): 0 | 1 | 6 {
  try {
    const d = (new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & { getWeekInfo?(): { firstDay: number } }).getWeekInfo?.().firstDay ?? 1;
    return d === 7 ? 0 : d === 6 ? 6 : 1;
  } catch {
    return 1;
  }
}

/** When work happens: today by hour, a week or month as weekday × hour over 30 days, a year as a calendar. */
function heatChart(r: StatResult, range: Range, who: string, now: number) {
  const values = r.series[0]?.values ?? [];
  if (range === "year") return <Calendar start={r.buckets[0] ?? r.from} values={values} unit="ms" firstDay={firstDay()} label={`${who} ${value(r.total, "ms")} this year`} />;
  if (range === "today") return <TimeBars {...bucketLabels(r, "today")} buckets={r.buckets} series={r.series} current={currentIndex(r, now)} unit="ms" label={`${who} per hour`} summary={`${who} ${value(r.total, "ms")}`} />;
  const first = firstDay();
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  r.buckets.forEach((b, i) => {
    const d = new Date(b);
    grid[(d.getDay() - first + 7) % 7]![d.getHours()]! += values[i] ?? 0;
  });
  const rows = Array.from({ length: 7 }, (_, k) => new Date(2024, 0, 7 + first + k).toLocaleDateString(undefined, { weekday: "short" }));
  return <PunchCard values={grid} rows={rows} unit="ms" label={`${who} ${value(r.total, "ms")} in 30 days`} />;
}

type Loaded<T> = { data: T | null; error: string | null; at?: number };

/**
 * Runs the queries now, again a second after a command or an agent's turn is recorded, and once a
 * minute. A query that fails leaves its result out; when every one fails, the first error is the page's.
 */
function useQueries<K extends string>(queries: [K, StatQuery][], key: string): Loaded<Partial<Record<K, StatResult>>> & { retry: () => void } {
  const [state, setState] = useState<Loaded<Partial<Record<K, StatResult>>>>({ data: null, error: null });
  const [tick, setTick] = useState(0);
  const gen = useRef(0);
  const shown = useRef(key);
  const latest = useEvents({ types: ["command", "agent.stop"], limit: 1 }).at(-1);
  const recorded = latest ? `${latest.id}:${latest.until ?? ""}` : "";
  const seen = useRef(recorded);

  useEffect(() => {
    const g = ++gen.current;
    if (shown.current !== key) setState({ data: null, error: null });
    shown.current = key;
    void Promise.allSettled(queries.map(([, q]) => cmd.stats.query(q))).then((rs) => {
      if (g !== gen.current) return;
      const data: Partial<Record<K, StatResult>> = {};
      rs.forEach((r, i) => r.status === "fulfilled" && (data[queries[i]![0]] = r.value));
      const failed = rs.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (Object.keys(data).length || !failed) setState({ data, error: null, at: Date.now() });
      else setState({ data: null, error: failed.reason instanceof Error ? failed.reason.message : String(failed.reason) });
    });
    const every = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(every);
    // The queries by value: `key` names them.
  }, [key, tick]);

  // Something was counted: ask again once it has settled.
  useEffect(() => {
    if (recorded === seen.current) return;
    seen.current = recorded;
    const t = setTimeout(() => setTick((n) => n + 1), SETTLE_MS);
    return () => clearTimeout(t);
  }, [recorded]);

  return { ...state, retry: () => setTick((n) => n + 1) };
}

const scopeMenu = (scope: Scope, setScope: (s: Scope) => void) => [
  { label: "This Workspace", checked: scope === "workspace", run: () => setScope("workspace") },
  { label: "All Workspaces", checked: scope === "all", run: () => setScope("all") },
];

export default function UsageStats() {
  const [scope, setScope] = useStoredState<Scope>("scope", "workspace");
  const [range, setRange] = useStoredState<Range>("range", "week");
  const [open, setOpen] = useState<{ stat: string; by: string | null } | null>(null);
  return (
    <Window menu={scopeMenu(scope, setScope)}>
      {open ? (
        <Detail scope={scope} range={range} stat={open.stat} by={open.by} onBy={(by) => setOpen({ ...open, by })} onRange={setRange} onBack={() => setOpen(null)} />
      ) : (
        <Overview scope={scope} range={range} onRange={setRange} onOpen={(stat) => setOpen({ stat, by: null })} />
      )}
    </Window>
  );
}

function Overview({ scope, range, onRange, onOpen }: { scope: Scope; range: Range; onRange: (r: Range) => void; onOpen: (stat: string) => void }) {
  const queries = pageQueries(range, scope);
  const { data: page, error, at, retry } = useQueries(queries, `${scope}:${range}`);
  const now = Date.now();
  const toolbar = (
    <WindowToolbar label="Stats">
      <ToolbarSegmented label="Range" value={range} onChange={(v) => onRange(v as Range)} options={RANGES} />
    </WindowToolbar>
  );
  const state = error
    ? { kind: "error" as const, title: "Couldn't count", text: error, action: { label: "Try Again", run: retry } }
    : !page
      ? { kind: "loading" as const }
      : null;
  if (!page) return <View state={state}>{toolbar}</View>;

  const partial = Object.values(page).find((r) => r?.partial)?.partial;
  const tile = (key: keyof Page, label: string, r = page[key]) =>
    r && (
      <Stack key={key} gap={1}>
        <Stat label={label} value={value(r.total, r.stat.unit)} {...delta(r)} onSelect={() => onOpen(r.stat.id)} />
        <Sparkline values={totals(r)} color={key === "time" ? "current" : "neutral"} />
      </Stack>
    );
  const { time, turns, waiting, waitingMedian, runs, fail, tokens, projects, heat, ai } = page;
  const failBy = new Map((fail?.ranking ?? []).map((x) => [x.key, x.value]));
  const who = scope === "all" ? "Active" : "Agents";
  return (
    <View inset>
      {toolbar}
      <Stack gap={6}>
        {time && <Text>{sentence(page, range)}</Text>}
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
            <Pane title="Agent time" aside={`per ${time.grain}`}>
              <TimeBars {...bucketLabels(time, range)} buckets={time.buckets} series={time.series} previous={time.series.length === 1 ? time.previous?.values : undefined} current={currentIndex(time, now)} unit="ms" average label="Agent time" summary={time.series.length > 1 ? `${time.series[0]!.label} ${Math.round((100 * time.series[0]!.total) / (time.total || 1))}%` : "All agents"} onSelect={() => onOpen(time.stat.id)} />
            </Pane>
          )}
          {turns && (
            <Pane title="Turns" aside="how they ended">
              <Stack gap={4}>
                <Proportion unit={turns.stat.unit} parts={turns.series.map((s) => ({ key: s.key, label: s.label, value: s.total }))} />
                {waiting && waiting.total > 0 && (
                  <Text tone="dim">
                    {`Agents waited on you ${duration(waiting.total)}${waitingMedian?.total ? `, ${duration(waitingMedian.total)} at a time` : ""}.`}
                  </Text>
                )}
              </Stack>
            </Pane>
          )}
          {runs && (
            <Pane title="Commands" aside="runs">
              <Ranking unit={runs.stat.unit} rows={(runs.ranking ?? []).map((x) => ({ key: x.key, label: x.label || "Other", value: x.value, note: failBy.get(x.key) ? `${value(failBy.get(x.key)!, "percent")} failed` : "" }))} onSelect={() => onOpen(runs.stat.id)} empty="No commands yet" />
            </Pane>
          )}
          {heat && (
            <Pane title={scope === "all" ? "When you work" : "When agents work"} aside={range === "year" ? "per day" : range === "today" ? "per hour" : "last 30 days"} wide={range === "year"}>
              {heatChart(heat, range, who, now)}
            </Pane>
          )}
          {projects && (
            <Pane title="Projects" aside="agent time">
              <Ranking unit="ms" rows={(projects.ranking ?? []).map((x) => ({ key: x.key, label: x.label || "Other", value: x.value }))} empty="No agent work yet" />
            </Pane>
          )}
          {tokens && (
            <Pane title="Tokens" aside="by model">
              <TimeBars {...bucketLabels(tokens, range)} buckets={tokens.buckets} series={tokens.series} current={currentIndex(tokens, now)} unit="tokens" label="Tokens by model" summary={`${value(tokens.total, "tokens")} in and out`} onSelect={() => onOpen(tokens.stat.id)} />
            </Pane>
          )}
          {ai && (
            <Pane title="cmd's model calls" aside="by feature">
              <Ranking unit={ai.stat.unit} rows={(ai.ranking ?? []).map((x) => ({ key: x.key, label: x.label || "Other", value: x.value }))} onSelect={() => onOpen(ai.stat.id)} empty="No model calls yet" />
            </Pane>
          )}
        </Panes>
      </Stack>
      <StatusLine>{partial ? `Counting since ${new Date(partial.since).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : `Updated ${new Date(at ?? now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}</StatusLine>
    </View>
  );
}

interface DetailProps {
  scope: Scope;
  range: Range;
  stat: string;
  by: string | null;
  onBy: (by: string | null) => void;
  onRange: (r: Range) => void;
  onBack: () => void;
}

/** One stat on its own: its chart large, split by one of its dimensions, and its ranking. */
function Detail({ scope, range, stat, by, onBy, onRange, onBack }: DetailProps) {
  const q: StatQuery = { stat, range, compare: true, ...(by ? { by, top: 12 } : {}), ...(scope === "all" ? { scope } : {}) };
  const { data, error, retry } = useQueries([["r", q]], JSON.stringify(q));
  const r = data?.r;
  // In one workspace, a split by workspace (or by the one project) says nothing.
  const dims = (r?.stat.dims ?? []).filter((d) => scope === "all" || (d.id !== "workspace" && d.id !== "project")).slice(0, 3);
  const toolbar = (
    <WindowToolbar label="Stat">
      <ToolbarButton icon="chevron.left" label="Stats" showLabel secondary onClick={onBack} />
      <ToolbarSegmented label="Range" value={range} onChange={(v) => onRange(v as Range)} options={RANGES} />
      <ToolbarSpacer />
      {dims.length > 0 && <ToolbarSegmented label="Split by" value={by ?? ""} onChange={(v) => onBy(v || null)} options={[{ value: "", label: "Total" }, ...dims.map((d) => ({ value: d.id, label: d.title }))]} />}
    </WindowToolbar>
  );
  if (!r) return <View state={error ? { kind: "error", title: "Couldn't count", text: error, action: { label: "Try Again", run: retry } } : { kind: "loading" }}>{toolbar}</View>;
  const line = r.stat.unit === "percent" || r.measure === "p50" || r.measure === "p90" || r.measure === "max";
  const d = delta(r);
  const props = { ...bucketLabels(r, "detail"), buckets: r.buckets, series: r.series, previous: r.series.length === 1 ? r.previous?.values : undefined, current: currentIndex(r), unit: r.stat.unit, label: r.stat.title, height: 200, summary: [value(r.total, r.stat.unit), d.delta].filter(Boolean).join(" · ") };
  const split = r.stat.dims.find((x) => x.id === by);
  return (
    <View inset>
      {toolbar}
      <Panes>
        <Pane title={r.stat.title} aside={r.measure === "p50" ? "median" : `per ${r.grain}`} wide>
          {line ? <TimeSeries {...props} /> : <TimeBars {...props} average />}
        </Pane>
        {r.ranking && r.ranking.length > 0 && (
          <Pane title={`By ${split?.title.toLowerCase() ?? "value"}`} aside={r.stat.unit === "ms" ? "time" : r.stat.unit}>
            <Ranking unit={r.stat.unit} rows={r.ranking.map((x) => ({ key: x.key, label: x.label || "Other", value: x.value }))} />
          </Pane>
        )}
      </Panes>
      {r.stat.description ? <StatusLine>{r.stat.description}</StatusLine> : null}
    </View>
  );
}
