// API 1.2's reads (docs/57, wave 2) in terms of the core's services: the log's classes as
// Settings names them, the workspace's terminals' CPU and memory, a stat as the Stats window
// asks it, the workspace's written journal days, and what the Mac plays. Each is scoped as
// the adapter's 1.0 reads are: the widget's own workspace unless the grant says "all", events
// through data/policy.ts's widget row, and nothing that names a folder outside the workspace's
// (a stat's key that is a path comes back as its name). The adapter (adapter.ts) checks each
// verb's row first; what is checked per call (the stat's class, "all") is here.

import { DATA_CLASSES, NOW_PLAYING_COMMANDS, type ApiEventClass, type ApiJournalDay, type ApiJournalQuery, type ApiNowPlaying, type ApiStatQuery, type ApiStatResult, type ApiTerminalUsage, type ApiUsageQuery, type NowPlaying, type NowPlayingCommand, type StatQuery, type StatResult, type WidgetPermissions, type JournalDay } from "@cmd/protocol";
import type { CoreContext } from "../../kernel/context.ts";
import { declarable, readsClass } from "../../data/policy.ts";
import { holdNowPlaying } from "../../nowplaying/feature.ts";
import { RateLimit, invalid, missing } from "./access.ts";

export type ReadsCore = Pick<CoreContext, "panes" | "resources" | "stats" | "journal" | "workspaces" | "windows" | "broadcast" | "call">;

export interface ReadsScope {
  /** The widget's workspace now. */
  own(): string;
  /** What the grant lets it see: its workspace or every one ("none" is refused by the adapter first). */
  level: "none" | "workspace" | "all";
  perms: WidgetPermissions;
}

/** Journal days are read from the whole log: at most this many reads a minute per process. */
const JOURNAL_PER_MINUTE = 10;
const JOURNAL_MAX_DAYS = 30;
const STATS_TOP_MAX = 50;
/** What a widget may put on the clipboard at once (characters); more is cut. */
export const CLIPBOARD_MAX = 64 * 1024;

const pathLike = (k: string) => /^(dir:|\/|~)/.test(k);
const oneOf = <T extends string>(v: unknown, all: readonly T[], what: string): T | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !(all as readonly string[]).includes(v)) throw invalid(`stats.query: ${what} is one of ${all.join(", ")}`);
  return v as T;
};

const RANGES = ["today", "24h", "week", "7d", "month", "30d", "year", "365d"] as const;
/** A stat's range: one of the named ones, or from and to (ms), from before to. */
function range(v: unknown): StatQuery["range"] {
  if (typeof v === "string") return oneOf(v, RANGES, "range");
  const r = v as { from?: unknown; to?: unknown } | null;
  if (!r || typeof r !== "object" || typeof r.from !== "number" || typeof r.to !== "number" || !(r.from < r.to)) throw invalid(`stats.query: range is one of ${RANGES.join(", ")}, or { from, to } in ms`);
  return { from: r.from, to: r.to };
}

/** One widget process's 1.2 reads; `dispose` lets go of what they hold (the Now Playing stream). */
export function widgetReads(core: ReadsCore, s: ReadsScope) {
  const journal = new RateLimit(JOURNAL_PER_MINUTE);
  let playing: ReturnType<typeof holdNowPlaying> | null = null;
  const all = (q: { scope?: unknown } | null | undefined, what: string): boolean => {
    if (q?.scope !== "all") return false;
    if (s.level !== "all") throw missing("workspace", "all", what);
    return true;
  };

  /** The log's classes a widget may name in `events` (every one but those widgets never read). */
  const classes = (): ApiEventClass[] => declarable("widget").map((c) => ({ class: c, title: DATA_CLASSES[c].title, types: [...DATA_CLASSES[c].types] }));

  const usage = (q?: ApiUsageQuery | null): ApiTerminalUsage[] => {
    const every = all(q, "Seeing every workspace's terminals");
    const out: ApiTerminalUsage[] = [];
    let unsampled = false;
    for (const p of core.panes.list()) {
      if (!every && p.workspaceId !== s.own()) continue;
      if (p.exitCode !== null) continue;
      if (!p.usage) {
        unsampled = true;
        continue;
      }
      const u = p.usage;
      out.push({ id: p.id, workspaceId: p.workspaceId, cpu: u.cpu, memory: u.memory, processes: u.processes, top: u.top.map((t) => ({ name: t.name, memory: t.memory })), at: u.sampledAt });
    }
    if (unsampled) core.resources?.soon(); // a terminal not sampled yet: soon, rather than at the next tick
    return out;
  };

  const stat = (q: ApiStatQuery): ApiStatResult => {
    if (!q || typeof q !== "object" || typeof q.stat !== "string" || !q.stat) throw invalid('stats.query: name the stat, like { stat: "agents.time" }');
    const every = all(q, "Counting every workspace");
    let def: ReturnType<ReadsCore["stats"]["def"]>;
    try {
      def = core.stats.def(q.stat);
    } catch {
      throw invalid(`stats.query: cmd has no stat “${q.stat.slice(0, 60)}”`);
    }
    const info = core.stats.info(def);
    if (!readsClass({ kind: "widget", workspaceId: s.own(), declared: s.perms.events }, info.class)) throw missing("events", info.class, `Reading “${info.title}”`);
    // Scoped as the Stats window scopes a workspace: by its workspace, else by its folder's project; a stat with neither counts every workspace together.
    const src = def.ratio ? core.stats.def(def.ratio.of) : def;
    const dims = src.dims.map((d) => d.id);
    if (!every) {
      const root = core.workspaces.get(s.own())?.root;
      if (!dims.includes("workspace") && !(dims.includes("project") && root)) throw missing("workspace", "all", `“${info.title}” counts every workspace together, so reading it`);
      if (q.by === "workspace") throw missing("workspace", "all", "Splitting a stat by workspace");
    }
    const filter: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(q.filter && typeof q.filter === "object" ? q.filter : {})) {
      if (!every && (k === "workspace" || k === "project")) continue; // the scope decides those
      if (typeof v !== "string" && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) throw invalid(`stats.query: filter.${k.slice(0, 40)} is a value or a list of values`);
      filter[k] = v;
    }
    const query: StatQuery = {
      stat: q.stat,
      ...(q.range !== undefined ? { range: range(q.range) } : {}),
      ...(q.grain !== undefined ? { grain: oneOf(q.grain, ["hour", "day", "week", "month"] as const, "grain") } : {}),
      ...(q.measure !== undefined ? { measure: oneOf(q.measure, ["n", "sum", "mean", "max", "p50", "p90"] as const, "measure") } : {}),
      ...(typeof q.by === "string" ? { by: q.by } : {}),
      ...(Object.keys(filter).length ? { filter } : {}),
      ...(q.compare ? { compare: true } : {}),
      ...(q.top ? { top: Math.max(1, Math.min(Math.floor(Number(q.top)) || 10, STATS_TOP_MAX)) } : {}),
      ...(every ? {} : { workspaceId: s.own() }),
    };
    let r: StatResult;
    try {
      r = core.stats.query(query);
    } catch (e) {
      throw invalid(`stats.query: ${(e as Error).message.replace(/ \(cmd stats ls\)/, "")}`);
    }
    return apiStat(r);
  };

  const days = async (q?: ApiJournalQuery | null): Promise<ApiJournalDay[]> => {
    journal.take("journal.days");
    const count = Math.max(1, Math.min(Math.floor(Number(q?.count) || 7), JOURNAL_MAX_DAYS));
    // Read only: a widget never has a day written (that runs the person's model).
    return (await core.journal.days(`workspace:${s.own()}`, count, "never")).map(apiDay);
  };

  const media = async (): Promise<ApiNowPlaying | null> => {
    playing ??= holdNowPlaying(core);
    const n = await playing.read();
    return n && apiNowPlaying(n);
  };

  /** media.control's arguments, as the Now Playing window sends them: a command, or a seek in seconds. */
  const control = (command: unknown, opts: unknown): { command?: NowPlayingCommand; seek?: number } => {
    const seek = opts && typeof opts === "object" ? (opts as { seek?: unknown }).seek : undefined;
    if (seek !== undefined && seek !== null) {
      if (typeof seek !== "number" || !Number.isFinite(seek) || seek < 0) throw invalid("media.control: seek is a position in seconds");
      return { seek };
    }
    if (typeof command !== "string" || !(NOW_PLAYING_COMMANDS as readonly string[]).includes(command)) throw invalid(`media.control: the command is one of ${NOW_PLAYING_COMMANDS.join(", ")}, or { seek }`);
    return { command: command as NowPlayingCommand };
  };

  return {
    classes,
    usage,
    stat,
    days,
    media,
    control,
    dispose() {
      playing?.release();
      playing = null;
    },
  };
}

/** A stat's result in the API's words: a key that names a folder (a project, a file) comes back as its name. */
export function apiStat(r: StatResult): ApiStatResult {
  const key = (k: string, label: string) => (pathLike(k) ? label : k);
  const s = r.stat;
  return {
    stat: { id: s.id, title: s.title, description: s.description, unit: s.unit, dims: s.dims.map((d) => ({ id: d.id, title: d.title })), ...(s.good ? { good: s.good } : {}), class: s.class },
    from: r.from,
    to: r.to,
    grain: r.grain,
    measure: r.measure,
    buckets: r.buckets,
    series: r.series.map((x) => ({ key: key(x.key, x.label), label: x.label, values: x.values, total: x.total })),
    total: r.total,
    ...(r.previous ? { previous: r.previous } : {}),
    ...(r.ranking ? { ranking: r.ranking.map((x) => ({ key: key(x.key, x.label), label: x.label, value: x.value })) } : {}),
    ...(r.partial ? { partial: r.partial } : {}),
  };
}

/** A written day without its folders, hashes and model. */
export function apiDay(d: JournalDay): ApiJournalDay {
  return {
    date: d.date,
    headline: d.headline,
    writtenAt: d.writtenAt,
    entries: d.entries.map((e) => ({ id: e.id, kind: e.kind, title: e.title, summary: e.summary, outcome: e.outcome, start: e.start, end: e.end, counts: { ...e.counts } })),
  };
}

export const apiNowPlaying = (n: NowPlaying): ApiNowPlaying => ({ app: n.app, title: n.title, artist: n.artist, album: n.album, playing: n.playing, duration: n.duration, elapsed: n.elapsed, at: n.at, rate: n.rate, artwork: n.artwork });
