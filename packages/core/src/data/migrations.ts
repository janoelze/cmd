// The events file's migrations (docs/28 §7, "Upgrades"): one schema version in
// meta('schema'), moved forward by the numbered steps below, never backward. A
// file is copied aside first (events.sqlite.bak-v<n>), then every step it lacks
// runs in one BEGIN IMMEDIATE: all of them or none. A file newer than this code
// is refused (EventsLogTooNew), since an older cmd would write rows the newer
// one can't read. Steps are frozen once released: a later change is a new step,
// and the test that migrates a v1 log checks it ends up as a new one would.
// Payload shapes don't change here: they have `v` and upcast.ts.

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { logger } from "@cmd/protocol/node";
import { EVENTS_SCHEMA, PRAGMA_SQL } from "./schema.ts";

const log = logger("data");

export interface Migration {
  /** The schema the file has after this step. */
  to: number;
  /** What it does, for the log. */
  label: string;
  /** Inside the migration's transaction; `progress` says how far a long step is. */
  run(db: DatabaseSync, progress: (done: number, total: number) => void): void;
}

/** A log written by a newer cmd than this one: not opened, not written to. */
export class EventsLogTooNew extends Error {
  override name = "EventsLogTooNew";
  readonly file: string;
  readonly schema: number;
  readonly supported: number;
  constructor(file: string, schema: number, supported: number) {
    super(`${file} is from a newer cmd (event log schema ${schema}, this cmd knows ${supported}): update cmd to open it`);
    this.file = file;
    this.schema = schema;
    this.supported = supported;
  }
}

const has = (db: DatabaseSync, sql: string, ...args: string[]) => !!db.prepare(sql).get(...args);
const hasTable = (db: DatabaseSync, name: string) => has(db, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name);

/**
 * The file's schema: 0 for a file with no log in it yet (new), else
 * meta('schema'), which every log has had since its first open (1 when a
 * log has events but no version: there was never one before 1).
 */
export function schemaOf(db: DatabaseSync): number {
  if (!hasTable(db, "events")) return 0;
  const row = hasTable(db, "meta") ? (db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value: string } | undefined) : undefined;
  return row ? Number(row.value) || 1 : 1;
}

// ── 2: workspaces, indexes in the schema ──────────────────

const INDEXES_V2 = `
CREATE INDEX IF NOT EXISTS events_at ON events(at);
CREATE INDEX IF NOT EXISTS events_type_at ON events(type, at);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, seq);
CREATE INDEX IF NOT EXISTS events_project_at ON events(project_id, at);
CREATE INDEX IF NOT EXISTS events_workspace_at ON events(workspace_id, at);
CREATE INDEX IF NOT EXISTS events_parent ON events(parent_id);
CREATE INDEX IF NOT EXISTS blobs_unreferenced ON blobs(refs) WHERE refs <= 0;
CREATE INDEX IF NOT EXISTS links_to ON links(to_kind, to_id);
`;
function toV2(db: DatabaseSync): void {
  // Before 0.24 workspaces were Spaces: the events' column, the open/close types, entities and links.
  if (has(db, `SELECT 1 FROM pragma_table_info('events') WHERE name = 'space_id'`)) {
    db.exec(`
      DROP INDEX IF EXISTS events_space_at;
      ALTER TABLE events RENAME COLUMN space_id TO workspace_id;
      UPDATE events SET type = 'workspace' || substr(type, 6) WHERE type IN ('space.open', 'space.close');
      UPDATE entities SET kind = 'workspace' WHERE kind = 'space';
      UPDATE links SET from_kind = 'workspace' WHERE from_kind = 'space';
      UPDATE links SET to_kind = 'workspace' WHERE to_kind = 'space';
    `);
  }
  // Transcript lines without a timestamp were once stored at 0 (and dropped by retention). The ingest used to
  // delete them whenever its view's version changed; they go once here, and the transcripts are read again then.
  const stale = `type >= 'transcript.' AND type < 'transcript/' AND at < 1`;
  db.exec(`UPDATE blobs SET refs = refs - x.n FROM (SELECT blob, COUNT(*) AS n FROM events WHERE ${stale} AND blob IS NOT NULL GROUP BY blob) AS x WHERE blobs.hash = x.blob`);
  // Out of the full-text index too, and of the one a rebuild cut short was filling (events_fts_next: fts.ts; it
  // goes on from its cursor). events_fts_old is only waiting to be dropped.
  for (const fts of ["events_fts", "events_fts_next"]) if (hasTable(db, fts)) db.exec(`DELETE FROM ${fts} WHERE rowid IN (SELECT seq FROM events WHERE ${stale})`);
  db.exec(`DELETE FROM events WHERE ${stale}`);
  db.exec(INDEXES_V2);
}

/** Every step, in order; the last one's `to` is EVENTS_SCHEMA. */
export const MIGRATIONS: Migration[] = [{ to: 2, label: "workspaces, indexes", run: toV2 }];

/**
 * Brings the log in `db` to EVENTS_SCHEMA: refuses a newer one, copies an
 * older one aside (`<file>.bak-v<n>`; not for a file in memory) and runs the
 * steps it lacks in one transaction. Returns what it did, or null when the
 * file is new or current.
 */
export function migrate(db: DatabaseSync, file: string, steps: Migration[] = MIGRATIONS, newest = EVENTS_SCHEMA): { from: number; to: number; backup: string | null; ms: number } | null {
  const from = schemaOf(db);
  if (from > newest) throw new EventsLogTooNew(file, from, newest);
  if (from === 0 || from === newest) return null;
  const pending = steps.filter((s) => s.to > from && s.to <= newest);
  const t0 = Date.now();
  let backup: string | null = null;
  if (file !== ":memory:" && file !== "") {
    // A copy of the file as it was (VACUUM INTO: consistent, compact; it refuses a file that exists).
    backup = `${file}.bak-v${from}`;
    fs.rmSync(backup, { force: true });
    log.info(`event log: schema ${from} → ${newest}; copying it aside first`, { backup });
    db.prepare(`VACUUM INTO ?`).run(backup);
    log.info("event log: copied aside", { ms: Date.now() - t0, bytes: fs.statSync(backup).size });
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const s of pending) {
      const t = Date.now();
      let said = -1;
      log.info(`event log: migrating to schema ${s.to}: ${s.label}`);
      s.run(db, (done, total) => {
        // A line per tenth: a long step says it is still going.
        const tenth = total ? Math.floor((done / total) * 10) : 10;
        if (tenth > said) (said = tenth), log.info(`event log: schema ${s.to}: ${done} of ${total} rows`, { ms: Date.now() - t });
      });
      db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)`).run(String(s.to));
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    log.error(`event log: migration from schema ${from} failed; the file is as it was`, err);
    throw err;
  }
  const ms = Date.now() - t0;
  log.info(`event log: at schema ${newest}`, { from, ms });
  return { from, to: newest, backup, ms };
}

/**
 * The core, before anything else opens the log: an older one is migrated
 * now, while nothing writes to it (the app waits for a core that is alive but
 * not listening yet, and says "Connecting to core…"); a newer one throws
 * EventsLogTooNew. A missing file is left to DataStore to create.
 */
export function prepareEventsLog(file: string): void {
  if (!fs.existsSync(file)) return;
  const db = new DatabaseSync(file, { timeout: 5000 });
  try {
    db.exec(PRAGMA_SQL);
    migrate(db, file);
  } finally {
    db.close();
  }
}
