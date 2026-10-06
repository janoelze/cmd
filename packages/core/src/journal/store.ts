// The journal's tables (docs/23-journal.md), in the core's database: events as
// they're recorded, and the days a model wrote from them. An event has a key,
// so seeing it twice (live and from a backfill, or a session that grows) updates
// it instead of adding another. Kept for months, unlike the activity log.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { JOURNAL_SCHEMA, type JournalData, type JournalDay, type JournalEvent, type JournalEventKind, type SpaceId } from "@cmd/protocol";

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

  /** `db`: the core's database (Store.db); in memory without one. */
  constructor(db: DatabaseSync | null = null) {
    this.#db = db ?? new DatabaseSync(":memory:");
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
    `);
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
      `INSERT INTO journal_events (at, until, kind, key, space_id, repo, cwd, thread, text, data, source, schema)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         at = MIN(at, excluded.at),
         until = MAX(COALESCE(until, excluded.until), COALESCE(excluded.until, until)),
         text = excluded.text,
         data = excluded.data,
         space_id = COALESCE(excluded.space_id, space_id),
         repo = COALESCE(excluded.repo, repo),
         cwd = COALESCE(excluded.cwd, cwd),
         thread = COALESCE(excluded.thread, thread),
         source = CASE WHEN source = 'live' THEN 'live' ELSE excluded.source END
       RETURNING id`,
    ).get(e.at, e.until, e.kind, e.key, e.spaceId, e.repo, e.cwd, e.thread, e.text, JSON.stringify(e.data), e.source ?? "live", JOURNAL_SCHEMA) as { id: number };
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
    return rows.map(toEvent);
  }

  /** Repositories with events since `since`, most active first. */
  repos(since = 0): { repo: string; events: number }[] {
    return this.#stmt(`SELECT repo, COUNT(*) AS events FROM journal_events WHERE repo IS NOT NULL AND at >= ? GROUP BY repo ORDER BY events DESC`).all(since) as { repo: string; events: number }[];
  }

  day(scope: string, date: number): JournalDay | null {
    const r = this.#stmt(`SELECT doc FROM journal_days WHERE scope = ? AND date = ?`).get(scope, date) as { doc: string } | undefined;
    return r ? (JSON.parse(r.doc) as JournalDay) : null;
  }

  days(scope: string, since: number, until = Infinity): JournalDay[] {
    const rows = this.#stmt(`SELECT doc FROM journal_days WHERE scope = ? AND date >= ? AND date < ? ORDER BY date DESC`).all(scope, since, Number.isFinite(until) ? until : Number.MAX_SAFE_INTEGER) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as JournalDay);
  }

  saveDay(d: JournalDay): void {
    this.#stmt(`INSERT OR REPLACE INTO journal_days (scope, date, doc) VALUES (?, ?, ?)`).run(d.scope, d.date, JSON.stringify(d));
  }

  prune(now = Date.now()): void {
    this.#stmt(`DELETE FROM journal_events WHERE COALESCE(until, at) < ?`).run(now - KEEP_MS);
  }
}

function toEvent(r: Row): JournalEvent {
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
    data: JSON.parse(r.data) as JournalData,
    source: r.source === "backfill" ? "backfill" : "live",
  };
}
