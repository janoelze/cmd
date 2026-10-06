// The data layer's front door (docs/28): recorders hand events in here; it
// applies the policy (is this class recorded, how much of its content is kept,
// redaction), notes the entities an event names, stores it and tells listeners.
// It also runs retention (daily, by class), imports what older cmds kept in
// cmd.sqlite once, and answers query, stats and explain for the RPC.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DATA_CLASSES, DATA_FLAGS, classOf, type DataClass, type DataClassInfo, type DataEvent, type DataQuery, type DataStats, type NewDataEvent, type Settings } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { redact, redactDeep } from "../redact.ts";
import { hookEvents, journalEvents, remoteAudit } from "./sources/legacy.ts";
import { DataStore, type StoreEvent } from "./store.ts";
import { excludedBy, parseExclude, type ExcludeRules } from "./exclude.ts";

const log = logger("data");

const DAY_MS = 86400_000;
/** Retention runs this often while the core is up. */
const PRUNE_EVERY_MS = 6 * 3600_000;

export interface DataServiceOptions {
  /** The events file; null: in memory (tests). */
  file: string | null;
  recordedBy: string;
  settings: () => Settings;
  now?: () => number;
}

/** What a forget names: everything of a session, of a project, before a time, of some types (all given must match). */
export interface ForgetWhat {
  sessionId?: string;
  projectId?: string;
  before?: number;
  types?: string[];
}

export class DataService extends EventEmitter<{ recorded: [DataEvent]; batch: [DataEvent[]]; removed: [{ types: string[]; count: number }] }> {
  #rules: { setting: string; rules: ExcludeRules } | null = null;
  /** Sessions and projects the person told cmd to forget: never recorded again (a re-read transcript included). */
  #forgotten: Set<string> | null = null;
  readonly store: DataStore;
  #o: DataServiceOptions;
  #seen = new Set<string>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #pruners: ((before: number) => void)[] = [];
  readonly recordedBy: string;

  constructor(o: DataServiceOptions) {
    super();
    this.#o = o;
    this.recordedBy = o.recordedBy;
    if (o.file) fs.mkdirSync(path.dirname(o.file), { recursive: true });
    this.store = new DataStore(o.file ?? ":memory:", { recordedBy: o.recordedBy });
  }

  get #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  /** Prune now and every few hours. */
  start(): void {
    this.prune();
    this.#timer = setInterval(() => this.prune(), PRUNE_EVERY_MS);
    this.#timer.unref?.();
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.store.close();
  }

  /** Whether events of a class are recorded now (its switch in Settings). */
  enabled(c: DataClass): boolean {
    const key = DATA_CLASSES[c].setting;
    if (!key) return true;
    const v = (this.#o.settings() as unknown as Record<string, unknown>)[key];
    return v !== false;
  }

  /**
   * Records an event, or nothing when its class is switched off. Text, data and
   * content are redacted; content over the class's cap is cut and the event
   * says so; the entities it names are noted.
   */
  record(e: NewDataEvent): DataEvent | null {
    const c = classOf(e.type);
    if (!this.enabled(c) || this.#refused(e)) return null;
    let flags = 0;
    const text = e.text ? redact(e.text) : (e.text ?? null);
    const body = e.body ? redact(e.body) : (e.body ?? null);
    const data = redactDeep(e.data);
    let content = typeof e.content === "string" ? redact(e.content) : (e.content ?? null);
    if (text !== (e.text ?? null) || body !== (e.body ?? null) || content !== (e.content ?? null) || JSON.stringify(data) !== JSON.stringify(e.data)) flags |= DATA_FLAGS.redacted;
    const cap = DATA_CLASSES[c].cap;
    if (cap && typeof content === "string" && content.length > cap) (content = content.slice(0, cap)), (flags |= DATA_FLAGS.cut);
    const stored: StoreEvent = { ...e, text, body, data, content, flags };
    const { seq } = this.store.record(stored);
    this.#entities(e);
    const ev = this.store.get(e.id) ?? ({ ...stored, seq } as unknown as DataEvent);
    this.emit("recorded", ev);
    return ev;
  }

  /** Several at once (imports, backfills), in one transaction; returns how many were kept. */
  recordAll(events: Iterable<NewDataEvent>): number {
    return this.recordBatch(events).length;
  }

  /** Whether an event's words match a full-text expression (for subscriptions with `text`). */
  textMatches(seq: number, expression: string): boolean {
    try {
      // Not `rowid = ? AND MATCH`: on a contentless table FTS5 takes the rowid lookup and can't check the match, so it says yes to everything.
      return !!this.store.db.prepare(`SELECT 1 WHERE ? IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)`).get(seq, expression);
    } catch {
      return false;
    }
  }

  /** Like recordAll, returning the stored events (for views fed from a batch). */
  recordBatch(events: Iterable<NewDataEvent>): DataEvent[] {
    const out: DataEvent[] = [];
    this.store.transaction(() => {
      for (const e of events) {
        const c = classOf(e.type);
        if (!this.enabled(c) || this.#refused(e)) continue;
        const cap = DATA_CLASSES[c].cap;
        let content = typeof e.content === "string" ? redact(e.content) : (e.content ?? null);
        let flags = DATA_FLAGS.imported;
        if (cap && typeof content === "string" && content.length > cap) (content = content.slice(0, cap)), (flags |= DATA_FLAGS.cut);
        this.store.record({ ...e, text: e.text ? redact(e.text) : e.text, body: e.body ? redact(e.body) : e.body, data: redactDeep(e.data), content, flags });
        this.#entities(e);
        const stored = this.store.get(e.id);
        if (stored) out.push(stored);
      }
    });
    if (out.length) this.emit("batch", out);
    return out;
  }

  /** The entities an event names, noted once per process (their seen time follows the event). */
  #entities(e: NewDataEvent): void {
    const pairs: [string, string | null | undefined][] = [["space", e.spaceId], ["project", e.projectId], ["session", e.sessionId], ["agent", e.agentId], ["pane", e.paneId], ["window", e.windowId], ["device", e.deviceId]];
    for (const [kind, id] of pairs) {
      if (!id) continue;
      const key = `${kind}:${id}`;
      if (this.#seen.has(key)) continue;
      this.#seen.add(key);
      this.store.entity(kind, id, {}, e.at);
    }
  }

  query(q: DataQuery): DataEvent[] {
    return this.store.query(q);
  }

  stats(): DataStats {
    return this.store.stats();
  }

  /** Every class with its retention, switch and whether it leaves the Mac, as the settings say now. */
  explain(): (DataClassInfo & { enabled: boolean; events: number })[] {
    const keepDays = Number((this.#o.settings() as unknown as Record<string, unknown>)["data.keepDays"] ?? 365) || 365;
    const counts = new Map<string, number>();
    for (const t of this.store.stats().types) counts.set(classOf(t.type), (counts.get(classOf(t.type)) ?? 0) + t.rows);
    return (Object.keys(DATA_CLASSES) as DataClass[]).map((c) => {
      const info = DATA_CLASSES[c];
      return { class: c, ...info, keepDays: info.keepDays === "setting" ? keepDays : info.keepDays, enabled: this.enabled(c), events: counts.get(c) ?? 0 };
    });
  }

  /** The exclusion rules as the settings say now (data.exclude), parsed once per change. */
  rules(): ExcludeRules {
    const setting = String((this.#o.settings() as unknown as Record<string, unknown>)["data.exclude"] ?? "");
    if (this.#rules?.setting !== setting) this.#rules = { setting, rules: parseExclude(setting) };
    return this.#rules.rules;
  }

  /** Not recorded: excluded by the rules, or of a forgotten session or project. */
  #refused(e: NewDataEvent): boolean {
    if (excludedBy(this.rules(), e)) return true;
    this.#forgotten ??= new Set(this.store.entities("forgotten").map((x) => x.id));
    return (!!e.sessionId && this.#forgotten.has(e.sessionId)) || (!!e.projectId && this.#forgotten.has(e.projectId));
  }

  /**
   * Deletes what's named (and the blobs only it used) and records that something
   * was forgotten, not what. A forgotten session or project stays forgotten:
   * its events are refused from then on, even when its transcript is read again.
   */
  forget(w: ForgetWhat): number {
    if (!w.sessionId && !w.projectId && !w.before && !w.types?.length) throw new Error("say what to forget: a session, a project, a time or types");
    const types = this.#typesOf(w);
    const n = this.store.delete({ sessionId: w.sessionId, projectId: w.projectId, before: w.before, types: w.types });
    for (const id of [w.sessionId, w.projectId]) if (id) this.store.entity("forgotten", id, {}, this.#now), this.#forgotten?.add(id);
    this.store.sweepBlobs();
    this.record({ id: `data:forget:${this.#now}`, at: this.#now, type: "data.op", source: "cmd", data: { op: "forget", detail: { events: n, session: !!w.sessionId, project: !!w.projectId, before: w.before ?? null, types: w.types ?? null } } });
    if (n) this.emit("removed", { types, count: n });
    return n;
  }

  /** The types a forget will touch, for the views to know what to rebuild. */
  #typesOf(w: ForgetWhat): string[] {
    const [where, args] = [[] as string[], [] as (string | number)[]];
    if (w.sessionId) where.push("session_id = ?"), args.push(w.sessionId);
    if (w.projectId) where.push("project_id = ?"), args.push(w.projectId);
    if (w.before) where.push("at < ?"), args.push(w.before);
    const rows = this.store.db.prepare(`SELECT DISTINCT type FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`).all(...args) as { type: string }[];
    return rows.map((r) => r.type).filter((t) => !w.types?.length || w.types.some((x) => (x.endsWith(".") ? t.startsWith(x) : t === x)));
  }

  /** Applies the exclusion rules to what's already kept; returns how many events went. */
  applyRules(): number {
    const rules = this.rules();
    if (!rules.folders.length && !rules.hosts.length && !rules.commands.length) return 0;
    const seqs: number[] = [];
    const types = new Set<string>();
    let after = 0;
    for (;;) {
      const page = this.store.query({ after, limit: 5000 });
      if (!page.length) break;
      for (const e of page) if (excludedBy(rules, e as unknown as NewDataEvent)) seqs.push(e.seq), types.add(e.type);
      after = page.at(-1)!.seq;
    }
    let n = 0;
    for (let i = 0; i < seqs.length; i += 500) n += this.store.delete({ seqs: seqs.slice(i, i + 500) });
    this.store.sweepBlobs();
    if (n) {
      this.record({ id: `data:rules:${this.#now}`, at: this.#now, type: "data.op", source: "cmd", data: { op: "prune", detail: { events: n, rules: true } } });
      this.emit("removed", { types: [...types], count: n });
    }
    return n;
  }

  /** The remote access audit an older cmd kept in cmd.sqlite (remote_log), once; returns how many rows came along. */
  importRemoteLog(db: DatabaseSync): number {
    if (this.store.meta("import.remote_log")) return 0;
    const has = !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'remote_log'`).get();
    const n = has ? this.recordAll(remoteAudit(db)) : 0;
    this.store.setMeta("import.remote_log", new Date().toISOString());
    return n;
  }

  /** Views follow the facts: called with the time before which agent events were pruned. */
  onPrune(fn: (before: number) => void): void {
    this.#pruners.push(fn);
  }

  /** Deletes what the classes' retention says is too old, and the blobs nothing refers to any more. */
  prune(): { events: number; blobs: number } {
    const now = this.#now;
    let events = 0;
    let agentsBefore: number | null = null;
    for (const c of this.explain()) {
      if (c.keepDays === null) continue;
      const before = now - c.keepDays * DAY_MS;
      if (c.class === "agents") agentsBefore = before;
      events += this.store.delete({ before, types: c.types });
    }
    if (agentsBefore !== null) for (const fn of this.#pruners) fn(agentsBefore);
    const blobs = this.store.sweepBlobs();
    if (events || blobs) {
      log.info("pruned", { events, blobs });
      this.record({ id: `data:prune:${now}`, at: now, type: "data.op", source: "cmd", data: { op: "prune", detail: { events, blobs } } });
    }
    return { events, blobs };
  }

  /**
   * What an older cmd kept in cmd.sqlite (agent_events, journal_events), once:
   * the import is recorded, and the tables are the caller's to drop.
   */
  importLegacy(db: DatabaseSync): { hooks: number; journal: number } | null {
    if (this.store.meta("import.legacy")) return null;
    const has = (t: string) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
    const t0 = Date.now();
    const hooks = has("agent_events") ? this.recordAll(hookEvents(db)) : 0;
    const journal = has("journal_events") ? this.recordAll(journalEvents(db)) : 0;
    this.store.setMeta("import.legacy", new Date().toISOString());
    if (hooks || journal) {
      log.info("imported what the older tables held", { hooks, journal, ms: Date.now() - t0 });
      this.record({ id: `data:import:legacy`, at: this.#now, type: "data.op", source: "cmd", data: { op: "import", detail: { hooks, journal } } });
    }
    return { hooks, journal };
  }
}
