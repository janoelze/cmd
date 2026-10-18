// The Stats widget with made-up results: a busy week, today, a year (the calendar), the log
// still being counted, nothing yet, loading and an error; a stat's detail split by agent and
// by command; every size.
import { useState } from "react";
import type { StatInfo, StatResult, StatUnit } from "@cmd/protocol";
import { AllSizes, RefWindow, type SizeName } from "../../reference/RefWindow.tsx";
import { StatDetail, Stats, type StatsData, type StatsRange } from "./Stats.tsx";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 14, 15, 20).getTime(); // a Wednesday afternoon
const noise = (i: number) => Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;

const info = (id: string, title: string, unit: StatUnit, kind: StatInfo["kind"], dims: string[] = [], good?: "up" | "down"): StatInfo => ({ id, title, description: `${title}, made up for the story.`, kind, unit, dims: dims.map((d) => ({ id: d, title: d[0]!.toUpperCase() + d.slice(1), ...(d === "command" ? { many: true } : {}) })), measure: kind === "count" ? "n" : "sum", class: "agents", available: true, ...(good ? { good } : {}) });

/** A week of day buckets ending today (Monday first), or another run of buckets. */
function result(stat: StatInfo, o: { range?: StatsRange; series?: [string, string, number][]; scale: number; seed: number; ranking?: [string, number][]; empty?: boolean; partialDays?: number; grain?: StatResult["grain"]; n?: number }): StatResult {
  const grain = o.grain ?? (o.range === "today" ? "hour" : o.range === "year" ? "week" : "day");
  const n = o.n ?? (grain === "hour" ? 24 : o.range === "month" ? 31 : o.range === "year" ? 53 : 7);
  const step = grain === "hour" ? HOUR : grain === "week" ? 7 * DAY : DAY;
  const start = grain === "hour" && n > 24 ? new Date(NOW).setHours(0, 0, 0, 0) - (n / 24 - 1) * DAY : grain === "day" && n > 31 ? new Date(NOW).setHours(0, 0, 0, 0) - (n - 1) * DAY : grain === "hour" ? new Date(NOW).setHours(0, 0, 0, 0) : grain === "week" ? NOW - 52 * 7 * DAY : o.range === "month" ? new Date(2026, 9, 1).getTime() : new Date(NOW).setHours(0, 0, 0, 0) - 2 * DAY;
  const buckets = Array.from({ length: n }, (_, i) => start + i * step);
  const since = o.partialDays ? NOW - o.partialDays * DAY : null;
  const value = (k: number, i: number, share: number) => (buckets[i]! > NOW || (since && buckets[i]! + step <= since) ? null : o.empty ? 0 : Math.round(share * o.scale * (0.3 + noise(o.seed + i * 7 + k))));
  const parts = o.series ?? [["total", "Total", 1]];
  const series = parts.map(([key, label, share], k) => {
    const values = buckets.map((_, i) => value(k, i, share));
    return { key, label, values, total: values.reduce<number>((a, v) => a + (v ?? 0), 0) };
  });
  const total = series.reduce((a, s) => a + s.total, 0);
  return { stat, from: buckets[0]!, to: buckets[n - 1]! + step, grain, measure: stat.measure, buckets, series, total, asOf: NOW, ...(since ? { partial: { since } } : { previous: { total: Math.round(total * (0.8 + 0.4 * noise(o.seed))), values: buckets.map((_, i) => Math.round(o.scale * (0.3 + noise(o.seed + 99 + i)))) } }), ...(o.ranking ? { ranking: o.ranking.map(([key, value]) => ({ key, label: key.replace(/^dir:.*\//, ""), value })) } : {}) };
}

function week(range: StatsRange = "week", o: { empty?: boolean; partialDays?: number } = {}): StatsData {
  const r = { range, ...o };
  const empty = !!o.empty;
  return {
    time: result(info("agents.time", "Agent time", "ms", "duration", ["agent", "project", "workspace"]), { ...r, seed: 1, scale: (range === "today" ? 0.6 : range === "year" ? 40 : 9) * HOUR, series: [["claude", "Claude", 0.8], ["codex", "Codex", 0.15], ["gemini", "Gemini", 0.05]] }),
    active: result(info("you.active", "Active time", "ms", "duration"), { ...r, seed: 2, scale: (range === "today" ? 0.5 : range === "year" ? 20 : 5) * HOUR }),
    turns: result(info("agents.turns", "Turns", "count", "count", ["agent", "outcome"]), { ...r, seed: 3, scale: 60, series: [["done", "Done", 0.9], ["interrupted", "Interrupted", 0.06], ["failed", "Failed", 0.04]] }),
    waiting: { ...result(info("agents.waiting", "Waiting on you", "ms", "distribution", ["agent"], "down"), { ...r, seed: 4, scale: 0.4 * HOUR }), quantiles: { p50: 95_000, p90: 14 * 60_000 } },
    runs: result(info("commands.runs", "Commands", "count", "count", ["result", "command"]), { ...r, seed: 5, scale: 120, ranking: empty ? [] : [["pnpm test", 212], ["git status", 148], ["pnpm typecheck", 91], ["pnpm e2e", 40], ["git log", 22], ["make", 12]] }),
    fail: result(info("commands.failrate", "Failed commands", "percent", "gauge", ["command"], "down"), { ...r, seed: 6, scale: 9, ranking: [["pnpm test", 9], ["pnpm e2e", 15], ["pnpm typecheck", 3]] }),
    tokens: result(info("agents.tokens", "Tokens", "tokens", "sum", ["token", "model", "project"]), { ...r, seed: 7, scale: 900_000, series: [["claude-opus-5-5", "claude-opus-5-5", 0.85], ["claude-haiku-5-5", "claude-haiku-5-5", 0.15]] }),
    projects: result(info("agents.time", "Agent time", "ms", "duration", ["agent", "project"]), { ...r, seed: 8, scale: 9 * HOUR, ranking: empty ? [] : [["dir:/src/cmd", 61 * HOUR], ["dir:/src/site", 9 * HOUR], ["dir:/src/notes", 2 * HOUR]] }),
    heat: range === "year" ? result(info("you.active", "Active time", "ms", "duration"), { seed: 9, scale: 6 * HOUR, grain: "day", n: 365, empty }) : range === "today" ? result(info("you.active", "Active time", "ms", "duration"), { range: "today", seed: 9, scale: 0.6 * HOUR, empty }) : result(info("you.active", "Active time", "ms", "duration"), { seed: 9, scale: 0.4 * HOUR, grain: "hour", n: 30 * 24, empty }),
    memory: result({ ...info("core.memory", "Core memory", "bytes", "gauge"), measure: "mean" }, { ...r, seed: 11, scale: 380e6 }),
    stalls: result({ ...info("core.stalls", "Core stalls", "count", "distribution"), measure: "n" }, { ...r, seed: 12, scale: 2, empty }),
    worst: { ...result({ ...info("core.stalls", "Core stalls", "ms", "distribution"), measure: "max" }, { ...r, seed: 12, scale: 1 }), total: empty ? 0 : 412 },
    size: { ...result(info("data.size", "Event log size", "bytes", "gauge"), { ...r, seed: 13, scale: 1 }), total: 2.9e9 },
    ai: result(info("ai.calls", "Model calls", "count", "count", ["purpose", "model"]), { ...r, seed: 10, scale: 30, ranking: empty ? [] : [["notify.done", 812], ["session.name", 410], ["journal.day", 64], ["summary", 12]] }),
  };
}

function Page({ size = "wide", range: start = "week", data, error }: { size?: SizeName; range?: StatsRange; data?: StatsData | null; error?: string }) {
  const [range, setRange] = useState<StatsRange>(start);
  const [open, setOpen] = useState<string | null>(null);
  const [by, setBy] = useState<string | null>("agent");
  const d = data === undefined ? week(range) : data;
  return (
    <RefWindow icon="chart-bar" name="Stats" size={size}>
      {open && d ? <StatDetail result={{ ...d.time!, stat: { ...d.time!.stat }, series: by ? d.time!.series : [{ key: "total", label: "Total", values: d.time!.buckets.map((_, i) => d.time!.series.reduce((a, s) => a + (s.values[i] ?? 0), 0)), total: d.time!.total }], ranking: d.projects!.ranking }} range={range} by={by} onBy={setBy} onRange={setRange} onBack={() => setOpen(null)} now={NOW} /> : <Stats range={range} data={d} error={error} onRange={setRange} onOpen={setOpen} onRetry={() => {}} now={NOW} />}
    </RefWindow>
  );
}

/** A busy week: the overview, every section. Click a number for its detail. */
export const Week = () => <Page />;
/** Today, by hour: the open hour in the accent, the rest of the day still to come. */
export const Today = () => <Page range="today" />;
/** A year: weeks along the bars, active time as a calendar. */
export const Year = () => <Page range="year" />;
/** The log is younger than the range: numbers start on its first day, the footer says so, no comparison. */
export const Counting = () => <Page data={week("week", { partialDays: 3 })} />;
/** Nothing recorded yet. */
export const Nothing = () => <Page data={week("week", { empty: true })} />;
export const Loading = () => <Page data={null} />;
export const Failed = () => <Page data={null} error="The core didn't answer." />;
/** A stat on its own, split by agent, with its ranking. */
export const Detail = () => {
  const d = week();
  return (
    <RefWindow icon="chart-bar" name="Stats" size="wide">
      <StatDetail result={{ ...d.time!, ranking: d.projects!.ranking }} range="week" by="agent" onBy={() => {}} onRange={() => {}} onBack={() => {}} now={NOW} />
    </RefWindow>
  );
};
export const Sizes = () => <AllSizes render={(s) => <Page size={s} />} />;
