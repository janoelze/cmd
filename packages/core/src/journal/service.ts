// The journal service (docs/23-journal.md): keeps the event log filled and
// writes days from it.
//
// Events come from the log (data/), the turns view and the transcript index
// (journal/store.ts assembles them); git is the one source this service still
// reads itself, from reflogs, every few minutes, into the log. Notes are
// recorded here (`note`).
//
// Reads (the Journal widget reloads as agents work) take git up to
// SYNC_FRESH_MS old, and a sync skips repositories whose reflogs haven't
// changed (gitStamp) and folders that are no checkout until something happens
// in them, so a busy widget costs little. The repositories come from a skip scan
// of the project index, not a DISTINCT over it (AR1-16-03).
//
// Days are written on request (the Journal widget, `cmd journal`): threads and
// a digest from the events, then a model, unless the digest is the one the
// stored day was written from. Today is written again at most every
// TODAY_EVERY_MS unless asked to; a day older than yesterday, written after it
// ended, only when asked to (docs/24). Without an AI provider no day is
// written at all (events are still recorded, so they can be once there is).

import os from "node:os";
import { logger } from "@cmd/protocol/node";
import { buildContext } from "../ai/context.ts";
import { WEEK_FORMAT, WEEK_SCHEMA, WEEK_SYSTEM, daysHash, daysOfWeek, toWeek, weekDigest, weekOf, type WrittenWeek } from "./weeks.ts";
import { HOME_WORKSPACE_ID, JOURNAL_SCHEMA, SOURCES_FORMAT, THREADS_FORMAT, WRITER_FORMAT, type JournalDay, type JournalFormat, type JournalEvent, type JournalWeek, type JournalThread, type Workspace, type WorkspaceId } from "@cmd/protocol";
import type { CompleteResult, ObjectRequest } from "../ai/backends.ts";
import type { CallOptions } from "../ai/service.ts";
import { digest, eventsHash, type Digest } from "./digest.ts";
import { gitEvents, gitStamp } from "./git.ts";
import { JournalStore, type NewJournalEvent } from "./store.ts";
import { inlinePacer, type Pacer } from "../scheduler.ts";
import { buildThreads } from "./threads.ts";
import { SCHEMA, SYSTEM, toDay, type WrittenDay } from "./writer.ts";
import { workspaceAt } from "../workspaces/paths.ts";

const log = logger("journal");

/** A work day starts at this hour: a late night belongs to the day it began on. */
export const DAY_STARTS_AT = 4;
const DAY_MS = 86400_000;
/** How far back the first sync reaches (git keeps 90 days, the activity log 14). */
const FIRST_SYNC_DAYS = 30;
/** Pulls overlap by this much: a session's row keeps changing while it runs. */
const SYNC_OVERLAP = 2 * 3600_000;
const SYNC_EVERY_MS = 5 * 60_000;
/** How old git may be for a read (days, weeks, threads); writing a day on request and `cmd journal sync` read it now. */
export const SYNC_FRESH_MS = 60_000;
/** A new SOURCES_FORMAT reads sources again this far back (git keeps 90 days). */
const REREAD_DAYS = 90;
/** Days written by older rules are written again when they're this recent (today, yesterday); older ones stay as written. */
const UPGRADE_RECENT_DAYS = 2;
const CURRENT: JournalFormat = { schema: JOURNAL_SCHEMA, threads: THREADS_FORMAT, writer: WRITER_FORMAT };
const sameFormat = (a: JournalFormat, b: JournalFormat) => a.schema === b.schema && a.threads === b.threads && a.writer === b.writer;
/** Characters of digest a day may send (about 40k tokens); a busier day is cut in the middle. */
const DAY_BUDGET = 160_000;
/** Today is written again at most this often unless forced. */
const TODAY_EVERY_MS = 30 * 60_000;
/** Earlier events read for context (a release ships what merged since the one before). */
const CONTEXT_MS = 7 * DAY_MS;
/** The log's meta key for the open workspaces backfilled events were last placed in ("<id>\t<root>", sorted). */
const ASSIGNED_META = "journal.workspaces";
/** Events read at once for several days (#pool); a busier stretch is read day by day. */
const POOL_LIMIT = 50_000;

export interface JournalAi {
  object<T>(o: CallOptions & ObjectRequest<T>): Promise<CompleteResult<T>>;
  /** The model a day is written with, by name; null: no provider. */
  modelName(): string | null;
}

export interface JournalServiceOptions {
  store: JournalStore;
  workspaces: () => Workspace[];
  /** Tests: git's events for a repository since a time (default: its reflogs, journal/git.ts). */
  git?: (repo: string, since: number) => Promise<NewJournalEvent[]>;
  /** Tests: what changes when a repository's git does (default: gitStamp, or none with a custom `git`). */
  gitStamp?: (repo: string) => Promise<string | null>;
  /** A live agent's workspace. */
  agentWorkspace: (agentId: string) => WorkspaceId | null;
  ai: JournalAi | null;
  now?: () => number;
  /** Between steps of a sync (the scheduler; by default the next tick). */
  pace?: Pacer;
  /** Tests: events read at once for several days (POOL_LIMIT). */
  poolLimit?: number;
}

export type WriteMode = "never" | "stale" | "force";

/** "workspace:<id>", "repo:<path>" or "all". */
export type JournalScope = string;

export class JournalService {
  readonly store: JournalStore;
  #o: JournalServiceOptions;
  /**
   * When git was last read, kept in the database so a restart reads only what's
   * new; a new SOURCES_FORMAT reads it all again. Turns and sessions are read
   * live from their views when a day is asked for.
   */
  #read = { git: 0 };
  #reread = false;
  #syncing: Promise<void> | null = null;
  /** When the last sync started (this process). */
  #syncedAt = -Infinity;
  /** Each repository's gitStamp when it was last read: unchanged, it isn't read again. */
  #stamps = new Map<string, string>();
  /**
   * Folders that were no git checkout (gitStamp null: never one, or gone), with
   * when that was seen: skipped until an event names them again, or a workspace
   * opens on one (most projects seen are plain folders; AR1-16-03).
   */
  #notGit = new Map<string, number>();
  #writing = new Map<string, Promise<JournalDay | null>>();
  #timer: ReturnType<typeof setInterval> | null = null;
  /** The running assignWorkspaces, and whether workspaces changed while it ran. */
  #assigning: Promise<number> | null = null;
  #assignAgain = false;
  #disposed = false;

  constructor(o: JournalServiceOptions) {
    this.#o = o;
    this.store = o.store;
    if (Number(this.store.meta("sources.format") ?? 0) !== SOURCES_FORMAT) this.#reread = true;
    else this.#read.git = Number(this.store.meta("sync.git") ?? 0);
  }

  get #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  /** Read git now and every few minutes (events' retention is the data layer's). */
  start(): void {
    void this.assignWorkspaces();
    void this.sync();
    this.#timer = setInterval(() => void this.sync(), SYNC_EVERY_MS);
    this.#timer.unref?.();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer) clearInterval(this.#timer);
  }

  /**
   * Backfilled events in the log without a workspace get the one their folder
   * is in (JournalStore.assignWorkspaces), as git read now would: at start and
   * whenever the workspaces change (the core calls it then). The open
   * workspaces a pass ran with are kept in the log's meta; a pass runs only
   * when one is open that wasn't then, since only a new folder can place rows
   * the last pass left. Resolves to the rows changed.
   */
  assignWorkspaces(): Promise<number> {
    if (this.#assigning) {
      this.#assignAgain = true;
      return this.#assigning;
    }
    this.#assigning = (async () => {
      let n = 0;
      try {
        do {
          this.#assignAgain = false;
          n += await this.#assign();
        } while (this.#assignAgain && !this.#disposed);
      } catch (err) {
        if (!this.#disposed) log.warn("could not give backfilled events their workspaces", err);
      } finally {
        this.#assigning = null;
      }
      return n;
    })();
    return this.#assigning;
  }

  async #assign(): Promise<number> {
    const spaces = this.#o.workspaces().filter((s) => s.id !== HOME_WORKSPACE_ID);
    const keys = spaces.map((s) => `${s.id}\t${s.root}`).sort();
    const meta = this.store.data.store;
    let done: string[] = [];
    try {
      done = JSON.parse(meta.meta(ASSIGNED_META) ?? "[]") as string[];
    } catch {}
    if (keys.every((k) => done.includes(k))) return 0;
    const t0 = Date.now();
    const { scanned, changed } = await this.store.assignWorkspaces((p) => workspaceAt(spaces, p), this.#o.pace ?? inlinePacer);
    if (this.#disposed) return changed;
    meta.setMeta(ASSIGNED_META, JSON.stringify(keys));
    log.info("backfilled events given workspaces", { workspaces: spaces.length, scanned, changed, ms: Date.now() - t0 });
    return changed;
  }

  /** Reads git since the last read, unless it was read less than `maxAge` ago. Concurrent calls share one run. */
  sync(maxAge = 0): Promise<void> {
    if (!this.#syncing && this.#now - this.#syncedAt < maxAge) return Promise.resolve();
    this.#syncing ??= this.#sync().finally(() => (this.#syncing = null));
    return this.#syncing;
  }

  async #sync(): Promise<void> {
    const pace = this.#o.pace ?? inlinePacer;
    const done = pace.mark("journal sync");
    try {
      await this.#syncGit(pace);
    } finally {
      done();
    }
  }

  async #syncGit(pace: Pacer): Promise<void> {
    const now = this.#now;
    const since = this.#read.git ? this.#read.git - SYNC_OVERLAP : now - (this.#reread ? REREAD_DAYS : FIRST_SYNC_DAYS) * DAY_MS;
    const t0 = Date.now();
    // Where a sync's time goes (the log line): sync parts by their own time, awaited ones by wall time. Marks name each
    // part's synchronous run for the watchdog, never an await (a mark held across one outlives marks that interleave).
    const ms = { repos: 0, stamps: 0, reads: 0, record: 0 };
    const timed = <T,>(part: keyof typeof ms, run: () => T): T => {
      const done = pace.mark(`journal sync: ${part}`);
      const t = performance.now();
      let out: T;
      try {
        out = run();
      } finally {
        done();
      }
      const end = () => (ms[part] += performance.now() - t);
      if (out instanceof Promise) return out.finally(end) as T;
      end();
      return out;
    };
    // Git for every project seen lately and every workspace's folder.
    // The newest event naming each, so a folder that was no checkout is looked at again once something happens in it.
    const last = new Map<string, number>();
    for (const { repo, last: at } of timed("repos", () => this.store.repos(now - FIRST_SYNC_DAYS * DAY_MS))) last.set(repo, at);
    for (const s of this.#o.workspaces()) if (s.id !== HOME_WORKSPACE_ID) last.set(s.root, Math.max(last.get(s.root) ?? 0, s.createdAt ?? 0, s.lastActiveAt ?? 0));
    const repos = [...last.keys()];
    let git = 0;
    let skipped = 0;
    const read = this.#o.git ?? gitEvents;
    const stampOf = this.#o.gitStamp ?? (this.#o.git ? null : gitStamp);
    for (const r of repos) {
      const seen = this.#notGit.get(r);
      if (seen !== undefined && last.get(r)! <= seen) {
        skipped++;
        continue;
      }
      // Unchanged since it was read: everything in the overlap is recorded already.
      const stamp = stampOf ? await timed("stamps", () => stampOf(r).catch(() => null)) : null;
      if (stamp !== null && this.#stamps.get(r) === stamp) {
        skipped++;
        continue;
      }
      if (stampOf && stamp === null) {
        // No checkout: nothing to read (gitEvents would find none either).
        this.#notGit.set(r, now);
        this.#stamps.delete(r);
        continue;
      }
      this.#notGit.delete(r);
      let ev: NewJournalEvent[];
      try {
        ev = await timed("reads", () => read(r, since));
      } catch {
        continue;
      }
      // A first read is thousands of events (90 days of a busy repository): a few hundred per step.
      for (let i = 0; i < ev.length; i += 200) {
        git += timed("record", () => this.store.recordAll(ev.slice(i, i + 200).map((e) => ({ ...e, workspaceId: this.#workspaceOf(e.repo ?? e.cwd) }))));
        await pace.yield();
      }
      if (stamp !== null) this.#stamps.set(r, stamp);
    }
    this.#read.git = now;
    this.#syncedAt = now;
    this.store.setMeta("sync.git", String(now));
    if (this.#reread) {
      this.store.setMeta("sources.format", String(SOURCES_FORMAT));
      this.#reread = false;
    }
    log.info("journal synced", { git, repos: repos.length, notGit: this.#notGit.size, skipped, ms: Date.now() - t0, parts: Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, Math.round(v)])) });
  }

  /** The workspace whose folder holds `p` (deepest wins); null: only Home's. */
  #workspaceOf(p: string | null): WorkspaceId | null {
    return workspaceAt(this.#o.workspaces(), p);
  }

  /** Whether an event is in a scope: its workspace, or (for events without one) its project's folder. */
  #inScope(scope: JournalScope): (e: JournalEvent) => boolean {
    if (scope === "all") return () => true;
    if (scope.startsWith("repo:")) {
      const repo = scope.slice(5);
      return (e) => e.repo === repo;
    }
    const id = scope.replace(/^workspace:/, "");
    const workspace = this.#o.workspaces().find((s) => s.id === id);
    if (!workspace) return (e) => e.workspaceId === id;
    if (id === HOME_WORKSPACE_ID) return (e) => e.workspaceId === id || (!e.workspaceId && !this.#workspaceOf(e.repo ?? e.cwd));
    return (e) => e.workspaceId === id || (!e.workspaceId && !!(e.repo ?? e.cwd) && this.#workspaceOf(e.repo ?? e.cwd) === id);
  }

  /** Local midnight of the work day `t` falls in. */
  dayOf(t: number): number {
    const d = new Date(t - DAY_STARTS_AT * 3600_000);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  #window(date: number): { from: number; to: number } {
    const from = new Date(date).setHours(DAY_STARTS_AT, 0, 0, 0);
    const next = new Date(date);
    next.setDate(next.getDate() + 1);
    return { from, to: next.setHours(DAY_STARTS_AT, 0, 0, 0) };
  }

  /**
   * A day's events (with a week before, for context), threads and digest.
   * `pool`: events read once for several days (#pool), filtered here as the store's query would.
   */
  threads(scope: JournalScope, date: number, pool?: JournalEvent[]): { events: JournalEvent[]; threads: JournalThread[]; digest: Digest; from: number; to: number } {
    const { from, to } = this.#window(date);
    const since = from - CONTEXT_MS;
    const inScope = this.#inScope(scope);
    const events = (pool ? pool.filter((e) => (e.until ?? e.at) >= since && e.at < to) : this.store.events({ since, until: to })).filter(inScope);
    const threads = buildThreads(events, { from, to });
    const title = `Work day: ${new Date(from).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}, ${DAY_STARTS_AT}:00 to ${DAY_STARTS_AT}:00. ${this.#scopeTitle(scope)}`;
    return { events, threads, digest: digest(threads, events, { title }), from, to };
  }

  #scopeTitle(scope: JournalScope): string {
    if (scope === "all") return "Everything on this Mac.";
    if (scope.startsWith("repo:")) return `Project ${tilde(scope.slice(5))}.`;
    const s = this.#o.workspaces().find((x) => `workspace:${x.id}` === scope || x.id === scope);
    return s ? `Workspace ${s.name} (${tilde(s.root)}).` : "";
  }

  /** One day, written if it needs to be (see WriteMode). Null when nothing happened, or it isn't written and can't be (no AI provider). */
  async day(scope: JournalScope, date: number, mode: WriteMode = "stale", pool?: JournalEvent[]): Promise<JournalDay | null> {
    const key = `${scope}@${date}`;
    const running = this.#writing.get(key);
    if (running) return running;
    const { events, threads, digest: d, from, to } = this.threads(scope, date, pool);
    if (!threads.some((t) => !t.minor)) return null;
    const stored = this.store.day(scope, date);
    const outdated = !!stored && !sameFormat(stored.format, CURRENT);
    const shown = stored && { ...stored, outdated };
    // What the day contains (clipped to its window); a day stored with the older, unclipped hash counts as unchanged while that one matches.
    // Days from before they carried an events hash compare by their digest.
    const happened = stored && (stored.eventsHash ? stored.eventsHash !== eventsHash(threads, events, { from, to }) && stored.eventsHash !== eventsHash(threads, events) : stored.inputHash !== d.hash);
    const today = date === this.dayOf(this.#now);
    const recentDay = this.dayOf(this.#now) - date < UPGRADE_RECENT_DAYS * DAY_MS;
    const throttled = stored && today && this.#now - stored.writtenAt < TODAY_EVERY_MS;
    // A day written after it ended, older than yesterday, is final: only `force` writes it again (docs/24).
    const final = stored && !recentDay && stored.writtenAt >= to;
    // Written again when something happened since, or when it's recent and older rules wrote it. History stays as written.
    const stale = !stored || (happened && !throttled && !final) || (outdated && recentDay && !throttled);
    // Only a model writes days: titled from the data alone, they read like a list of prompts.
    const model = this.#o.ai?.modelName() ?? null;
    if (mode === "never" || !model || !this.#o.ai || (mode === "stale" && !stale)) return shown;
    // The digest, redacted and fitted, with the keys of the events it came from (ai/context.ts).
    const ctx = buildContext({ purpose: "journal.day", budget: DAY_BUDGET, parts: [{ name: "day", text: `<day>\n${d.text}\n</day>`, events: [...new Set(threads.flatMap((t) => t.events))].map((id) => events.find((e) => e.id === id)?.key).filter((k): k is string => !!k) }] });
    const write = this.#o.ai
      .object<WrittenDay>({ tier: "smart", purpose: "journal.day", background: true, system: SYSTEM, prompt: ctx.text, context: ctx.record, schema: SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: 6000 })
      .then((r) => {
        const day = toDay(r.value, d, threads, events, { date, scope, writtenBy: r.model, window: { from, to }, writtenAt: this.#now });
        this.store.saveDay(day);
        log.info("day written", { scope, date: new Date(date).toDateString(), entries: day.entries.length, chars: d.text.length, tokens: r.usage });
        return day;
      })
      .catch((err: Error) => {
        log.warn(`could not write the day: ${err.message}`, { scope });
        return shown;
      })
      .finally(() => this.#writing.delete(key));
    this.#writing.set(key, write);
    return write;
  }

  /** The last `count` work days with something in them, newest first. */
  async days(scope: JournalScope, count: number, mode: WriteMode = "stale"): Promise<JournalDay[]> {
    await this.sync(SYNC_FRESH_MS);
    const out: JournalDay[] = [];
    let date = this.dayOf(this.#now);
    const tries = Math.max(count * 3, 14);
    // A day more than it may look back, for days with a clock change.
    const pool = await this.#pool(this.#window(date).from - (tries + 1) * DAY_MS);
    for (let i = 0; i < tries && out.length < count; i++) {
      const d = await this.day(scope, date, mode, pool);
      if (d) out.push(d);
      date = this.dayOf(date - 12 * 3600_000);
    }
    return out;
  }

  /**
   * The week a work day falls in, rolled up from its days: the days are written
   * first if they need to be (by `mode`), then the week, unless the stored one
   * was written from the same days by the same rules. Null when no day of it has
   * anything, or nothing can be written (no AI provider and none stored).
   */
  async week(scope: JournalScope, date: number, mode: WriteMode = "stale"): Promise<JournalWeek | null> {
    const start = weekOf(this.dayOf(date));
    const key = `week:${scope}@${start}`;
    const running = this.#writing.get(key) as Promise<JournalWeek | null> | undefined;
    if (running) return running;
    await this.sync(SYNC_FRESH_MS);
    const today = this.dayOf(this.#now);
    const days: JournalDay[] = [];
    const pool = await this.#pool(this.#window(start).from);
    for (const d of daysOfWeek(start)) {
      if (d > today) break;
      const day = await this.day(scope, d, mode === "force" ? "stale" : mode, pool);
      if (day?.entries.length) days.push(day);
    }
    const stored = this.store.week(scope, start);
    if (!days.length) return stored;
    const fresh = stored && stored.daysHash === daysHash(days) && stored.format === WEEK_FORMAT;
    const model = this.#o.ai?.modelName() ?? null;
    if (mode === "never" || !model || !this.#o.ai || (mode === "stale" && fresh)) return stored;
    const { text, ids } = weekDigest(days);
    const ctx = buildContext({ purpose: "journal.week", budget: 60_000, parts: [{ name: "week", text: `<week>\n${text}\n</week>` }] });
    const write = this.#o.ai
      .object<WrittenWeek>({ tier: "smart", purpose: "journal.week", background: true, system: WEEK_SYSTEM, prompt: ctx.text, context: ctx.record, schema: WEEK_SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: 3000 })
      .then((r) => {
        const w = toWeek(r.value, days, ids, { start, scope, writtenBy: r.model });
        this.store.saveWeek(w);
        log.info("week written", { scope, start: new Date(start).toDateString(), themes: w.themes.length, days: days.length });
        return w;
      })
      .catch((err: Error) => {
        log.warn(`could not write the week: ${err.message}`, { scope });
        return stored;
      })
      .finally(() => this.#writing.delete(key));
    this.#writing.set(key, write as unknown as Promise<JournalDay | null>);
    return write;
  }

  /**
   * Every event a day from `from` on reads (its week of context included), read
   * once for several days, a day of the log at a time between the scheduler's
   * steps. Undefined when there are more than POOL_LIMIT: each day reads its own.
   */
  async #pool(from: number): Promise<JournalEvent[] | undefined> {
    const pace = this.#o.pace ?? inlinePacer;
    return (await this.store.eventsSince(from - CONTEXT_MS, { until: this.#now + DAY_MS, limit: this.#o.poolLimit ?? POOL_LIMIT, step: () => pace.yield() })) ?? undefined;
  }

  /** Something written down on purpose: by a person, or by an agent (with its session, so it joins its thread). */
  note(text: string, o: { by: "user" | "agent"; agentSession?: string | null; workspaceId?: WorkspaceId | null; cwd?: string | null }): number {
    const at = this.#now;
    return this.store.record({ at, until: null, kind: "note", key: `note:${at}:${text.slice(0, 40)}`, workspaceId: o.workspaceId ?? this.#workspaceOf(o.cwd ?? null), repo: null, cwd: o.cwd ?? null, thread: null, text: text.trim(), data: { kind: "note", by: o.by, agentSession: o.agentSession ?? null } });
  }
}

const tilde = (p: string) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);
