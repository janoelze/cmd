// The journal over the event log (docs/23, docs/28): what it reads as events is
// assembled from the log (commands, git, pages, files, notes, Spaces), the
// turns view (agent.turn) and the transcript index's sessions (agent.session);
// nothing is copied into a journal table any more. What the journal owns is
// the days a model wrote and their history (journal_days, journal_days_history),
// its sync cursors (journal_meta) and its schema version, in the core's database.
//
// Versions (docs/24): JOURNAL_SCHEMA covers the days' documents; UPGRADES move
// an older database forward. SOURCES_FORMAT covers how turns, sessions and git
// become events; THREADS_FORMAT and WRITER_FORMAT the layers above.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { DATA_FLAGS, DEFAULT_SETTINGS, JOURNAL_SCHEMA, type AgentTurn, type DataEvent, type DataEventType, type JournalData, type JournalDay, type JournalEvent, type JournalEventKind, type NewDataEvent, type SpaceId } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { DataService } from "../data/service.ts";
import { projectOf } from "../data/project.ts";
import type { SessionRow } from "../search/index.ts";
import { sessionEvents, turnEvent } from "./backfill.ts";

const log = logger("journal");

/** Earlier versions of a day kept when it's written again. */
const HISTORY_PER_DAY = 3;

/** Data upgrades: UPGRADES[n] takes a database at schema n - 1 to n (the days' documents). */
export const UPGRADES: Record<number, (db: DatabaseSync) => void> = {};

/** Day documents from before days carried their format: format 1. */
const FORMAT_1 = { schema: 1, threads: 1, writer: 1 };

/** A span that began this long before a range may still reach into it (commands, visits; sessions and turns bring their own ends). */
const SPAN_MS = 3 * 86400_000;

/** The journal kinds that are events in the log, by their type there. */
const FACT_KINDS: JournalEventKind[] = ["command", "git.commit", "git.merge", "git.checkout", "git.branch", "git.tag", "git.rebase", "git.reset", "browser.visit", "file.open", "note", "space.open", "space.close"];

/** What a recorder hands in: an event without its row id. */
export type NewJournalEvent = Omit<JournalEvent, "id" | "source"> & { source?: JournalEvent["source"] };

export interface EventQuery {
  since?: number;
  until?: number;
  spaceId?: SpaceId;
  /** Events of this repository (the project), whichever Space they were in. */
  repo?: string;
  kinds?: JournalEventKind[];
  limit?: number;
}

export interface JournalSources {
  /** Turns started since a time, with where each agent ran (the turns view). */
  turns?: ((since: number) => { turn: AgentTurn; cwd: string | null }[]) | null;
  /** Sessions active since a time (the transcript index); null while there is none. */
  sessions?: ((since: number) => SessionRow[] | null) | null;
}

export class JournalStore {
  #db: DatabaseSync;
  #stmts = new Map<string, StatementSync>();
  readonly data: DataService;
  #sources: JournalSources;
  /** Derived kinds seeded directly (fixtures, the lab): held here, since they aren't events in the log. */
  #extra: JournalEvent[] = [];

  /** The cmd that records: its version, or "source+<build>". */
  readonly recordedBy: string | null;

  /** `db`: the core's database (Store.db); `data`: the event log. In memory without them (tests). */
  constructor(db: DatabaseSync | null = null, o: { recordedBy?: string | null; data?: DataService } & JournalSources = {}) {
    this.#db = db ?? new DatabaseSync(":memory:");
    this.data = o.data ?? new DataService({ file: null, recordedBy: o.recordedBy ?? "test", settings: () => DEFAULT_SETTINGS });
    this.#sources = { turns: o.turns ?? null, sessions: o.sessions ?? null };
    this.recordedBy = o.recordedBy ?? null;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS journal_days (
        scope TEXT NOT NULL,
        date INTEGER NOT NULL,
        doc TEXT NOT NULL,
        PRIMARY KEY (scope, date)
      );
      CREATE TABLE IF NOT EXISTS journal_days_history (
        scope TEXT NOT NULL,
        date INTEGER NOT NULL,
        replaced_at INTEGER NOT NULL,
        doc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_days_history_day ON journal_days_history(scope, date);
      CREATE TABLE IF NOT EXISTS journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schema_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    `);
    this.#upgrade();
  }

  /** Runs the data upgrades from the database's schema to this cmd's. A database from a newer cmd is read as it is. */
  #upgrade(): void {
    const row = this.#db.prepare(`SELECT version FROM schema_versions WHERE name = 'journal'`).get() as { version: number } | undefined;
    const from = row?.version ?? JOURNAL_SCHEMA;
    if (from > JOURNAL_SCHEMA) return log.warn("journal written by a newer cmd: reading what it can", { schema: from, ours: JOURNAL_SCHEMA });
    if (row && from === JOURNAL_SCHEMA) return;
    this.#db.exec("BEGIN");
    try {
      for (let v = from + 1; v <= JOURNAL_SCHEMA; v++) UPGRADES[v]?.(this.#db);
      this.#db.prepare(`INSERT OR REPLACE INTO schema_versions (name, version, updated_at) VALUES ('journal', ?, ?)`).run(JOURNAL_SCHEMA, Date.now());
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    if (row) log.info("journal upgraded", { from, to: JOURNAL_SCHEMA });
  }

  /** The schema the database is at. */
  schemaVersion(): number {
    return (this.#db.prepare(`SELECT version FROM schema_versions WHERE name = 'journal'`).get() as { version: number }).version;
  }

  /** Small state that outlives the core: sync cursors, the sources format git was read with. */
  meta(key: string): string | null {
    return (this.#stmt(`SELECT value FROM journal_meta WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.#stmt(`DELETE FROM journal_meta WHERE key = ?`).run(key);
    else this.#stmt(`INSERT OR REPLACE INTO journal_meta (key, value) VALUES (?, ?)`).run(key, value);
  }

  #stmt(sql: string): StatementSync {
    let st = this.#stmts.get(sql);
    if (!st) this.#stmts.set(sql, (st = this.#db.prepare(sql)));
    return st;
  }

  /**
   * Records an event: a fact goes to the log (seen again, it's updated: the
   * span grows, the newest text wins); a derived kind (agent.turn, agent.session)
   * is kept in memory, for fixtures and the lab. Returns its id.
   */
  record(e: NewJournalEvent): number {
    if (e.kind.startsWith("agent.")) {
      const id = 3_000_000_000 + this.#extra.length;
      this.#extra.push({ ...e, id, source: e.source ?? "backfill" });
      return id;
    }
    const d = this.data.record(toData(e));
    return d?.seq ?? 0;
  }

  /** Several at once, in one transaction (backfills). */
  recordAll(events: NewJournalEvent[]): number {
    const facts = events.filter((e) => !e.kind.startsWith("agent."));
    for (const e of events) if (e.kind.startsWith("agent.")) this.record(e);
    this.data.recordAll(facts.map(toData));
    return events.length;
  }

  /** Oldest first. Spans that began before `since` but reach into it count. */
  events(q: EventQuery = {}): JournalEvent[] {
    const want = (k: JournalEventKind) => !q.kinds?.length || q.kinds.includes(k);
    const inRange = (e: JournalEvent) => (q.since === undefined || (e.until ?? e.at) >= q.since) && (q.until === undefined || e.at < q.until);
    const inScope = (e: JournalEvent) => (!q.spaceId || e.spaceId === q.spaceId) && (!q.repo || e.repo === q.repo);
    const out: JournalEvent[] = [];
    const types = FACT_KINDS.filter(want) as DataEventType[];
    if (types.length) {
      const at: [number, number] | undefined = q.since !== undefined || q.until !== undefined ? [q.since !== undefined ? q.since - SPAN_MS : 0, q.until ?? Number.MAX_SAFE_INTEGER] : undefined;
      for (const d of this.data.query({ types, at, spaceId: q.spaceId, projectId: q.repo ? `dir:${q.repo}` : undefined, limit: 100_000 })) {
        const e = toJournal(d);
        if (e && inRange(e)) out.push(e);
      }
    }
    const since = (q.since ?? 0) - SPAN_MS;
    if (want("agent.turn") && this.#sources.turns) {
      let n = 0;
      for (const { turn, cwd } of this.#sources.turns(since)) {
        const e = { ...turnEvent(turn, cwd, "backfill"), id: 1_000_000_000 + n++, source: "backfill" as const };
        if (inRange(e) && inScope(e)) out.push(e);
      }
    }
    if (want("agent.session") && this.#sources.sessions) {
      const rows = this.#sources.sessions(since);
      let n = 0;
      if (rows) for (const s of sessionEvents(rows)) {
        const e = { ...s, id: 2_000_000_000 + n++, source: "backfill" as const };
        if (inRange(e) && inScope(e)) out.push(e);
      }
    }
    for (const e of this.#extra) if (want(e.kind) && inRange(e) && inScope(e)) out.push(e);
    out.sort((a, b) => a.at - b.at || a.id - b.id);
    return out.slice(0, q.limit ?? 50_000);
  }

  /** Repositories with events since `since`, most active first. */
  repos(since = 0): { repo: string; events: number }[] {
    const rows = this.data.store.db.prepare(`SELECT project_id, COUNT(*) AS events FROM events WHERE project_id LIKE 'dir:%' AND at >= ? GROUP BY project_id ORDER BY events DESC`).all(since) as { project_id: string; events: number }[];
    return rows.map((r) => ({ repo: r.project_id.slice(4), events: r.events }));
  }

  day(scope: string, date: number): JournalDay | null {
    const r = this.#stmt(`SELECT doc FROM journal_days WHERE scope = ? AND date = ?`).get(scope, date) as { doc: string } | undefined;
    return r ? toDay(r.doc) : null;
  }

  days(scope: string, since: number, until = Infinity): JournalDay[] {
    const rows = this.#stmt(`SELECT doc FROM journal_days WHERE scope = ? AND date >= ? AND date < ? ORDER BY date DESC`).all(scope, since, Number.isFinite(until) ? until : Number.MAX_SAFE_INTEGER) as { doc: string }[];
    return rows.flatMap((r) => toDay(r.doc) ?? []);
  }

  /** Saves a day; the one it replaces goes to the history (the newest few per day are kept). */
  saveDay(d: JournalDay): void {
    const { outdated: _, ...doc } = d;
    this.#db.exec("BEGIN");
    try {
      const old = this.#stmt(`SELECT doc FROM journal_days WHERE scope = ? AND date = ?`).get(d.scope, d.date) as { doc: string } | undefined;
      if (old) {
        this.#stmt(`INSERT INTO journal_days_history (scope, date, replaced_at, doc) VALUES (?, ?, ?, ?)`).run(d.scope, d.date, Date.now(), old.doc);
        this.#stmt(
          `DELETE FROM journal_days_history WHERE scope = ? AND date = ? AND rowid NOT IN (SELECT rowid FROM journal_days_history WHERE scope = ? AND date = ? ORDER BY replaced_at DESC, rowid DESC LIMIT ?)`,
        ).run(d.scope, d.date, d.scope, d.date, HISTORY_PER_DAY);
      }
      this.#stmt(`INSERT OR REPLACE INTO journal_days (scope, date, doc) VALUES (?, ?, ?)`).run(d.scope, d.date, JSON.stringify(doc));
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Earlier versions of a day, newest first. */
  history(scope: string, date: number): JournalDay[] {
    const rows = this.#stmt(`SELECT doc FROM journal_days_history WHERE scope = ? AND date = ? ORDER BY replaced_at DESC, rowid DESC`).all(scope, date) as { doc: string }[];
    return rows.flatMap((r) => toDay(r.doc) ?? []);
  }
}

/** A journal event as the log records it: the kind is the type, the key the id, the project the repository. */
export function toData(e: NewJournalEvent): NewDataEvent {
  const { kind, ...rest } = e.data as JournalData & Record<string, unknown>;
  const repo = e.repo ?? (e.cwd ? projectOf(e.cwd) : null);
  const data: Record<string, unknown> = { ...rest };
  if (kind.startsWith("git.") && repo) data.repo = repo;
  if (kind === "command") (data.cwd = e.cwd ?? ""), delete data.paneId;
  if (kind === "browser.visit" || kind === "file.open") delete data.windowId;
  return {
    id: e.key,
    at: e.at,
    until: e.until,
    type: kind as DataEventType,
    source: kind.startsWith("git.") ? "git" : e.source === "backfill" ? "import:journal" : "journal",
    spaceId: e.spaceId,
    projectId: repo ? `dir:${repo}` : null,
    paneId: typeof (e.data as { paneId?: unknown }).paneId === "string" ? ((e.data as { paneId: string }).paneId as string) : null,
    windowId: typeof (e.data as { windowId?: unknown }).windowId === "string" ? ((e.data as { windowId: string }).windowId as string) : null,
    text: e.text,
    body: kind === "note" || kind === "git.commit" ? e.text : null,
    data: data as NewDataEvent["data"],
  };
}

/** A logged event as the journal sees it; null for kinds the journal doesn't know or data it can't read. */
export function toJournal(d: DataEvent): JournalEvent | null {
  if (!FACT_KINDS.includes(d.type as JournalEventKind)) return null;
  const payload = d.data as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object") return null;
  const kind = d.type as JournalEventKind;
  const repo = d.projectId?.startsWith("dir:") ? d.projectId.slice(4) : null;
  let data: Record<string, unknown> = { kind, ...payload };
  let cwd: string | null = null;
  let thread: string | null = null;
  if (kind === "command") (data = { kind, command: payload.command ?? null, exitCode: payload.exitCode ?? null, paneId: d.paneId }), (cwd = (payload.cwd as string) || null), (thread = d.paneId ? `pane:${d.paneId}` : null);
  else if (kind === "browser.visit") (data = { kind, url: payload.url, title: payload.title ?? null, windowId: d.windowId }), (thread = d.windowId ? `window:${d.windowId}` : null);
  else if (kind === "file.open") (data = { kind, path: payload.path, windowKind: payload.windowKind, windowId: d.windowId }), (cwd = typeof payload.path === "string" ? payload.path : null), (thread = d.windowId ? `window:${d.windowId}` : null);
  return {
    id: d.seq,
    at: d.at,
    until: d.until,
    kind,
    key: d.id,
    spaceId: d.spaceId,
    repo,
    cwd,
    thread,
    text: d.text ?? "",
    data: data as JournalData,
    source: d.source === "git" || d.source.startsWith("import") || d.flags & DATA_FLAGS.imported ? "backfill" : "live",
  };
}

/** A stored day, with what older documents lack filled in. */
function toDay(doc: string): JournalDay | null {
  try {
    const d = JSON.parse(doc) as Partial<JournalDay>;
    if (typeof d.date !== "number" || !Array.isArray(d.entries)) return null;
    return { ...d, format: { ...FORMAT_1, ...d.format }, eventsHash: d.eventsHash ?? "", inputHash: d.inputHash ?? "" } as JournalDay;
  } catch {
    return null;
  }
}
