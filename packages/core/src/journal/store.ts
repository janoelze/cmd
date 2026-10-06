// The journal's tables (docs/23-journal.md), in the core's database: events as
// they're recorded, and the days a model wrote from them. An event has a key,
// so seeing it twice (live and from a backfill, or a session that grows) updates
// it instead of adding another. Kept for months, unlike the activity log.
//
// Versions (docs/24-journal-versions.md): every event row says which schema and
// which cmd wrote it; a newer cmd adds the columns it needs (COLUMNS) and runs
// the upgrades between the database's schema and its own (UPGRADES), then
// records the schema in schema_versions. A day that's written again keeps its
// earlier version in journal_days_history, so revisions can be compared.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { JOURNAL_SCHEMA, type JournalData, type JournalDay, type JournalEvent, type JournalEventKind, type SpaceId } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";

const log = logger("journal");

/** Earlier versions of a day kept when it's written again. */
const HISTORY_PER_DAY = 3;

/** Columns added after a table was first created: added to older databases as they're opened. */
const COLUMNS: Record<string, [string, string][]> = {
  journal_events: [["cmd", "TEXT"]],
};

/**
 * Data upgrades: UPGRADES[n] takes a database at schema n - 1 to n (reshape a
 * kind's data, fill a new field). Run in order, in one transaction, when a cmd
 * with a newer JOURNAL_SCHEMA opens an older database. Pulled sources don't
 * need one (raise SOURCES_FORMAT and they're read again); live events (commands,
 * pages, files, notes) do, or readers must take both shapes.
 */
export const UPGRADES: Record<number, (db: DatabaseSync) => void> = {};

/** Day documents from before days carried their format: format 1. */
const FORMAT_1 = { schema: 1, threads: 1, writer: 1 };

/** Events older than this are dropped; written days stay (they're small). */
export const KEEP_MS = 180 * 86400_000;

/** What a recorder hands in: an event without its row id. */
export type NewJournalEvent = Omit<JournalEvent, "id" | "source"> & { source?: JournalEvent["source"] };

interface Row {
  id: number;
  at: number;
  until: number | null;
  kind: string;
  key: string;
  space_id: string | null;
  repo: string | null;
  cwd: string | null;
  thread: string | null;
  text: string;
  data: string;
  source: string;
  schema: number;
  cmd: string | null;
}

export interface EventQuery {
  since?: number;
  until?: number;
  spaceId?: SpaceId;
  /** Events of this repository (the project), whichever Space they were in. */
  repo?: string;
  kinds?: JournalEventKind[];
  limit?: number;
}

export class JournalStore {
  #db: DatabaseSync;
  #stmts = new Map<string, StatementSync>();

  /** The cmd that records: its version, or "source+<build>". */
  readonly recordedBy: string | null;

  /** `db`: the core's database (Store.db); in memory without one. */
  constructor(db: DatabaseSync | null = null, o: { recordedBy?: string | null } = {}) {
    this.#db = db ?? new DatabaseSync(":memory:");
    this.recordedBy = o.recordedBy ?? null;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS journal_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        until INTEGER,
        kind TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        space_id TEXT,
        repo TEXT,
        cwd TEXT,
        thread TEXT,
        text TEXT NOT NULL,
        data TEXT NOT NULL,
        source TEXT NOT NULL,
        schema INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_events_at ON journal_events(at);
      CREATE INDEX IF NOT EXISTS journal_events_space ON journal_events(space_id, at);
      CREATE INDEX IF NOT EXISTS journal_events_repo ON journal_events(repo, at);
      CREATE INDEX IF NOT EXISTS journal_events_thread ON journal_events(thread);
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
    for (const [table, cols] of Object.entries(COLUMNS)) {
      const have = new Set((this.#db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      for (const [name, type] of cols) if (!have.has(name)) this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
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

  /** Small state that outlives the core: sync cursors, the sources format events were read with. */
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
   * Adds an event, or updates the one with its key: the span grows, the text and
   * data are the newest, and a live recording wins over a backfill. Returns its id.
   */
  record(e: NewJournalEvent): number {
    const r = this.#stmt(
      `INSERT INTO journal_events (at, until, kind, key, space_id, repo, cwd, thread, text, data, source, schema, cmd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         at = MIN(at, excluded.at),
         until = MAX(COALESCE(until, excluded.until), COALESCE(excluded.until, until)),
         text = excluded.text,
         data = excluded.data,
         space_id = COALESCE(excluded.space_id, space_id),
         repo = COALESCE(excluded.repo, repo),
         cwd = COALESCE(excluded.cwd, cwd),
         thread = COALESCE(excluded.thread, thread),
         source = CASE WHEN source = 'live' THEN 'live' ELSE excluded.source END,
         schema = excluded.schema,
         cmd = excluded.cmd
       RETURNING id`,
    ).get(e.at, e.until, e.kind, e.key, e.spaceId, e.repo, e.cwd, e.thread, e.text, JSON.stringify(e.data), e.source ?? "live", JOURNAL_SCHEMA, this.recordedBy) as { id: number };
    return r.id;
  }

  /** Several at once, in one transaction (backfills). */
  recordAll(events: NewJournalEvent[]): number {
    this.#db.exec("BEGIN");
    try {
      for (const e of events) this.record(e);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    return events.length;
  }

  /** Oldest first. Spans that began before `since` but reach into it count. */
  events(q: EventQuery = {}): JournalEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.since !== undefined) where.push("COALESCE(until, at) >= ?"), args.push(q.since);
    if (q.until !== undefined) where.push("at < ?"), args.push(q.until);
    if (q.spaceId) where.push("space_id = ?"), args.push(q.spaceId);
    if (q.repo) where.push("repo = ?"), args.push(q.repo);
    if (q.kinds?.length) where.push(`kind IN (${q.kinds.map(() => "?").join(", ")})`), args.push(...q.kinds);
    const sql = `SELECT * FROM journal_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at, id LIMIT ?`;
    const rows = this.#db.prepare(sql).all(...args, q.limit ?? 50_000) as unknown as Row[];
    return rows.flatMap((r) => toEvent(r) ?? []);
  }

  /** Repositories with events since `since`, most active first. */
  repos(since = 0): { repo: string; events: number }[] {
    return this.#stmt(`SELECT repo, COUNT(*) AS events FROM journal_events WHERE repo IS NOT NULL AND at >= ? GROUP BY repo ORDER BY events DESC`).all(since) as { repo: string; events: number }[];
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

  prune(now = Date.now()): void {
    this.#stmt(`DELETE FROM journal_events WHERE COALESCE(until, at) < ?`).run(now - KEEP_MS);
  }
}

/** A row as an event; null when its data can't be read (logged, skipped: one bad row never hides a day). */
function toEvent(r: Row): JournalEvent | null {
  let data: JournalData;
  try {
    data = JSON.parse(r.data) as JournalData;
  } catch {
    log.warn("journal event skipped: unreadable data", { id: r.id, kind: r.kind, schema: r.schema });
    return null;
  }
  // Events are typed by their data's kind; a row whose kind it doesn't match is from a format this cmd doesn't know.
  if (!data || typeof data !== "object" || data.kind !== r.kind) return null;
  return {
    id: r.id,
    at: r.at,
    until: r.until,
    kind: r.kind as JournalEventKind,
    key: r.key,
    spaceId: r.space_id,
    repo: r.repo,
    cwd: r.cwd,
    thread: r.thread,
    text: r.text,
    data,
    source: r.source === "backfill" ? "backfill" : "live",
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
