// An event log as cmd wrote it at schema 1 (before migrations.ts): the tables
// and indexes of that time, `seq` without AUTOINCREMENT, no version compared.
// `spaces`: from before 0.24, when the workspace column was space_id.
import { DatabaseSync } from "node:sqlite";

export function eventsV1(file: string, o: { spaces?: boolean } = {}): DatabaseSync {
  const ws = o.spaces ? "space_id" : "workspace_id";
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, until INTEGER, type TEXT NOT NULL, v INTEGER NOT NULL,
      source TEXT NOT NULL, recorded TEXT NOT NULL, parent_id TEXT, ${ws} TEXT, project_id TEXT, session_id TEXT, agent_id TEXT,
      pane_id TEXT, window_id TEXT, device_id TEXT, text TEXT, data BLOB NOT NULL, blob TEXT, flags INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, stored INTEGER NOT NULL, enc TEXT NOT NULL, created INTEGER NOT NULL, refs INTEGER NOT NULL DEFAULT 0, bytes BLOB NOT NULL);
    CREATE TABLE entities (kind TEXT NOT NULL, id TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL, attrs BLOB NOT NULL, PRIMARY KEY (kind, id));
    CREATE TABLE links (from_kind TEXT NOT NULL, from_id TEXT NOT NULL, to_kind TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, until INTEGER, PRIMARY KEY (from_kind, from_id, to_kind, to_id, kind, at));
    CREATE UNIQUE INDEX links_one ON links(from_kind, from_id, to_kind, to_id, kind);
    CREATE INDEX events_at ON events(at);
    CREATE INDEX events_type_at ON events(type, at);
    CREATE INDEX events_session ON events(session_id, seq);
    CREATE INDEX events_agent ON events(agent_id, seq);
    CREATE INDEX events_project_at ON events(project_id, at);
    CREATE INDEX events_${o.spaces ? "space" : "workspace"}_at ON events(${ws}, at);
    CREATE INDEX events_parent ON events(parent_id);
    CREATE INDEX blobs_unreferenced ON blobs(refs) WHERE refs <= 0;
    CREATE INDEX links_to ON links(to_kind, to_id);
    INSERT INTO meta VALUES ('schema', '1'), ('blobs.recounted', '1');
  `);
  // The full-text index of that time (fts.ts version 1: no kind column).
  db.exec(`
    CREATE VIRTUAL TABLE events_fts USING fts5(text, body, content='', contentless_delete=1, detail=full, tokenize='unicode61 remove_diacritics 2');
    CREATE VIRTUAL TABLE events_vocab USING fts5vocab(events_fts, 'row');
  `);
  return db;
}

/** A row in a schema-1 log, with its words in the full-text index. */
export function insertV1(db: DatabaseSync, r: { seq: number; id: string; at: number; type: string; text?: string; session?: string; space?: string; blob?: string }, spaces = false): void {
  db.prepare(`INSERT INTO events (seq, id, at, type, v, source, recorded, ${spaces ? "space_id" : "workspace_id"}, session_id, text, data, blob) VALUES (?, ?, ?, ?, 1, 'test', 'v1', ?, ?, ?, jsonb('{}'), ?)`).run(r.seq, r.id, r.at, r.type, r.space ?? null, r.session ?? null, r.text ?? null, r.blob ?? null);
  if (r.text) db.prepare(`INSERT INTO events_fts (rowid, text, body) VALUES (?, ?, '')`).run(r.seq, r.text);
}
