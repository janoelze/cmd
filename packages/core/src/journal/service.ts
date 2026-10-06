// The journal service (docs/23-journal.md): keeps the event log filled and
// writes days from it.
//
// Two ways in. Sources that keep their own record (the activity log's turns,
// the transcript index's sessions, git's reflogs) are pulled: `sync` reads what
// changed since it last looked, idempotently, so a core that was down misses
// nothing. Signals nothing else keeps (commands, pages, files shown, notes) are
// pushed with `record` as they happen.
//
// Days are written on request (the Journal widget, `cmd journal`): threads and
// a digest from the events, then a model, unless the digest is the one the
// stored day was written from. Today is written again at most every
// TODAY_EVERY_MS unless asked to. Without an AI provider no day is
// written at all (events are still recorded, so they can be once there is).

import os from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { logger } from "@cmd/protocol/node";
import { HOME_SPACE_ID, type JournalDay, type JournalEvent, type JournalThread, type Space, type SpaceId } from "@cmd/protocol";
import type { CompleteResult, ObjectRequest } from "../ai/backends.ts";
import type { CallOptions } from "../ai/service.ts";
import type { SessionRow } from "../search/index.ts";
import { projectOf, sessionEvents, turnEvents } from "./backfill.ts";
import { digest, type Digest } from "./digest.ts";
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
  /** The core's database (activity log tables); null: no turns. */
  activityDb: DatabaseSync | null;
  /** Agent sessions from the transcript index; null while there is none (search off or not open yet). */
  sessions: (since: number) => SessionRow[] | null;
  spaces: () => Space[];
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
  /** Per source, when it was last read: a source that wasn't there (the index still opening) is read from the start next time. */
  #read = { turns: 0, sessions: 0, git: 0 };
  #syncing: Promise<void> | null = null;
  #writing = new Map<string, Promise<JournalDay | null>>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(o: JournalServiceOptions) {
    this.#o = o;
    this.store = o.store;
  }

  get #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  /** Sync now and every few minutes; prune daily. */
  start(): void {
    void this.sync();
    let ticks = 0;
    this.#timer = setInterval(() => {
      void this.sync();
      if (++ticks % 288 === 0) this.store.prune();
    }, SYNC_EVERY_MS);
    this.#timer.unref?.();
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** A pushed event (commands, pages, files, notes). The project is filled in from the folder when missing. */
  record(e: NewJournalEvent): number {
    return this.store.record({ ...e, repo: e.repo ?? (e.cwd ? projectOf(e.cwd) : null) });
  }

  /** Pulls turns, sessions and git since the last pull. Concurrent calls share one run. */
  sync(): Promise<void> {
    this.#syncing ??= this.#sync().finally(() => (this.#syncing = null));
    return this.#syncing;
  }

  async #sync(): Promise<void> {
    const now = this.#now;
    const since = (last: number) => (last ? last - SYNC_OVERLAP : now - FIRST_SYNC_DAYS * DAY_MS);
    const t0 = Date.now();
    const pulled: NewJournalEvent[] = [];
    try {
      if (this.#o.activityDb) {
        pulled.push(...turnEvents(this.#o.activityDb, since(this.#read.turns)).map((e) => ({ ...e, spaceId: e.data.kind === "agent.turn" && e.data.agentId ? this.#o.agentSpace(e.data.agentId) : null })));
        this.#read.turns = now;
      }
      const sessions = this.#o.sessions(since(this.#read.sessions));
      if (sessions) {
        pulled.push(...sessionEvents(sessions));
        this.#read.sessions = now;
      }
    } catch (err) {
      log.warn(`journal sync: ${(err as Error).message}`);
    }
    for (const e of pulled) e.spaceId ??= this.#spaceOf(e.cwd);
    this.store.recordAll(pulled);
    // Git for every project seen lately and every Space's folder.
    const repos = new Set([...this.store.repos(now - FIRST_SYNC_DAYS * DAY_MS).map((r) => r.repo), ...this.#o.spaces().filter((s) => s.id !== HOME_SPACE_ID).map((s) => s.root)]);
    let git = 0;
    for (const r of repos) {
      const ev = await gitEvents(r, since(this.#read.git)).catch(() => []);
      git += this.store.recordAll(ev.map((e) => ({ ...e, spaceId: this.#spaceOf(e.repo) })));
    }
    this.#read.git = now;
    log.info("journal synced", { events: pulled.length + git, repos: repos.size, ms: Date.now() - t0 });
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
    const fresh = stored && stored.inputHash === d.hash;
    const today = date === this.dayOf(this.#now);
    const recent = stored && today && this.#now - stored.writtenAt < TODAY_EVERY_MS;
    // Only a model writes days: titled from the data alone, they read like a list of prompts.
    const model = this.#o.ai?.modelName() ?? null;
    if (mode === "never" || !model || !this.#o.ai || (mode === "stale" && (fresh || recent))) return stored;
    const write = this.#o.ai
      .object<WrittenDay>({ tier: "smart", purpose: "journal.day", background: true, system: SYSTEM, prompt: `<day>\n${d.text}\n</day>`, schema: SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: 6000 })
      .then((r) => {
        const day = toDay(r.value, d, threads, events, { date, scope, writtenBy: r.model });
        this.store.saveDay(day);
        log.info("day written", { scope, date: new Date(date).toDateString(), entries: day.entries.length, chars: d.text.length, tokens: r.usage });
        return day;
      })
      .catch((err: Error) => {
        log.warn(`could not write the day: ${err.message}`, { scope });
        return stored;
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

  /** Something written down on purpose: by a person, or by an agent (with its session, so it joins its thread). */
  note(text: string, o: { by: "user" | "agent"; agentSession?: string | null; spaceId?: SpaceId | null; cwd?: string | null }): number {
    const at = this.#now;
    return this.record({ at, until: null, kind: "note", key: `note:${at}:${text.slice(0, 40)}`, spaceId: o.spaceId ?? this.#spaceOf(o.cwd ?? null), repo: null, cwd: o.cwd ?? null, thread: null, text: text.trim(), data: { kind: "note", by: o.by, agentSession: o.agentSession ?? null } });
  }
}

const tilde = (p: string) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);
