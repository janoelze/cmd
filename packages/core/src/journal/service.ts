// The journal service (docs/23-journal.md): keeps the event log filled and
// writes days from it.
//
// Events come from the log (data/), the turns view and the transcript index
// (journal/store.ts assembles them); git is the one source this service still
// reads itself, from reflogs, every few minutes, into the log. Notes are
// recorded here (`note`).
//
// Days are written on request (the Journal widget, `cmd journal`): threads and
// a digest from the events, then a model, unless the digest is the one the
// stored day was written from. Today is written again at most every
// TODAY_EVERY_MS unless asked to. Without an AI provider no day is
// written at all (events are still recorded, so they can be once there is).

import os from "node:os";
import { logger } from "@cmd/protocol/node";
import { buildContext } from "../ai/context.ts";
import { WEEK_FORMAT, WEEK_SCHEMA, WEEK_SYSTEM, daysHash, daysOfWeek, toWeek, weekDigest, weekOf, type WrittenWeek } from "./weeks.ts";
import { HOME_SPACE_ID, JOURNAL_SCHEMA, SOURCES_FORMAT, THREADS_FORMAT, WRITER_FORMAT, type JournalDay, type JournalFormat, type JournalEvent, type JournalWeek, type JournalThread, type Space, type SpaceId } from "@cmd/protocol";
import type { CompleteResult, ObjectRequest } from "../ai/backends.ts";
import type { CallOptions } from "../ai/service.ts";
import { digest, eventsHash, type Digest } from "./digest.ts";
import { gitEvents } from "./git.ts";
import { JournalStore, type NewJournalEvent } from "./store.ts";
import { buildThreads } from "./threads.ts";
import { SCHEMA, SYSTEM, toDay, type WrittenDay } from "./writer.ts";

const log = logger("journal");

/** A work day starts at this hour: a late night belongs to the day it began on. */
export const DAY_STARTS_AT = 4;
const DAY_MS = 86400_000;
/** How far back the first sync reaches (git keeps 90 days, the activity log 14). */
const FIRST_SYNC_DAYS = 30;
/** Pulls overlap by this much: a session's row keeps changing while it runs. */
const SYNC_OVERLAP = 2 * 3600_000;
const SYNC_EVERY_MS = 5 * 60_000;
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

export interface JournalAi {
  object<T>(o: CallOptions & ObjectRequest<T>): Promise<CompleteResult<T>>;
  /** The model a day is written with, by name; null: no provider. */
  modelName(): string | null;
}

export interface JournalServiceOptions {
  store: JournalStore;
  spaces: () => Space[];
  /** Tests: git's events for a repository since a time (default: its reflogs, journal/git.ts). */
  git?: (repo: string, since: number) => Promise<NewJournalEvent[]>;
  /** A live agent's Space. */
  agentSpace: (agentId: string) => SpaceId | null;
  ai: JournalAi | null;
  now?: () => number;
}

export type WriteMode = "never" | "stale" | "force";

/** "space:<id>", "repo:<path>" or "all". */
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
  #writing = new Map<string, Promise<JournalDay | null>>();
  #timer: ReturnType<typeof setInterval> | null = null;

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
    void this.sync();
    this.#timer = setInterval(() => void this.sync(), SYNC_EVERY_MS);
    this.#timer.unref?.();
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** Reads git since the last read. Concurrent calls share one run. */
  sync(): Promise<void> {
    this.#syncing ??= this.#sync().finally(() => (this.#syncing = null));
    return this.#syncing;
  }

  async #sync(): Promise<void> {
    const now = this.#now;
    const since = this.#read.git ? this.#read.git - SYNC_OVERLAP : now - (this.#reread ? REREAD_DAYS : FIRST_SYNC_DAYS) * DAY_MS;
    const t0 = Date.now();
    // Git for every project seen lately and every Space's folder.
    const repos = new Set([...this.store.repos(now - FIRST_SYNC_DAYS * DAY_MS).map((r) => r.repo), ...this.#o.spaces().filter((s) => s.id !== HOME_SPACE_ID).map((s) => s.root)]);
    let git = 0;
    const read = this.#o.git ?? gitEvents;
    for (const r of repos) {
      const ev = await read(r, since).catch(() => []);
      git += this.store.recordAll(ev.map((e) => ({ ...e, spaceId: this.#spaceOf(e.repo) })));
    }
    this.#read.git = now;
    this.store.setMeta("sync.git", String(now));
    if (this.#reread) {
      this.store.setMeta("sources.format", String(SOURCES_FORMAT));
      this.#reread = false;
    }
    log.info("journal synced", { git, repos: repos.size, ms: Date.now() - t0 });
  }

  /** The Space whose folder holds `p` (deepest wins); null: only Home's. */
  #spaceOf(p: string | null): SpaceId | null {
    if (!p) return null;
    let best: Space | null = null;
    for (const s of this.#o.spaces()) if (s.id !== HOME_SPACE_ID && (p === s.root || p.startsWith(s.root + "/")) && (!best || s.root.length > best.root.length)) best = s;
    return best?.id ?? null;
  }

  /** Whether an event is in a scope: its Space, or (for events without one) its project's folder. */
  #inScope(scope: JournalScope): (e: JournalEvent) => boolean {
    if (scope === "all") return () => true;
    if (scope.startsWith("repo:")) {
      const repo = scope.slice(5);
      return (e) => e.repo === repo;
    }
    const id = scope.replace(/^space:/, "");
    const space = this.#o.spaces().find((s) => s.id === id);
    if (!space) return (e) => e.spaceId === id;
    if (id === HOME_SPACE_ID) return (e) => e.spaceId === id || (!e.spaceId && !this.#spaceOf(e.repo ?? e.cwd));
    return (e) => e.spaceId === id || (!e.spaceId && !!(e.repo ?? e.cwd) && this.#spaceOf(e.repo ?? e.cwd) === id);
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

  /** A day's events (with a week before, for context), threads and digest. */
  threads(scope: JournalScope, date: number): { events: JournalEvent[]; threads: JournalThread[]; digest: Digest; from: number; to: number } {
    const { from, to } = this.#window(date);
    const inScope = this.#inScope(scope);
    const events = this.store.events({ since: from - CONTEXT_MS, until: to }).filter(inScope);
    const threads = buildThreads(events, { from, to });
    const title = `Work day: ${new Date(from).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}, ${DAY_STARTS_AT}:00 to ${DAY_STARTS_AT}:00. ${this.#scopeTitle(scope)}`;
    return { events, threads, digest: digest(threads, events, { title }), from, to };
  }

  #scopeTitle(scope: JournalScope): string {
    if (scope === "all") return "Everything on this Mac.";
    if (scope.startsWith("repo:")) return `Project ${tilde(scope.slice(5))}.`;
    const s = this.#o.spaces().find((x) => `space:${x.id}` === scope || x.id === scope);
    return s ? `Space ${s.name} (${tilde(s.root)}).` : "";
  }

  /** One day, written if it needs to be (see WriteMode). Null when nothing happened, or it isn't written and can't be (no AI provider). */
  async day(scope: JournalScope, date: number, mode: WriteMode = "stale"): Promise<JournalDay | null> {
    const key = `${scope}@${date}`;
    const running = this.#writing.get(key);
    if (running) return running;
    const { events, threads, digest: d } = this.threads(scope, date);
    if (!threads.some((t) => !t.minor)) return null;
    const stored = this.store.day(scope, date);
    const outdated = !!stored && !sameFormat(stored.format, CURRENT);
    const shown = stored && { ...stored, outdated };
    // Days from before they carried an events hash compare by their digest.
    const happened = stored && (stored.eventsHash ? stored.eventsHash !== eventsHash(threads, events) : stored.inputHash !== d.hash);
    const today = date === this.dayOf(this.#now);
    const recentDay = this.dayOf(this.#now) - date < UPGRADE_RECENT_DAYS * DAY_MS;
    const throttled = stored && today && this.#now - stored.writtenAt < TODAY_EVERY_MS;
    // Written again when something happened since, or when it's recent and older rules wrote it. History stays as written.
    const stale = !stored || (happened && !throttled) || (outdated && recentDay && !throttled);
    // Only a model writes days: titled from the data alone, they read like a list of prompts.
    const model = this.#o.ai?.modelName() ?? null;
    if (mode === "never" || !model || !this.#o.ai || (mode === "stale" && !stale)) return shown;
    // The digest, redacted and fitted, with the keys of the events it came from (ai/context.ts).
    const ctx = buildContext({ purpose: "journal.day", budget: DAY_BUDGET, parts: [{ name: "day", text: `<day>\n${d.text}\n</day>`, events: [...new Set(threads.flatMap((t) => t.events))].map((id) => events.find((e) => e.id === id)?.key).filter((k): k is string => !!k) }] });
    const write = this.#o.ai
      .object<WrittenDay>({ tier: "smart", purpose: "journal.day", background: true, system: SYSTEM, prompt: ctx.text, context: ctx.record, schema: SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: 6000 })
      .then((r) => {
        const day = toDay(r.value, d, threads, events, { date, scope, writtenBy: r.model });
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
    await this.sync();
    const out: JournalDay[] = [];
    let date = this.dayOf(this.#now);
    for (let i = 0; i < Math.max(count * 3, 14) && out.length < count; i++) {
      const d = await this.day(scope, date, mode);
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
    await this.sync();
    const today = this.dayOf(this.#now);
    const days: JournalDay[] = [];
    for (const d of daysOfWeek(start)) {
      if (d > today) break;
      const day = await this.day(scope, d, mode === "force" ? "stale" : mode);
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

  /** Something written down on purpose: by a person, or by an agent (with its session, so it joins its thread). */
  note(text: string, o: { by: "user" | "agent"; agentSession?: string | null; spaceId?: SpaceId | null; cwd?: string | null }): number {
    const at = this.#now;
    return this.store.record({ at, until: null, kind: "note", key: `note:${at}:${text.slice(0, 40)}`, spaceId: o.spaceId ?? this.#spaceOf(o.cwd ?? null), repo: null, cwd: o.cwd ?? null, thread: null, text: text.trim(), data: { kind: "note", by: o.by, agentSession: o.agentSession ?? null } });
  }
}

const tilde = (p: string) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);
