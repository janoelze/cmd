// The stats service (docs/49 "Keeping buckets current"): the registry of stats, and one work
// loop that keeps their buckets current. Events recorded or changed, turns and sessions mark
// the hours they touch dirty; the loop recomputes dirty hours first, then builds stats that
// are new or whose version changed, newest hours first, in steps sized to stay within the
// scheduler's budget. Queries read buckets (the open hour of a live stat is recomputed first).

import { type DataEvent, type StatInfo, type StatQuery, type StatResult, type StatsEvent } from "@cmd/protocol";
import { EventEmitter } from "node:events";
import path from "node:path";
import { logger } from "@cmd/protocol/node";
import type { CoreContext } from "../kernel/context.ts";
import { projectIdOf } from "../data/project.ts";
import { measureOf, ranking, toSeries, windowOf, type Window } from "./query.ts";
import { defaultMeasure, HOUR, hourOf, type ComputeCtx, type LabelCtx, type StatDef, type StatRow } from "./stat.ts";
import { StatsStore, type KeyFilter } from "./store.ts";

const log = logger("stats");

/** Dirty hours wait this long for more events, but never longer than FLUSH_MAX. */
const FLUSH_MS = 1000;
const FLUSH_MAX = 5000;
/** A build step aims at this many ms of compute (BUDGET_MS is 12): its span of hours grows or shrinks to fit. */
const STEP_MS = 8;
const STEP_HOURS = { min: 1, max: 24 * 28, start: 24 };
/** And at most this many input events (~6 ms of the densest stat, transcript tokens, measured on a real log). */
const STEP_EVENTS = 1000;
/** At start, and every night, the last two days are recomputed (a dirty mark lost in a crash, events that changed late). */
const REPAIR_HOURS = 48;
const REPAIR_EVERY = 24 * HOUR;
/** A live stat's open hour is recomputed when asked if older than this. */
const LIVE_MS = 15_000;
/** A span starting this long ago can't touch a bucket (marks are capped). */
const MAX_MARK_HOURS = 24 * 7;

export type StatsCore = Pick<CoreContext, "data" | "views" | "agents" | "sessions" | "workspaces" | "scheduler" | "broadcast">;

const typeIn = (type: string, types: string[]) => types.some((x) => (x.endsWith(".") ? type.startsWith(x) : type === x));

/** What the service tells the core's own listeners (a widget's live stat, widgets/api/topics.ts): the stats that changed, as stats.changed says to clients. */
export type StatsEvents = { changed: [stats: string[]] };

export class StatsService extends EventEmitter<StatsEvents> {
  #core: StatsCore;
  #defs = new Map<string, StatDef>();
  #store: StatsStore | null = null;
  #dirty = new Map<string, Set<number>>();
  /** Stats to build: id → the hour the build has reached (going down) and where it stops. */
  #builds = new Map<string, { next: number; floor: number }>();
  #step = STEP_HOURS.start;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #firstDirty = 0;
  #running = false;
  #started = false;
  #disposed = false;
  #changed = new Set<string>();
  #changedTimer: ReturnType<typeof setTimeout> | null = null;
  #repairTimer: ReturnType<typeof setInterval> | null = null;
  #liveAt = new Map<string, number>();
  #samplers: ReturnType<typeof setInterval>[] = [];
  #projects = new Map<string, string | null>();
  /** Tests: called after each step of the work loop. */
  now: () => number = Date.now;

  constructor(core: StatsCore, defs: StatDef[] = []) {
    super();
    this.#core = core;
    for (const d of defs) this.register(d);
  }

  /** Declares a stat (docs/49 "Declaring a stat"); before start(), or it's built at once. */
  register(def: StatDef): void {
    if (this.#defs.has(def.id)) throw new Error(`stat ${def.id} is declared twice`);
    if (def.dims.length > 4) throw new Error(`stat ${def.id}: at most 4 dimensions`);
    if (!def.compute && !def.ratio && !def.sample && def.kind !== "gauge" && def.kind !== "distribution") throw new Error(`stat ${def.id}: compute, ratio or sample`);
    this.#defs.set(def.id, def);
    if (this.#started && def.compute) this.#plan(def);
  }

  get #db(): StatsStore {
    return (this.#store ??= new StatsStore(this.#core.views));
  }

  /** Listens to the log and starts building what isn't built (the stats startup job). */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    const { data, agents, sessions } = this.#core;
    data.on("recorded", (e) => this.#onEvents([e]));
    data.on("batch", (es) => this.#onEvents(es));
    agents.activity.onTurn((t) => this.#markWhere((d) => !!d.inputs.turns, t.startedAt, t.endedAt ?? this.now()));
    sessions.onChange((rows) => {
      for (const r of rows) if (r.started) this.#markWhere((d) => !!d.inputs.sessions, r.started, r.started);
    });
    data.onForget(({ what, span }) => {
      // Buckets of a forgotten project go everywhere, also in hours whose events were pruned; the rest is recomputed once the events are gone.
      if (what.projectId) for (const d of this.#stored()) d.dims.forEach((dim, i) => dim.id === "project" && this.#db.deleteKey(d.id, i, what.projectId!));
      if (span) this.#markWhere(() => true, span.from, Math.min(span.to, span.from + MAX_MARK_HOURS * HOUR), true);
    });
    for (const d of this.#defs.values()) if (d.sample) this.#sampleEvery(d);
    const known = new Set(this.#db.stats());
    for (const id of known) if (!this.#defs.get(id)?.compute) this.#db.drop(id);
    for (const d of this.#stored()) this.#plan(d);
    this.#repair();
    this.#repairTimer = setInterval(() => this.#repair(), REPAIR_EVERY);
    this.#repairTimer.unref?.();
  }

  dispose(): void {
    this.#disposed = true;
    for (const t of this.#samplers) clearInterval(t);
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    if (this.#changedTimer) clearTimeout(this.#changedTimer);
    if (this.#repairTimer) clearInterval(this.#repairTimer);
  }

  #stored(): StatDef[] {
    return [...this.#defs.values()].filter((d) => d.compute);
  }

  /** A new stat, or one whose version changed (its old buckets go), or a rebuild by the same rules (`sameRules`: hours older than the log stay): queued to build from now down to its oldest event. */
  #plan(d: StatDef, sameRules = false): void {
    const meta = this.#db.meta(d.id);
    const floor = this.#floor(d);
    const top = hourOf(this.now()) + 1;
    if (meta && meta.version === d.version) {
      if (meta.builtTo !== null && floor !== null && meta.builtTo > floor) this.#builds.set(d.id, { next: meta.builtTo, floor });
      return;
    }
    // Another version may lay its buckets out differently: none of the old ones are kept, not even those older than the log.
    if (meta && !sameRules) this.#db.replace(d.id, 0, top + 1, []);
    this.#db.setMeta(d.id, { version: d.version, builtTo: top, floor });
    if (floor === null) {
      this.#db.setMeta(d.id, { version: d.version, builtTo: null, floor: null });
      this.#db.replace(d.id, 0, top, []);
      return;
    }
    if (meta) log.info(`stat ${d.id}: version ${meta.version} → ${d.version}, building again`);
    this.#builds.set(d.id, { next: top, floor });
    this.#kick();
  }

  /** The hour of a stat's oldest input: hours before it are kept on a rebuild (counts outlive pruned events). */
  #floor(d: StatDef): number | null {
    const at: number[] = [];
    const { data, views } = this.#core;
    for (const t of d.inputs.types ?? []) {
      const r = (t.endsWith(".") ? data.store.db.prepare(`SELECT min(at) AS m FROM events WHERE type >= ? AND type < ?`).get(t, `${t.slice(0, -1)}/`) : data.store.db.prepare(`SELECT min(at) AS m FROM events WHERE type = ?`).get(t)) as { m: number | null };
      if (r.m !== null) at.push(r.m);
    }
    if (d.inputs.turns) {
      const r = views.db.prepare(`SELECT min(started_at) AS m FROM turns`).get() as { m: number | null } | undefined;
      if (r?.m) at.push(r.m);
    }
    if (d.inputs.sessions) {
      const r = views.db.prepare(`SELECT min(started) AS m FROM sessions`).get() as { m: number | null } | undefined;
      if (r?.m) at.push(r.m);
    }
    return at.length ? hourOf(Math.min(...at)) : null;
  }

  #onEvents(es: DataEvent[]): void {
    for (const e of es) this.#markWhere((d) => !!d.inputs.types && typeIn(e.type, d.inputs.types), e.at, e.until ?? e.at);
  }

  /** Marks the hours [at, until] of every stored stat `which` picks; `now`: recompute without waiting. */
  #markWhere(which: (d: StatDef) => boolean, at: number, until: number, now = false): void {
    const from = hourOf(at);
    const to = Math.min(hourOf(until), from + MAX_MARK_HOURS);
    for (const d of this.#stored()) {
      if (!which(d)) continue;
      const set = this.#dirty.get(d.id) ?? new Set<number>();
      for (let h = from; h <= to; h++) set.add(h);
      this.#dirty.set(d.id, set);
    }
    if (!this.#dirty.size) return;
    if (now) return this.#kick();
    this.#firstDirty ||= this.now();
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    const wait = Math.max(0, Math.min(FLUSH_MS, this.#firstDirty + FLUSH_MAX - this.now()));
    this.#flushTimer = setTimeout(() => ((this.#flushTimer = null), (this.#firstDirty = 0), this.#kick()), wait);
    this.#flushTimer.unref?.();
  }

  #repair(): void {
    const now = this.now();
    this.#markWhere(() => true, now - REPAIR_HOURS * HOUR, now, true);
  }

  /** Builds again from the events: one stat, or all; hours older than the oldest event stay. */
  rebuild(id?: string): string[] {
    const ds = id ? [this.#must(id)].filter((d) => d.compute) : this.#stored();
    for (const d of ds) {
      const meta = this.#db.meta(d.id);
      this.#db.setMeta(d.id, { version: -1, builtTo: meta?.builtTo ?? null, floor: meta?.floor ?? null });
      this.#plan(d, true);
    }
    return ds.map((d) => d.id);
  }

  /**
   * Resolves once every stat is built down to its oldest hour (the startup job
   * waits on it, so the footer says so while a new stat fills in its history);
   * `progress`: hours built of those there were to build. Live updates don't count.
   */
  async built(progress?: (done: number, total: number) => void): Promise<void> {
    const left = () => [...this.#builds.values()].reduce((n, b) => n + Math.max(0, b.next - b.floor), 0);
    let total = left();
    while (!this.#disposed && this.#builds.size) {
      // A rebuild started meanwhile adds hours: the total grows with it rather than the count going below zero.
      const l = left();
      total = Math.max(total, l);
      progress?.(total - l, total);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Resolves when nothing is dirty or building (tests, `cmd stats rebuild --wait`). */
  async idle(): Promise<void> {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
      this.#firstDirty = 0;
    }
    this.#kick();
    while (this.#running || this.#dirty.size || this.#builds.size) await new Promise((r) => setTimeout(r, 5));
  }

  #kick(): void {
    if (this.#running || this.#disposed || !this.#started) return;
    this.#running = true;
    void this.#loop().finally(() => (this.#running = false));
  }

  async #loop(): Promise<void> {
    while (!this.#disposed && (this.#dirty.size || this.#builds.size)) {
      const done = this.#core.scheduler.mark("stats");
      try {
        if (this.#dirty.size) this.#flushOne();
        else this.#buildStep();
      } catch (err) {
        log.warn(`stats work failed: ${(err as Error).message}`);
      } finally {
        done();
      }
      await this.#core.scheduler.yield();
    }
  }

  /** The newest run of one stat's dirty hours, or as much of it as fits in a step; the rest stays dirty. */
  #flushOne(): void {
    const [id, hours] = this.#dirty.entries().next().value as [string, Set<number>];
    const d = this.#defs.get(id);
    const build = this.#builds.get(id);
    if (build) for (const h of hours) if (h < build.next) hours.delete(h); // the build gets there
    if (!d?.compute || !hours.size) return void this.#dirty.delete(id);
    const top = Math.max(...hours);
    let low = top;
    while (hours.has(low - 1)) low--;
    const from = this.#chunk(d, low, top + 1);
    this.#compute(d, from, top + 1);
    for (let h = from; h <= top; h++) hours.delete(h);
    if (!hours.size) this.#dirty.delete(id);
    // Next time, another stat first: one stat's long repair doesn't hold the others back.
    else this.#dirty.delete(id), this.#dirty.set(id, hours);
    this.#tell(id);
  }

  /** Where a step ending at `hi` should start, no lower than `lo`: within STEP_HOURS and STEP_EVENTS of input events. */
  #chunk(d: StatDef, lo: number, hi: number): number {
    let from = Math.max(lo, hi - this.#step);
    const db = this.#core.data.store.db;
    for (const t of d.inputs.types ?? []) {
      const r = (t.endsWith(".") ? db.prepare(`SELECT at FROM events WHERE type >= ? AND type < ? AND at < ? ORDER BY at DESC LIMIT 1 OFFSET ${STEP_EVENTS}`).get(t, `${t.slice(0, -1)}/`, hi * HOUR) : db.prepare(`SELECT at FROM events WHERE type = ? AND at < ? ORDER BY at DESC LIMIT 1 OFFSET ${STEP_EVENTS}`).get(t, hi * HOUR)) as { at: number } | undefined;
      if (r) from = Math.max(from, Math.min(hi - 1, hourOf(r.at) + 1));
    }
    return from;
  }

  /** The next span of hours of the first stat still building, sized to STEP_MS. */
  #buildStep(): void {
    const [id, b] = this.#builds.entries().next().value as [string, { next: number; floor: number }];
    const d = this.#defs.get(id)!;
    const from = this.#chunk(d, b.floor, b.next);
    const t0 = performance.now();
    this.#compute(d, from, b.next);
    const ms = performance.now() - t0;
    this.#step = Math.round(Math.max(STEP_HOURS.min, Math.min(STEP_HOURS.max, ms > STEP_MS ? this.#step / 2 : ms < STEP_MS / 4 ? this.#step * 2 : this.#step)));
    const meta = this.#db.meta(id)!;
    if (from <= b.floor) {
      this.#builds.delete(id);
      this.#db.setMeta(id, { ...meta, builtTo: null, floor: Math.min(meta.floor ?? b.floor, b.floor) });
      log.info(`stat ${id} built`);
    } else {
      b.next = from;
      this.#db.setMeta(id, { ...meta, builtTo: from });
    }
    this.#tell(id);
  }

  #compute(d: StatDef, fromHour: number, toHour: number): void {
    const rows: StatRow[] = d.compute!(fromHour * HOUR, toHour * HOUR, this.#ctx());
    this.#db.replace(d.id, fromHour, toHour, rows);
  }

  #ctx(): ComputeCtx {
    const { data, views, workspaces } = this.#core;
    return {
      events: data.store.db,
      views: views.db,
      now: this.now(),
      projectOf: (cwd) => {
        if (!cwd) return null;
        if (!this.#projects.has(cwd)) {
          if (this.#projects.size > 5000) this.#projects.clear();
          this.#projects.set(cwd, projectIdOf(cwd));
        }
        return this.#projects.get(cwd)!;
      },
      workspaceOf: (cwd) => (cwd ? workspaces.of(cwd) : null),
      windowKind: (id) => {
        const k = data.store.entityOf("window", id)?.attrs.kind;
        return typeof k === "string" ? k : null;
      },
    };
  }

  /** A sampled stat: read now, then every `every` ms. */
  #sampleEvery(d: StatDef): void {
    const read = () => {
      try {
        for (const s of d.sample!.read({ eventsFile: path.isAbsolute(this.#core.data.store.file) ? this.#core.data.store.file : null, viewsFile: this.#core.views.file })) this.sample(d.id, s.keys, s.value);
      } catch (err) {
        log.warn(`sampling ${d.id} failed: ${(err as Error).message}`);
      }
    };
    read();
    const t = setInterval(read, d.sample!.every);
    t.unref?.();
    this.#samplers.push(t);
  }

  /** One value of a stat that has no events behind it (a gauge read now, a stall as it happens). */
  sample(id: string, keys: string[], value: number, at = this.now()): void {
    if (this.#disposed || !this.#defs.has(id)) return;
    this.#db.addSample(id, hourOf(at), keys, value);
    this.#tell(id);
  }

  /** Tells clients a stat changed, at most once a second. */
  #tell(id: string): void {
    this.#changed.add(id);
    for (const d of this.#defs.values()) if (d.ratio?.of === id) this.#changed.add(d.id);
    if (this.#changedTimer) return;
    this.#changedTimer = setTimeout(() => {
      this.#changedTimer = null;
      const stats = [...this.#changed];
      this.#changed.clear();
      if (!stats.length) return;
      this.#core.broadcast({ type: "stats.changed", stats } satisfies StatsEvent);
      this.emit("changed", stats);
    }, 1000);
    this.#changedTimer.unref?.();
  }

  /** A stat's declaration (throws for an unknown one). */
  def(id: string): StatDef {
    return this.#must(id);
  }

  #must(id: string): StatDef {
    const d = this.#defs.get(id);
    if (!d) throw new Error(`no stat "${id}" (cmd stats ls)`);
    return d;
  }

  info(d: StatDef): StatInfo {
    return {
      id: d.id,
      title: d.title,
      description: d.description,
      kind: d.kind,
      unit: d.unit,
      dims: d.dims.map(({ id, title, many }) => ({ id, title, ...(many ? { many } : {}) })),
      measure: defaultMeasure(d),
      ...(d.good ? { good: d.good } : {}),
      class: d.class,
      available: this.#core.data.enabled(d.class),
      ...(d.ratio ? { derived: true } : {}),
    };
  }

  catalog(): StatInfo[] {
    return [...this.#defs.values()].map((d) => this.info(d));
  }

  #labelCtx(): LabelCtx {
    return { workspaceName: (id) => this.#core.workspaces.get(id)?.name ?? null };
  }

  query(q: StatQuery): StatResult {
    const d = this.#must(q.stat);
    const now = this.now();
    const w = windowOf(q.range ?? "7d", q.grain, now);
    const filter = { ...(q.filter ?? {}), ...this.#scope(d, q.workspaceId) };
    if (d.ratio) return this.#ratio(d, q, w, filter, now);
    const measure = q.measure ?? defaultMeasure(d);
    const src = d;
    const filters = this.#filters(src, filter);
    if (d.live && w.from <= now && now < w.to) this.#live(d, now);
    const byIdx = q.by ? this.#dimIdx(src, q.by) : null;
    const lc = this.#labelCtx();
    const label = (dim: number | null) => (key: string) => (dim === null ? key : (src.dims[dim]!.label?.(key, lc) ?? (key || "None")));
    const since = this.#since(d, w.from);
    const rows = this.#db.read(d.id, hourOf(w.buckets[0] ?? w.from), Math.ceil(w.to / HOUR), filters);
    const { series, total, all } = toSeries(rows, w.buckets, w.to, measure, byIdx, label(byIdx), { since, now });
    const res: StatResult = { stat: this.info(d), from: w.from, to: w.to, grain: w.grain, measure, buckets: w.buckets, series, total, asOf: now };
    if (d.kind === "distribution" && all.bins) res.quantiles = { p50: measureOf(all, "p50"), p90: measureOf(all, "p90") };
    if (since !== null) res.partial = { since };
    // No comparison with a period the data doesn't cover: "new" would only say the log is young.
    if (q.compare && w.previous.length && (since === null || since <= w.previous[0]!)) {
      const pEnd = w.previous.length ? w.previous[w.previous.length - 1]! + (w.to - w.buckets[w.buckets.length - 1]!) : w.from;
      const prows = this.#db.read(d.id, hourOf(w.previous[0] ?? w.from), Math.ceil(pEnd / HOUR), filters);
      // The previous period up to the same point: a week so far against last week so far.
      const elapsed = Math.min(now, w.to) - (w.buckets[0] ?? w.from);
      const cut = (w.previous[0] ?? 0) + elapsed;
      const p = toSeries(prows, w.previous, pEnd, measure, null, label(null), { since: null, now: cut });
      const ptotal = toSeries(prows.filter((r) => r.hour * HOUR < cut), w.previous, pEnd, measure, null, label(null), { since: null, now: cut }).total;
      res.previous = { total: ptotal, values: p.series[0]?.values ?? [] };
    }
    if (q.top && q.by && byIdx !== null) res.ranking = ranking(rows.filter((r) => r.hour * HOUR >= (w.buckets[0] ?? w.from)), byIdx, measure, q.top, label(byIdx));
    return res;
  }

  queryMany(qs: StatQuery[]): StatResult[] {
    return qs.map((q) => this.query(q));
  }

  /** A ratio stat: `where`'s count over `among`'s, per bucket and series, as a percentage. */
  #ratio(d: StatDef, q: StatQuery, w: Window, filter: Record<string, string | string[]>, now: number): StatResult {
    const src = this.#must(d.ratio!.of);
    const lc = this.#labelCtx();
    const byIdx = q.by ? this.#dimIdx(src, q.by) : null;
    const label = (key: string) => (byIdx === null ? key : (src.dims[byIdx]!.label?.(key, lc) ?? (key || "None")));
    const base = this.#filters(src, { ...filter, ...(d.ratio!.among ?? {}) });
    const read = (from: number, to: number) => this.#db.read(src.id, hourOf(from), Math.ceil(to / HOUR), base);
    const hit = (r: StatRow) => Object.entries(d.ratio!.where).every(([k, v]) => r.keys[this.#dimIdx(src, k)] === v);
    const since = this.#since(src, w.from);
    const rows = read(w.buckets[0] ?? w.from, w.to);
    const pct = (rs: StatRow[], starts: number[], end: number, until: number) => {
      const num = toSeries(rs.filter(hit), starts, end, "n", byIdx, label, { since, now: until });
      const den = toSeries(rs, starts, end, "n", byIdx, label, { since, now: until });
      const series = den.series.map((s) => {
        const ns = num.series.find((x) => x.key === s.key);
        return { ...s, values: s.values.map((v, i) => (v === null ? null : v ? (100 * (ns?.values[i] ?? 0)) / v : 0)), total: s.total ? (100 * (ns?.total ?? 0)) / s.total : 0 };
      });
      return { series, total: den.total ? (100 * num.total) / den.total : 0 };
    };
    const { series, total } = pct(rows, w.buckets, w.to, now);
    const res: StatResult = { stat: this.info(d), from: w.from, to: w.to, grain: w.grain, measure: "mean", buckets: w.buckets, series, total, asOf: now };
    if (since !== null) res.partial = { since };
    if (q.compare && w.previous.length && (since === null || since <= w.previous[0]!)) {
      const pEnd = w.previous[w.previous.length - 1]! + (w.to - w.buckets[w.buckets.length - 1]!);
      const cut = w.previous[0]! + (Math.min(now, w.to) - w.buckets[0]!);
      const prows = read(w.previous[0]!, pEnd);
      const p = pct(prows, w.previous, pEnd, cut);
      res.previous = { total: pct(prows.filter((r) => r.hour * HOUR < cut), w.previous, pEnd, cut).total, values: p.series[0]?.values ?? [] };
    }
    if (q.top && byIdx !== null) {
      const by = new Map<string, { n: number; d: number }>();
      for (const r of rows) {
        const k = r.keys[byIdx] ?? "";
        const e = by.get(k) ?? { n: 0, d: 0 };
        e.d += r.n;
        if (hit(r)) e.n += r.n;
        by.set(k, e);
      }
      res.ranking = [...by.entries()].filter(([, e]) => e.d > 0).map(([key, e]) => ({ key, label: label(key), value: (100 * e.n) / e.d })).sort((a, b) => b.value - a.value).slice(0, q.top);
    }
    return res;
  }

  /** A workspace as a filter: on the stat's workspace dimension, else on its project (the workspace's folder's repository), else none. */
  #scope(d: StatDef, workspaceId: string | undefined): Record<string, string> {
    if (!workspaceId) return {};
    const src = d.ratio ? this.#must(d.ratio.of) : d;
    if (src.dims.some((x) => x.id === "workspace")) return { workspace: workspaceId };
    const root = this.#core.workspaces.get(workspaceId)?.root;
    const project = root && src.dims.some((x) => x.id === "project") ? projectIdOf(root) : null;
    return project ? { project } : {};
  }

  #dimIdx(d: StatDef, id: string): number {
    const i = d.dims.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(`stat ${d.id} has no dimension "${id}" (it has ${d.dims.map((x) => x.id).join(", ") || "none"})`);
    return i;
  }

  #filters(d: StatDef, filter: Record<string, string | string[]>): KeyFilter[] {
    return Object.entries(filter).flatMap(([k, v]) => {
      const idx = d.dims.findIndex((x) => x.id === k);
      // A filter on a dimension the stat doesn't have (a workspace for git) leaves it whole.
      return idx < 0 ? [] : [{ idx, values: Array.isArray(v) ? v : [v] }];
    });
  }

  /** Where a range's numbers start, if after its start: the stat is still building, or its oldest data is younger. */
  #since(d: StatDef, from: number): number | null {
    const build = this.#builds.get(d.id);
    if (build) return build.next * HOUR;
    // Built stats start at their oldest event; sampled ones at their first sample.
    const oldest = this.#db.meta(d.id)?.floor ?? (d.sample || !d.compute ? this.#db.oldest(d.id) : null);
    if (oldest === null) return null;
    return oldest * HOUR > from ? oldest * HOUR : null;
  }

  /** A live stat's open hour, recomputed if it's older than LIVE_MS (spans grow without events). */
  #live(d: StatDef, now: number): void {
    if (now - (this.#liveAt.get(d.id) ?? 0) < LIVE_MS) return;
    this.#liveAt.set(d.id, now);
    const h = hourOf(now);
    if ((this.#builds.get(d.id)?.next ?? 0) > h) return;
    this.#compute(d, h, h + 1);
  }
}
