// The data of API 1.2's verbs (docs/57, wave 2), in the product's words: what the built-ins'
// ports needed and other widgets plausibly want. Within API 1 these only grow. Their verbs are
// rows of widget-verbs.ts and entries of widget-tree.ts's ApiMethods; the core maps its own
// models onto these (widgets/api/model.ts, reads.ts), so nothing here names a core type.

/** A class of the event log as Settings → Data names it, and the event types it holds (`events.classes`). */
export interface ApiEventClass {
  /** What `events: [<class>]` in package.json names: "agents", "output". */
  class: string;
  /** "Agent events", "Command output". */
  title: string;
  /** Type names and prefixes in the class ("agent." takes every agent event). */
  types: string[];
}

/** What one terminal of the workspace uses now (`terminals.usage`): its whole process tree, sampled every few seconds. */
export interface ApiTerminalUsage {
  /** The terminal's id (as `terminals.list` gives it). */
  id: string;
  workspaceId: string;
  /** Percent of one core over the last few seconds (can pass 100). */
  cpu: number;
  /** Bytes in memory, summed over its processes. */
  memory: number;
  /** How many processes it runs. */
  processes: number;
  /** Its largest processes by memory, by name ("node", "claude"). */
  top: { name: string; memory: number }[];
  /** When it was sampled (ms). */
  at: number;
}

/** Which terminals: the workspace's (the default), or every workspace's with `workspace: ["all"]`. */
export interface ApiUsageQuery {
  scope?: "workspace" | "all";
}

/** A range a stat covers: named ("today", "7d", "month"…, ending now), or from and to (ms). */
export type ApiStatRange = "today" | "24h" | "week" | "7d" | "month" | "30d" | "year" | "365d" | { from: number; to: number };
export type ApiStatGrain = "hour" | "day" | "week" | "month";
/** What a series shows of each bucket: its count, its sum, the mean, the largest, or a quantile. */
export type ApiStatMeasure = "n" | "sum" | "mean" | "max" | "p50" | "p90";

/** A stat over a range (`stats.query`): the query the Stats window asks, scoped to the widget's workspace. */
export interface ApiStatQuery {
  /** The stat: "agents.time", "agents.turns", "commands.runs", "commands.failrate", "git.commits"… (the Stats window's). */
  stat: string;
  /** Default "7d". */
  range?: ApiStatRange;
  /** Default from the range: hours for a day, days up to two months, then weeks and months. */
  grain?: ApiStatGrain;
  /** One series per value of this dimension ("agent", "result", "command"…): the 6 largest, the rest as "other". */
  by?: string;
  /** Only buckets whose dimensions have these values (a dimension's id → a value, or any of several). */
  filter?: Record<string, string | string[]>;
  measure?: ApiStatMeasure;
  /** Also the range of the same length just before (a delta). */
  compare?: boolean;
  /** A ranking of this many values of `by` over the whole range. */
  top?: number;
  /** "workspace" (the default): this workspace's only; "all": every workspace's, with `workspace: ["all"]`. */
  scope?: "workspace" | "all";
  /** 1.3: also the whole range's median and 90th percentile (`quantiles`), for a stat that keeps them (`kind: "distribution"`). */
  quantiles?: boolean;
}

/** A stat as the Stats window names it. */
export interface ApiStatInfo {
  id: string;
  title: string;
  /** One line: what it answers. */
  description: string;
  unit: "count" | "ms" | "bytes" | "tokens" | "percent";
  /** Its dimensions, for `by` and `filter`; 1.3: `many` marks one with many values (commands, files, hosts), for a ranking (`top`) rather than series. */
  dims: { id: string; title: string; many?: boolean }[];
  /** Which way a change is good, if either. */
  good?: "up" | "down";
  /** The class of events it is counted from (what `events` must name). */
  class: string;
  /**
   * 1.3: what it counts, so a detail picks its chart: "count" adds up (bars: runs, time spent, tokens),
   * "gauge" is a level (a line: memory), "distribution" spreads (a line, with `quantiles`), "rate" is
   * one count over another (a line in percent: how often commands fail).
   */
  kind?: "count" | "gauge" | "distribution" | "rate";
}

/** A stat's buckets over a range: one series, or one per value of `by`. */
export interface ApiStatResult {
  stat: ApiStatInfo;
  from: number;
  to: number;
  grain: ApiStatGrain;
  measure: ApiStatMeasure;
  /** Each bucket's start (local time). */
  buckets: number[];
  /** Per bucket; null where the log has no data, 0 where nothing happened. A key that would be a folder is its name. */
  series: { key: string; label: string; values: (number | null)[]; total: number }[];
  /** The whole range in the query's measure. */
  total: number;
  /** With `compare`: the range just before. */
  previous?: { total: number; values: (number | null)[] };
  /** With `top`: the largest values of `by` over the range. */
  ranking?: { key: string; label: string; value: number }[];
  /** The log is younger than the range, or the stat is still being counted: numbers start here. */
  partial?: { since: number };
  /** 1.3: with `quantiles` in the query, for a distribution: the whole range's median and 90th percentile. */
  quantiles?: { p50: number; p90: number };
  /** 1.3: when cmd counted it (ms): what "Updated" says. */
  asOf?: number;
}

/** Which days (`journal.days`): the last `count` work days with something in them, newest first. */
export interface ApiJournalQuery {
  /** Default 7, at most 30. */
  count?: number;
  /** 1.3: "workspace" (the default): this workspace's journal; "all": the one of everything on this Mac, with `workspace: ["all"]`. */
  scope?: "workspace" | "all";
}

/** A piece of work on a day, as the journal names it ("Released v0.14.4", "Investigated a corrupt search index"). */
export interface ApiJournalEntry {
  id: string;
  kind: "release" | "investigation" | "feature" | "fix" | "design" | "refactor" | "research" | "review" | "ops" | "chore";
  title: string;
  summary: string;
  outcome: "shipped" | "merged" | "fixed" | "answered" | "open" | "dropped" | null;
  start: number;
  end: number;
  counts: { agents: number; prompts: number; commands: number; commits: number; pages: number; files: number };
  /** 1.3: the project it was in, by its folder's name ("cmd"), never a path; null when it had none. */
  project?: string | null;
}

/** A work day of the workspace as the journal wrote it (a work day runs 04:00 to 04:00). */
export interface ApiJournalDay {
  /** Local midnight of the day. */
  date: number;
  headline: string;
  entries: ApiJournalEntry[];
  /** When it was written (ms). */
  writtenAt: number;
}

/** What the Mac is playing (`media.get`): any app that tells macOS (Music, Spotify, a browser tab). Times in seconds. */
export interface ApiNowPlaying {
  /** The app's bundle id: "com.spotify.client". */
  app: string;
  title: string;
  artist: string | null;
  album: string | null;
  playing: boolean;
  /** The track's length, when the app says. */
  duration: number | null;
  /** The position at `at` (ms since the epoch); it moves on at `rate` while playing. */
  elapsed: number | null;
  at: number | null;
  rate: number;
  /** The cover, as a data: URL. */
  artwork: string | null;
}

/** What `media.control` does: play or pause, the next or previous track, 15 seconds back or on. */
export type ApiMediaCommand = "toggle" | "next" | "previous" | "back15" | "forward15";
