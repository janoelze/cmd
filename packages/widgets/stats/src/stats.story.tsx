// Usage Stats' states for the UI Workbench (`pnpm workbench widgets/stats`): the widget against
// the fake host, one variant per state, each the host's data (a week of stand-in numbers).

import type { HostData } from "@cmd/widget-api/testing/host";
import { stat } from "@cmd/widget-api/testing/fixtures";
import type { StatQuery, StatResult } from "@cmd/widget-api";
import UsageStats from "./stats.tsx";

export default UsageStats;

const H = 3_600_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A smooth-ish run of `n` values around `base`. */
const wave = (n: number, base: number, seed: number) => Array.from({ length: n }, (_, i) => Math.max(0, Math.round(base * (1 + 0.6 * Math.sin(i * 1.3 + seed) + 0.3 * Math.cos(i * 0.7 + seed * 2)))));

const UNITS: Record<string, StatResult["stat"]["unit"]> = { "agents.time": "ms", "agents.waiting": "ms", "you.active": "ms", "commands.failrate": "percent", "agents.tokens": "tokens", "core.memory": "bytes", "data.size": "bytes", "core.stalls": "ms" };
const TITLES: Record<string, string> = { "agents.time": "Agent time", "agents.turns": "Turns", "commands.runs": "Commands", "commands.failrate": "Failed commands", "agents.tokens": "Tokens", "you.active": "Active time", "ai.calls": "Model calls", "core.memory": "Core memory", "core.stalls": "Core stalls", "data.size": "Event log size" };
const COMMANDS = ["pnpm test", "git status", "pnpm typecheck", "pnpm e2e", "git diff", "pnpm dev", "ls", "rg", "git log", "pnpm build", "node", "make"];

/** The fake core's stats: a few plausible days, by what the query splits by. */
function stats(scale = 1, commands = 8) {
  return (q: StatQuery): StatResult => {
    const unit = UNITS[q.stat] ?? "count";
    const hourly = q.grain === "hour" || q.range === "today";
    const months = q.range === "year";
    const n = q.range === "365d" ? 365 : months ? 12 : hourly ? (q.range === "today" ? 24 : 30 * 24) : 7;
    const base = (unit === "bytes" ? 180 * 2 ** 20 : unit === "ms" ? 1.5 * H : unit === "tokens" ? 400_000 : unit === "percent" ? 8 : 12) * scale / (hourly && n > 24 ? 6 : 1);
    const split = q.by === "agent" ? [["claude", "Claude"], ["codex", "Codex"]] : q.by === "outcome" ? [["done", "Done"], ["stopped", "Stopped"], ["failed", "Failed"]] : q.by === "model" ? [["opus", "Opus"], ["sonnet", "Sonnet"]] : null;
    const series = split ? split.map(([key, label], i) => ({ key: key!, label: label!, values: wave(n, base / (i + 1.5), i + 1) })) : undefined;
    const r = stat(q, { unit, title: TITLES[q.stat] ?? q.stat, ...(series ? { series } : { values: wave(n, base, q.stat.length) }) });
    if (months) {
      const y = new Date().getFullYear();
      r.buckets = Array.from({ length: 12 }, (_, i) => new Date(y, i, 1).getTime());
      r.grain = "month";
      r.from = r.buckets[0]!;
    } else if (hourly || n > 7) {
      const start = q.range === "today" ? new Date().setHours(0, 0, 0, 0) : new Date().setHours(0, 0, 0, 0) - (n / (hourly ? 24 : 1) - 1) * DAY;
      r.buckets = Array.from({ length: n }, (_, i) => start + i * (hourly ? HOUR : DAY));
      r.grain = hourly ? "hour" : "day";
      r.from = r.buckets[0]!;
    }
    if (q.top && q.by === "command") r.ranking = COMMANDS.slice(0, Math.min(q.top, commands)).map((c, i) => ({ key: c, label: c, value: Math.round((40 - i * 3) * scale) }));
    if (q.stat === "commands.failrate") r.ranking = [{ key: "pnpm test", label: "pnpm test", value: 18 }, { key: "pnpm e2e", label: "pnpm e2e", value: 9 }];
    if (q.top && q.by === "project") r.ranking = [["cmd", 21 * H], ["fl-studio-web", 6 * H], ["dotfiles", H]].map(([k, v]) => ({ key: String(k), label: String(k), value: Number(v) * scale }));
    if (q.top && q.by === "purpose") r.ranking = [["Summaries", 42], ["Notifications", 30], ["Journal", 7]].map(([k, v]) => ({ key: String(k), label: String(k), value: Number(v) }));
    if (q.stat === "agents.waiting" && q.measure === "p50") r.total = 95_000;
    if (q.stat === "commands.failrate") Object.assign(r, { total: 7.5, ...(r.previous ? { previous: { ...r.previous, total: 9 } } : {}) }, { stat: { ...r.stat, good: "down" } });
    if (q.stat === "agents.time") r.stat.good = "up";
    // cmd's own: memory an average, two stalls of the core (the worst 240 ms), the log's size.
    if (q.stat === "core.memory") r.total = 182 * 2 ** 20;
    if (q.stat === "core.stalls") r.total = q.measure === "max" ? 240 : 2;
    if (q.stat === "data.size") r.total = 46 * 2 ** 20;
    return r;
  };
}

/** A week of work in this workspace. */
export const Week: HostData = { stats: stats() };

/** Every workspace, from the title menu: active time, projects, cmd's model calls. */
export const AllWorkspaces: HostData = { stats: stats(2.5), state: { scope: "all" } };

/** A year, as a calendar of when you work. */
export const Year: HostData = { stats: stats(30), state: { range: "year", scope: "all" } };

/** In a narrow window, as in a sidebar. */
export const Narrow: HostData & { size: "narrow" } = { stats: stats(), size: "narrow" };

/** Nothing counted in this workspace yet. */
export const Empty: HostData = { stats: (q) => stat(q, { values: [0, 0, 0, 0, 0, 0, 0], unit: UNITS[q.stat] ?? "count" }) };

/** The widget may read none of the stats. */
export const Refused: HostData = { deny: { "stats.query": 'events: ["agents"]' } };

/** Today, by the hour. */
export const Today: HostData = { stats: stats(0.2), state: { range: "today" } };

/** Many commands ranked. */
export const Many: HostData = { stats: stats(1, 12), state: { range: "month" } };
