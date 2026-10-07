// The facts file (docs/28-data-plan.md, §2): one log of events with one
// envelope, content-addressed blobs for anything big, entities and the links
// between them. Spike (phase 0): the shape under test, measured against the
// author's data by scripts/data/spike.ts before phase 1 builds on it.

/** The events file's schema version: migrations move it forward, never the rows' `v`. */
export const EVENTS_SCHEMA = 1;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY,
  id         TEXT NOT NULL UNIQUE,
  at         INTEGER NOT NULL,
  until      INTEGER,
  type       TEXT NOT NULL,
  v          INTEGER NOT NULL,
  source     TEXT NOT NULL,
  recorded   TEXT NOT NULL,
  parent_id  TEXT,
  space_id   TEXT,
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
CREATE INDEX IF NOT EXISTS events_at ON events(at);
CREATE INDEX IF NOT EXISTS events_type_at ON events(type, at);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, seq);
CREATE INDEX IF NOT EXISTS events_project_at ON events(project_id, at);
CREATE INDEX IF NOT EXISTS events_space_at ON events(space_id, at);
CREATE INDEX IF NOT EXISTS events_parent ON events(parent_id);

CREATE TABLE IF NOT EXISTS blobs (
  hash    TEXT PRIMARY KEY,
  size    INTEGER NOT NULL,
  stored  INTEGER NOT NULL,
  enc     TEXT NOT NULL,
  created INTEGER NOT NULL,
  refs    INTEGER NOT NULL DEFAULT 0,
  bytes   BLOB NOT NULL
);
-- The sweep's rows: without it, deleting unreferenced blobs reads every blob row (seconds on a big log).
CREATE INDEX IF NOT EXISTS blobs_unreferenced ON blobs(refs) WHERE refs <= 0;

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
CREATE INDEX IF NOT EXISTS links_to ON links(to_kind, to_id);
CREATE UNIQUE INDEX IF NOT EXISTS links_one ON links(from_kind, from_id, to_kind, to_id, kind);
`;

/**
 * Full text over events: the one-line text and, for events with words in them
 * (prompts, messages, notes, commit bodies), a body. Contentless: the text is in
 * events and blobs already; rowid = seq. Rebuilt from events when dropped.
 */
export const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  text, body, content='', contentless_delete=1, detail=full, tokenize='unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS events_vocab USING fts5vocab(events_fts, 'row');
`;

/** Event flags. */
export const FLAG_REDACTED = 1;
export const FLAG_CUT = 2;
export const FLAG_IMPORTED = 4;
export const FLAG_TOMBSTONE = 8;
