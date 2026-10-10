// The facts file (docs/28-data-plan.md, §2): one log of events with one
// envelope, content-addressed blobs for anything big, entities and the links
// between them. This is the newest schema, what a new file is created with; a
// file of an older one is moved forward by migrations.ts, never by this.

/** The events file's schema version: migrations move it forward, never the rows' `v`. */
export const EVENTS_SCHEMA = 2;

/** Every connection to the log, the migrations' included. */
export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = OFF;
`;

/**
 * A new log. `seq` is AUTOINCREMENT: never handed out twice, even after the
 * newest rows are deleted (forget, retention), since cursors and subscriptions
 * hold on to it. The indexes come with it: on an empty file they cost nothing,
 * and a migration that adds one builds it once.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  at         INTEGER NOT NULL,
  until      INTEGER,
  type       TEXT NOT NULL,
  v          INTEGER NOT NULL,
  source     TEXT NOT NULL,
  recorded   TEXT NOT NULL,
  parent_id  TEXT,
  workspace_id   TEXT,
  project_id TEXT,
  session_id TEXT,
  agent_id   TEXT,
  pane_id    TEXT,
  window_id  TEXT,
  device_id  TEXT,
  text       TEXT,
  data       BLOB NOT NULL,
  blob       TEXT,
  flags      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS blobs (
  hash    TEXT PRIMARY KEY,
  size    INTEGER NOT NULL,
  stored  INTEGER NOT NULL,
  enc     TEXT NOT NULL,
  created INTEGER NOT NULL,
  refs    INTEGER NOT NULL DEFAULT 0,
  bytes   BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  kind    TEXT NOT NULL,
  id      TEXT NOT NULL,
  created INTEGER NOT NULL,
  seen    INTEGER NOT NULL,
  attrs   BLOB NOT NULL,
  PRIMARY KEY (kind, id)
);

CREATE TABLE IF NOT EXISTS links (
  from_kind TEXT NOT NULL, from_id TEXT NOT NULL,
  to_kind   TEXT NOT NULL, to_id   TEXT NOT NULL,
  kind      TEXT NOT NULL,
  at        INTEGER NOT NULL,
  until     INTEGER,
  PRIMARY KEY (from_kind, from_id, to_kind, to_id, kind, at)
);
CREATE UNIQUE INDEX IF NOT EXISTS links_one ON links(from_kind, from_id, to_kind, to_id, kind);

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

// The full-text index (events_fts) is fts.ts's: it has its own version and rebuild.

/** Event flags. */
export const FLAG_REDACTED = 1;
export const FLAG_CUT = 2;
export const FLAG_IMPORTED = 4;
export const FLAG_TOMBSTONE = 8;
