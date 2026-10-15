// Usage Stats' states for the UI Workbench (`pnpm workbench widgets/stats`): the widget against
// the fake host, one variant per state. The numbers are the native Stats window's story's
// (windows/stats/Stats.story.tsx: the same seeds, scales and splits, on a Wednesday afternoon),
// so the two can be compared side by side. `cmd widget preview` draws the first six.

import type { HostData } from "@cmd/widget-api/testing/host";
import type { StatQuery, StatResult } from "@cmd/widget-api";
import UsageStats from "./stats.tsx";

export default UsageStats;

/** A state in a wide window, the native story's size, in a British locale (24-hour times, weeks from Monday) as on the machine the two were compared on. */
type State = HostData & { size?: "narrow" | "regular" | "wide" };
const wide = (data: HostData): State => ({ ...data, env: { locale: "en-GB" }, size: "wide" });

type Info = StatResult["stat"];
type Range = "today" | "week" | "month" | "year";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 14, 15, 20).getTime(); // the native story's Wednesday afternoon
const noise = (i: number) => Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;

const info = (id: string, title: string, unit: Info["unit"], kind: Info["kind"], dims: string[] = [], good?: "up" | "down"): Info => ({ id, title, description: `${title}, made up for the story.`, kind, unit, dims: dims.map((d) => ({ id: d, title: d[0]!.toUpperCase() + d.slice(1), ...(d === "command" ? { many: true } : {}) })), class: "agents", ...(good ? { good } : {}) });

/** The native story's result(): a run of buckets ending now, a series per split, the range before. */
function result(stat: Info, o: { range?: Range; series?: [string, string, number][]; scale: number; seed: number; ranking?: [string, number][]; empty?: boolean; partialDays?: number; grain?: StatResult["grain"]; n?: number; measure?: StatResult["measure"] }): StatResult {
  const grain = o.grain ?? (o.range === "today" ? "hour" : o.range === "year" ? "week" : "day");
  const n = o.n ?? (grain === "hour" ? 24 : o.range === "month" ? 31 : o.range === "year" ? 53 : 7);
  const step = grain === "hour" ? HOUR : grain === "week" ? 7 * DAY : DAY;
  const start = grain === "hour" && n > 24 ? new Date(NOW).setHours(0, 0, 0, 0) - (n / 24 - 1) * DAY : grain === "day" && n > 31 ? new Date(NOW).setHours(0, 0, 0, 0) - (n - 1) * DAY : grain === "hour" ? new Date(NOW).setHours(0, 0, 0, 0) : grain === "week" ? NOW - 52 * 7 * DAY : o.range === "month" ? new Date(2026, 9, 1).getTime() : new Date(NOW).setHours(0, 0, 0, 0) - 2 * DAY;
  const buckets = Array.from({ length: n }, (_, i) => start + i * step);
  const since = o.partialDays ? NOW - o.partialDays * DAY : null;
  const value = (k: number, i: number, share: number) => (buckets[i]! > NOW || (since && buckets[i]! + step <= since) ? null : o.empty ? 0 : Math.round(share * o.scale * (0.3 + noise(o.seed + i * 7 + k))));
  const series = (o.series ?? [["total", "Total", 1]]).map(([key, label, share], k) => {
    const values = buckets.map((_, i) => value(k, i, share));
    return { key, label, values, total: values.reduce<number>((a, v) => a + (v ?? 0), 0) };
  });
  const total = series.reduce((a, s) => a + s.total, 0);
  return { stat, from: buckets[0]!, to: buckets[n - 1]! + step, grain, measure: o.measure ?? (stat.kind === "count" ? "n" : "sum"), buckets, series, total, asOf: NOW, ...(since ? { partial: { since } } : { previous: { total: Math.round(total * (0.8 + 0.4 * noise(o.seed))), values: buckets.map((_, i) => Math.round(o.scale * (0.3 + noise(o.seed + 99 + i)))) } }), ...(o.ranking ? { ranking: o.ranking.map(([key, value]) => ({ key, label: key.replace(/^dir:.*\//, ""), value })) } : {}) };
}

/** The native story's week(), by what a query asks for. */
function stats(o: { empty?: boolean; partialDays?: number; refuse?: string } = {}) {
  const empty = !!o.empty;
  return (q: StatQuery): StatResult => {
    const range: Range = q.range === "today" || q.range === "month" || q.range === "year" ? q.range : "week";
    const r = { range, empty, partialDays: o.partialDays };
    const scale = (today: number, year: number, other: number) => (range === "today" ? today : range === "year" ? year : other) * HOUR;
    switch (q.stat) {
      case "agents.time": {
        if (q.by === "project") return result(info("agents.time", "Agent time", "ms", "count", ["agent", "project"]), { ...r, seed: 8, scale: 9 * HOUR, ranking: empty ? [] : [["dir:/src/cmd", 61 * HOUR], ["dir:/src/site", 9 * HOUR], ["dir:/src/notes", 2 * HOUR]] });
        const t = result(info("agents.time", "Agent time", "ms", "count", ["agent", "project", "workspace"]), { ...r, seed: 1, scale: scale(0.6, 40, 9), series: q.by === "agent" || !q.by ? [["claude", "Claude", 0.8], ["codex", "Codex", 0.15], ["gemini", "Gemini", 0.05]] : undefined });
        // The detail: the whole without a split, and a split's ranking (the native story ranks its projects).
        if (q.quantiles && !q.by) t.series = [{ key: "total", label: "Total", values: t.buckets.map((_, i) => t.series.reduce<number | null>((a, s) => (s.values[i] === null ? a : (a ?? 0) + s.values[i]!), null)), total: t.total }];
        if (q.quantiles && q.by) t.ranking = [["cmd", 61 * HOUR], ["site", 9 * HOUR], ["notes", 2 * HOUR]].map(([key, value]) => ({ key: String(key), label: String(key), value: Number(value) }));
        return t;
      }
      case "you.active":
        if (q.range === "365d") return result(info("you.active", "Active time", "ms", "count"), { seed: 9, scale: 6 * HOUR, grain: "day", n: 365, empty });
        if (q.range === "30d") return result(info("you.active", "Active time", "ms", "count"), { seed: 9, scale: 0.4 * HOUR, grain: "hour", n: 30 * 24, empty });
        if (!q.compare) return result(info("you.active", "Active time", "ms", "count"), { range: "today", seed: 9, scale: 0.6 * HOUR, empty });
        return result(info("you.active", "Active time", "ms", "count"), { ...r, seed: 2, scale: scale(0.5, 20, 5) });
      case "agents.turns":
        return result(info("agents.turns", "Turns", "count", "count", ["agent", "outcome"]), { ...r, seed: 3, scale: 60, series: [["done", "Done", 0.9], ["interrupted", "Interrupted", 0.06], ["failed", "Failed", 0.04]] });
      case "agents.waiting":
        return { ...result(info("agents.waiting", "Waiting on you", "ms", "distribution", ["agent"], "down"), { ...r, seed: 4, scale: 0.4 * HOUR }), ...(q.quantiles ? { quantiles: { p50: 95_000, p90: 14 * 60_000 } } : {}) };
      case "commands.runs":
        return result(info("commands.runs", "Commands", "count", "count", ["result", "command"]), { ...r, seed: 5, scale: 120, ranking: empty ? [] : [["pnpm test", 212], ["git status", 148], ["pnpm typecheck", 91], ["pnpm e2e", 40], ["git log", 22], ["make", 12]] });
      case "commands.failrate":
        return result(info("commands.failrate", "Failed commands", "percent", "gauge", ["command"], "down"), { ...r, seed: 6, scale: 9, ranking: [["pnpm test", 9], ["pnpm e2e", 15], ["pnpm typecheck", 3]] });
      case "agents.tokens":
        return result(info("agents.tokens", "Tokens", "tokens", "count", ["token", "model", "project"]), { ...r, seed: 7, scale: 900_000, series: [["claude-opus-5-5", "claude-opus-5-5", 0.85], ["claude-haiku-5-5", "claude-haiku-5-5", 0.15]] });
      case "ai.calls":
        return result(info("ai.calls", "Model calls", "count", "count", ["purpose", "model"]), { ...r, seed: 10, scale: 30, ranking: empty ? [] : [["notify.done", 812], ["session.name", 410], ["journal.day", 64], ["summary", 12]] });
      case "core.memory":
        return result(info("core.memory", "Core memory", "bytes", "gauge"), { ...r, seed: 11, scale: 380e6, measure: "mean" });
      case "core.stalls":
        if (q.measure === "max") return { ...result(info("core.stalls", "Core stalls", "ms", "distribution"), { ...r, seed: 12, scale: 1, measure: "max" }), total: empty ? 0 : 412 };
        return result(info("core.stalls", "Core stalls", "count", "distribution"), { ...r, seed: 12, scale: 2, measure: "n" });
      case "data.size":
        return { ...result(info("data.size", "Event log size", "bytes", "gauge"), { ...r, seed: 13, scale: 1 }), total: 2.9e9 };
      default:
        throw new Error(`No stat “${q.stat}” in the story`);
    }
  };
}

/** A busy week: the overview, every section. A number opens its detail. */
export const Week: State = wide({ stats: stats() });

/** A stat on its own, split by agent, with its ranking, as the native story's detail. */
export const Detail: State = wide({ stats: stats(), state: { open: { stat: "agents.time", by: "agent" } } });

/** Every workspace, from the title menu: the same panes, counted everywhere. */
export const AllWorkspaces: State = wide({ stats: stats(), state: { scope: "all" } });

/** Nothing recorded yet. */
export const Nothing: State = wide({ stats: stats({ empty: true }) });

/** The log is younger than the range: numbers start on its first day, the footer says so, no comparison. */
export const Counting: State = wide({ stats: stats({ partialDays: 3 }) });

/** cmd refuses the stats: the page says why, with Try Again. */
export const Failed: State = wide({ deny: { "stats.query": 'events: ["agents"]' } });

/** Today, by hour: the open hour in the accent, the rest of the day still to come. */
export const Today: State = wide({ stats: stats(), state: { range: "today" } });

/** A year: weeks along the bars, active time as a calendar. */
export const Year: State = wide({ stats: stats(), state: { range: "year" } });

/** Until every number is in. */
export const Loading: State = wide({ stats: (q) => (q.stat === "data.size" ? (null as unknown as StatResult) : stats()(q)) });

/** A month, every day a bar. */
export const Month: State = wide({ stats: stats(), state: { range: "month" } });
