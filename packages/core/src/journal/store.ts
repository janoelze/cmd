// The journal over the event log (docs/23, docs/28): what it reads as events is
// assembled from the log (commands, git, pages, files, notes, workspaces), the
// turns view (agent.turn) and the transcript index's sessions (agent.session);
// nothing is copied into a journal table any more. What the journal owns is
// the days a model wrote and their history (journal_days, journal_days_history),
// its sync cursors (journal_meta) and its schema version, in the core's database.
//
// Versions (docs/24): JOURNAL_SCHEMA covers the days' documents; UPGRADES move
// an older database forward. SOURCES_FORMAT covers how turns, sessions and git
// become events; THREADS_FORMAT and WRITER_FORMAT the layers above.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { DATA_FLAGS, DEFAULT_SETTINGS, JOURNAL_SCHEMA, type AgentTurn, type DataEvent, type DataEventType, type JournalData, type JournalDay, type JournalEvent, type JournalEventKind, type JournalWeek, type NewDataEvent, type Workspace, type WorkspaceId } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { DataService } from "../data/service.ts";
import { projectOf } from "../data/project.ts";
import type { Pacer } from "../scheduler.ts";
import { workspaceAt } from "../workspaces/paths.ts";
import type { SessionRow } from "../data/views/sessions.ts";
import { projectsOnce, sessionEvents, turnEvent } from "./backfill.ts";

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
const FACT_KINDS: JournalEventKind[] = ["command", "git.commit", "git.merge", "git.checkout", "git.branch", "git.tag", "git.rebase", "git.reset", "browser.visit", "file.open", "note", "workspace.open", "workspace.close"];

/** What a recorder hands in: an event without its row id. */
export type NewJournalEvent = Omit<JournalEvent, "id" | "source"> & { source?: JournalEvent["source"] };

export interface EventQuery {
  since?: number;
  until?: number;
  workspaceId?: WorkspaceId;
  /** Events of this repository (the project), whichever workspace they were in. */
  repo?: string;
  kinds?: JournalEventKind[];
  limit?: number;
}

export interface JournalSources {
  /** Turns started since a time, with where each agent ran (the turns view). */
  turns?: ((since: number) => { turn: AgentTurn; cwd: string | null }[]) | null;
  /** Sessions active since a time (the transcript index); null while there is none. */
  sessions?: ((since: number) => SessionRow[] | null) | null;
  /** The open workspaces: turns and sessions belong to the one whose folder holds their project or folder (workspaceAt). */
  workspaces?: (() => Workspace[]) | null;
}

/** Rows read per step when the log's backfilled events are given their workspaces. */
const ASSIGN_STEP = 500;

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
    this.#sources = { turns: o.turns ?? null, sessions: o.sessions ?? null, workspaces: o.workspaces ?? null };
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
      CREATE TABLE IF NOT EXISTS journal_weeks (scope TEXT NOT NULL, start INTEGER NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (scope, start));
      CREATE TABLE IF NOT EXISTS schema_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    `);
    this.#renameSpaces();
    this.#upgrade();
  }

  /** Before 0.24 workspaces were Spaces: scopes were "space:<id>", and days and weeks said spaceId. Once per database. */
  #renameSpaces(): void {
    if (this.meta("workspaces")) return;
    this.#db.exec("BEGIN");
    try {
      for (const t of ["journal_days", "journal_days_history", "journal_weeks"])
        this.#db.exec(
          `UPDATE ${t} SET scope = CASE WHEN scope LIKE 'space:%' THEN 'workspace:' || substr(scope, 7) ELSE scope END,
             doc = replace(replace(doc, '"spaceId":', '"workspaceId":'), '"space.', '"workspace.')
           WHERE scope LIKE 'space:%' OR doc LIKE '%"spaceId":%' OR doc LIKE '%"space.%'`,
        );
      this.setMeta("workspaces", "1");
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
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
    const out: JournalEvent[] = [];
    const types = this.#types(q);
    if (types.length) {
      const at: [number, number] | undefined = q.since !== undefined || q.until !== undefined ? [q.since !== undefined ? q.since - SPAN_MS : 0, q.until ?? Number.MAX_SAFE_INTEGER] : undefined;
      out.push(...this.#facts(q, types, at, 100_000));
    }
    return this.#finish(q, out);
  }

  /**
   * Every event since a time, as events({ since }) reads them, for several days
   * at once (the journal's pool): the log is read a day of its time index at a
   * time, between `step`s (the scheduler's yield), so no one statement grows
   * with the range; facts that begin from `until` on are left out. Null when
   * there are more than `limit`: the caller reads day by day instead.
   */
  async eventsSince(since: number, o: { until: number; limit: number; step: () => Promise<void> }): Promise<JournalEvent[] | null> {
    const q: EventQuery = { since };
    const types = this.#types(q);
    const out: JournalEvent[] = [];
    const end = o.until;
    for (let t = since - SPAN_MS; t < end; t += 86400_000) {
      // A day's worth from the time index; at most one more than the limit, which says it's over.
      out.push(...this.#facts(q, types, [t, Math.min(t + 86400_000, end)], o.limit + 1 - out.length));
      if (out.length > o.limit) return null;
      await o.step();
    }
    const all = this.#finish(q, out, Number.MAX_SAFE_INTEGER);
    return all.length > o.limit ? null : all;
  }

  #types(q: EventQuery): DataEventType[] {
    return FACT_KINDS.filter((k) => !q.kinds?.length || q.kinds.includes(k)) as DataEventType[];
  }

  /** Facts from the log in a range of their start (`at`), as journal events in the query's range. */
  #facts(q: EventQuery, types: DataEventType[], at: [number, number] | undefined, limit: number): JournalEvent[] {
    const out: JournalEvent[] = [];
    if (limit <= 0) return out;
    for (const d of this.data.query({ types, at, workspaceId: q.workspaceId, projectId: q.repo ? `dir:${q.repo}` : undefined, limit })) {
      const e = toJournal(d);
      if (e && inRange(q, e)) out.push(e);
    }
    return out;
  }

  /** The derived kinds (turns, sessions, seeded ones) added to facts, sorted and cut. */
  #finish(q: EventQuery, out: JournalEvent[], limit = q.limit ?? 50_000): JournalEvent[] {
    const want = (k: JournalEventKind) => !q.kinds?.length || q.kinds.includes(k);
    const inScope = (e: JournalEvent) => (!q.workspaceId || e.workspaceId === q.workspaceId) && (!q.repo || e.repo === q.repo);
    const since = (q.since ?? 0) - SPAN_MS;
    const project = projectsOnce();
    // Turns and sessions are read from history: like git, they belong to the workspace their folder is in.
    const spaces = this.#sources.workspaces?.() ?? [];
    const placed = <T extends NewJournalEvent>(e: T): T => (e.workspaceId ? e : { ...e, workspaceId: workspaceAt(spaces, e.repo ?? e.cwd) });
    if (want("agent.turn") && this.#sources.turns) {
      let n = 0;
      for (const { turn, cwd } of this.#sources.turns(since)) {
        const e = { ...placed(turnEvent(turn, cwd, "backfill", project)), id: 1_000_000_000 + n++, source: "backfill" as const };
        if (inRange(q, e) && inScope(e)) out.push(e);
      }
    }
    if (want("agent.session") && this.#sources.sessions) {
      const rows = this.#sources.sessions(since);
      let n = 0;
      if (rows) for (const s of sessionEvents(rows, project)) {
        const e = { ...placed(s), id: 2_000_000_000 + n++, source: "backfill" as const };
        if (inRange(q, e) && inScope(e)) out.push(e);
      }
    }
    for (const e of this.#extra) if (want(e.kind) && inRange(q, e) && inScope(e)) out.push(e);
    out.sort((a, b) => a.at - b.at || a.id - b.id);
    return out.slice(0, limit);
  }

  /**
   * Gives the journal's backfilled events in the log (git, older cmds' imports)
   * that have no workspace the one `workspaceOf` says for their project or
   * folder, as recording them now would; the rest stay as they are. Reads each
   * kind through its time index, ASSIGN_STEP rows per step with `pace` between,
   * so a big log never holds the thread. Only workspace_id changes: not the
   * text, so the full-text index stays, nor anything a day's eventsHash reads.
   * Idempotent: a row once given a workspace is never read for one again.
   */
  async assignWorkspaces(workspaceOf: (p: string | null) => WorkspaceId | null, pace: Pacer): Promise<{ scanned: number; changed: number }> {
    const db = this.data.store.db;
    const read = db.prepare(
      `SELECT seq, at, source, flags, workspace_id AS w, project_id AS p,
         CASE WHEN workspace_id IS NULL THEN data->>'$.cwd' END AS cwd, CASE WHEN workspace_id IS NULL THEN data->>'$.path' END AS path
       FROM events WHERE type = ? AND (at > ? OR (at = ? AND seq > ?)) ORDER BY at, seq LIMIT ?`,
    );
    const write = db.prepare(`UPDATE events SET workspace_id = ? WHERE seq = ? AND workspace_id IS NULL`);
    let scanned = 0;
    let changed = 0;
    for (const type of FACT_KINDS) {
      for (let at = Number.MIN_SAFE_INTEGER, seq = 0; ; ) {
        const done = pace.mark("journal workspaces");
        let rows: { seq: number; at: number; source: string; flags: number; w: string | null; p: string | null; cwd: string | null; path: string | null }[];
        try {
          rows = read.all(type, at, at, seq, ASSIGN_STEP) as typeof rows;
          scanned += rows.length;
          const set: [WorkspaceId, number][] = [];
          for (const r of rows) {
            if (r.w !== null || !isBackfill(r.source, r.flags)) continue;
            // Where toJournal says the event happened: its project, else its folder (a command's, a file's).
            const repo = r.p?.startsWith("dir:") ? r.p.slice(4) : null;
            const id = workspaceOf(repo ?? (type === "command" ? r.cwd : type === "file.open" ? r.path : null) ?? null);
            if (id) set.push([id, r.seq]);
          }
          if (set.length) this.data.store.transaction(() => {
            for (const [id, s] of set) changed += Number(write.run(id, s).changes);
          });
        } finally {
          done();
        }
        if (rows.length < ASSIGN_STEP) break;
        ({ at, seq } = rows[rows.length - 1]!);
        await pace.yield();
      }
    }
    return { scanned, changed };
  }

  /**
   * Repositories with events since `since`, with their newest event's time. A
   * skip scan over the project index (one seek per project, then its newest
   * event): a DISTINCT over the range read every entry of it, 540k on a big
   * log, half a second when they weren't cached (AR1-16-03).
   */
  repos(since = 0): { repo: string; last: number }[] {
    const next = this.data.store.db.prepare(`SELECT project_id AS p FROM events WHERE project_id > ? AND project_id < 'dir;' ORDER BY project_id LIMIT 1`);
    const last = this.data.store.db.prepare(`SELECT MAX(at) AS at FROM events WHERE project_id = ?`);
    const out: { repo: string; last: number }[] = [];
    for (let p = "dir:"; ; ) {
      const r = next.get(p) as { p: string } | undefined;
      if (!r) return out;
      p = r.p;
      const at = (last.get(p) as { at: number | null }).at ?? 0;
      if (at >= since) out.push({ repo: p.slice(4), last: at });
    }
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

  week(scope: string, start: number): JournalWeek | null {
    const r = this.#stmt(`SELECT doc FROM journal_weeks WHERE scope = ? AND start = ?`).get(scope, start) as { doc: string } | undefined;
    if (!r) return null;
    try {
      const w = JSON.parse(r.doc) as JournalWeek;
      return typeof w.start === "number" && Array.isArray(w.themes) ? w : null;
    } catch {
      return null;
    }
  }

  saveWeek(w: JournalWeek): void {
    this.#stmt(`INSERT OR REPLACE INTO journal_weeks (scope, start, doc) VALUES (?, ?, ?)`).run(w.scope, w.start, JSON.stringify(w));
  }

  /** Earlier versions of a day, newest first. */
  history(scope: string, date: number): JournalDay[] {
    const rows = this.#stmt(`SELECT doc FROM journal_days_history WHERE scope = ? AND date = ? ORDER BY replaced_at DESC, rowid DESC`).all(scope, date) as { doc: string }[];
    return rows.flatMap((r) => toDay(r.doc) ?? []);
  }
}

/** Whether an event (a span) reaches into a query's range. */
const inRange = (q: EventQuery, e: JournalEvent) => (q.since === undefined || (e.until ?? e.at) >= q.since) && (q.until === undefined || e.at < q.until);

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
    workspaceId: e.workspaceId,
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
    workspaceId: d.workspaceId,
    repo,
    cwd,
    thread,
    text: d.text ?? "",
    data: data as JournalData,
    source: isBackfill(d.source, d.flags) ? "backfill" : "live",
  };
}

/** Whether a logged event was read from history (git, an import) rather than recorded as it happened. */
const isBackfill = (source: string, flags: number) => source === "git" || source.startsWith("import") || (flags & DATA_FLAGS.imported) !== 0;

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
