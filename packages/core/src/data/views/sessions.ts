// Sessions as a view over transcript events (docs/28 §3): one row per agent
// session with what the Navigator, the palette, resume and the journal need
// (agent, file, env, folder, branch, title, first prompt, span). Fed as events
// arrive; rebuilt from the log when its rules change or the views file is gone.

import type { AgentKind, DataEvent, SessionInfo } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import type { DataService } from "../service.ts";
import type { ViewsStore } from "./views.ts";

const log = logger("sessions");

// 2: message counts were doubled for transcripts read twice (archived copies).
const VERSION = 2;
const SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    key TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    agent TEXT NOT NULL,
    path TEXT,
    env TEXT,
    cwd TEXT,
    branch TEXT,
    title TEXT,
    first_prompt TEXT,
    started REAL,
    updated REAL,
    messages INTEGER NOT NULL DEFAULT 0,
    project_id TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated);
  CREATE INDEX IF NOT EXISTS sessions_id ON sessions(id);
`;

/** A session as the view knows it (the shape the journal and search read). */
export interface SessionRow {
  key: string;
  id: string;
  agent: string;
  path: string | null;
  env: string | null;
  cwd: string | null;
  branch: string | null;
  title: string | null;
  first_prompt: string | null;
  started: number | null;
  updated: number | null;
  messages: number;
  project_id: string | null;
}

export class SessionsView {
  #views: ViewsStore;
  #data: DataService;

  constructor(views: ViewsStore, data: DataService) {
    this.#views = views;
    this.#data = data;
    const { rebuilt } = views.ensure("sessions", VERSION, ["sessions"], SQL);
    if (rebuilt && data.store.count({ types: ["transcript."], limit: 1 }) > 0) void this.rebuild();
  }

  /** Folds transcript events into their sessions. `file`: the file they came from (path, resume env). */
  /** `file.mtime`: when events carry no time of their own (some agents' lines), the file's stands in. */
  apply(events: DataEvent[], file?: { path: string; env: Record<string, string> | null; mtime?: number }): void {
    const upsert = this.#views.stmt(`INSERT INTO sessions (key, id, agent, path, env, started, updated, messages) VALUES (?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(key) DO UPDATE SET path = COALESCE(excluded.path, path), env = COALESCE(excluded.env, env), started = MIN(COALESCE(started, excluded.started), COALESCE(excluded.started, started)), updated = MAX(COALESCE(updated, excluded.updated), COALESCE(excluded.updated, updated))`);
    const set = (col: string) => this.#views.stmt(`UPDATE sessions SET ${col} = ? WHERE key = ? AND ${col} IS NULL`);
    const title = this.#views.stmt(`UPDATE sessions SET title = ? WHERE key = ?`);
    const bump = this.#views.stmt(`UPDATE sessions SET messages = messages + 1 WHERE key = ?`);
    const touched = new Set<string>();
    this.#views.transaction(() => {
      for (const e of events) {
        if (!e.sessionId || !e.type.startsWith("transcript.")) continue;
        const i = e.sessionId.indexOf(":");
        const agent = e.sessionId.slice(0, i) as AgentKind;
        const id = e.sessionId.slice(i + 1);
        const at = e.at > 0 ? e.at : (file?.mtime ?? null);
        const until = e.until && e.until > 0 ? e.until : at;
        upsert.run(e.sessionId, id, agent, file?.path ?? null, file?.env ? JSON.stringify(file.env) : null, at, until);
        touched.add(e.sessionId);
        const d = e.data as Record<string, unknown>;
        if (typeof d.cwd === "string") set("cwd").run(d.cwd, e.sessionId);
        if (typeof d.gitBranch === "string") set("branch").run(d.gitBranch, e.sessionId);
        if (e.projectId) set("project_id").run(e.projectId, e.sessionId);
        if (e.type === "transcript.title" && e.text) title.run(e.text, e.sessionId);
        else if (e.type === "transcript.summary" && e.text) set("title").run(e.text, e.sessionId);
        else if (e.type === "transcript.message") {
          bump.run(e.sessionId);
          if (d.role === "user" && e.text && !d.isSidechain && !d.isMeta) set("first_prompt").run(e.text, e.sessionId);
        }
      }
    });
    if (!this.#rebuilding && this.#listeners.length && touched.size) {
      const rows = [...touched].map((k) => this.get(k)).filter((r): r is SessionRow => !!r && r.started !== null).map(sessionInfo);
      for (const fn of this.#listeners) fn(rows);
    }
  }

  /** Called with the sessions an apply changed (not during a rebuild), for live queries. */
  onChange(fn: (rows: SessionInfo[]) => void): void {
    this.#listeners.push(fn);
  }
  #listeners: ((rows: SessionInfo[]) => void)[] = [];
  #rebuilding = false;

  /** Sessions matching a view query, newest activity first. */
  list(q: { sessionId?: string; projectId?: string; since?: number; limit?: number }): SessionInfo[] {
    const where: string[] = ["started IS NOT NULL"];
    const args: (string | number)[] = [];
    if (q.sessionId) where.push("key = ?"), args.push(q.sessionId);
    if (q.projectId) where.push("project_id = ?"), args.push(q.projectId);
    if (q.since) where.push("updated >= ?"), args.push(q.since);
    const rows = this.#views.db.prepare(`SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY updated DESC LIMIT ?`).all(...args, Math.min(q.limit ?? 50, 1000)) as unknown as SessionRow[];
    return rows.map(sessionInfo);
  }

  /**
   * The view from every transcript event in the log, in order: a page at a time
   * with the core answering in between, each event's few fields the view takes
   * (not its payload: hundreds of thousands of messages). Calls while one runs
   * get that one.
   */
  /** The transcript a session id was read from, and its resume env (set by the reader, TranscriptIngest). */
  fileOf: ((sessionId: string) => { path: string; env: Record<string, string> | null } | null) | null = null;

  rebuild(): Promise<number> {
    this.#running ??= this.#rebuild().finally(() => (this.#running = null));
    return this.#running;
  }
  #running: Promise<number> | null = null;

  async #rebuild(): Promise<number> {
    const t0 = Date.now();
    // Which file a session came from and how to resume it aren't in the log: kept across.
    const files = this.#views.db.prepare(`SELECT key, path, env FROM sessions WHERE path IS NOT NULL OR env IS NOT NULL`).all() as { key: string; path: string | null; env: string | null }[];
    this.#views.db.exec(`DELETE FROM sessions`);
    this.#rebuilding = true;
    const page = this.#data.store.db.prepare(
      `SELECT seq, type, at, until, session_id AS sessionId, project_id AS projectId, text, json_extract(data, '$.cwd') AS cwd, json_extract(data, '$.gitBranch') AS gitBranch, json_extract(data, '$.role') AS role, json_extract(data, '$.isSidechain') AS isSidechain, json_extract(data, '$.isMeta') AS isMeta
       FROM events WHERE type >= 'transcript.' AND type < 'transcript/' AND seq > ? ORDER BY seq LIMIT ?`,
    );
    let after = 0;
    let n = 0;
    try {
      for (;;) {
        const rows = page.all(after, 5000) as { seq: number; type: string; at: number; until: number | null; sessionId: string | null; projectId: string | null; text: string | null; cwd: unknown; gitBranch: unknown; role: unknown; isSidechain: unknown; isMeta: unknown }[];
        if (!rows.length) break;
        this.apply(rows.map((r) => ({ ...r, data: { cwd: r.cwd, gitBranch: r.gitBranch, role: r.role, isSidechain: !!r.isSidechain, isMeta: !!r.isMeta } }) as unknown as DataEvent));
        n += rows.length;
        after = rows.at(-1)!.seq;
        await new Promise((r) => setImmediate(r));
      }
      const keep = this.#views.stmt(`UPDATE sessions SET path = ?, env = ? WHERE key = ?`);
      this.#views.transaction(() => {
        for (const f of files) keep.run(f.path, f.env, f.key);
      });
      // Sessions without them (the view was dropped): from the reader's files.
      if (this.fileOf) {
        const missing = this.#views.db.prepare(`SELECT key, id FROM sessions WHERE path IS NULL`).all() as { key: string; id: string }[];
        for (let i = 0; i < missing.length; i += 200) {
          this.#views.transaction(() => {
            for (const m of missing.slice(i, i + 200)) {
              const f = this.fileOf!(m.id);
              if (f) keep.run(f.path, f.env ? JSON.stringify(f.env) : null, m.key);
            }
          });
          await new Promise((r) => setImmediate(r));
        }
      }
    } finally {
      this.#rebuilding = false;
    }
    log.info("sessions rebuilt from events", { events: n, sessions: this.counts().sessions, ms: Date.now() - t0 });
    return n;
  }

  get(key: string): SessionRow | null {
    return (this.#views.stmt(`SELECT * FROM sessions WHERE key = ?`).get(key) as SessionRow | undefined) ?? null;
  }

  /** By the agent's own id (several agents could share one; the newest wins). */
  byId(id: string): SessionRow | null {
    return (this.#views.stmt(`SELECT * FROM sessions WHERE id = ? ORDER BY updated DESC LIMIT 1`).get(id) as SessionRow | undefined) ?? null;
  }

  /** Sessions active since `since` (updated then or later), oldest first: for the journal. */
  sessionsSince(since: number): SessionRow[] {
    return this.#views.stmt(`SELECT * FROM sessions WHERE updated >= ? AND started IS NOT NULL ORDER BY started`).all(since) as unknown as SessionRow[];
  }

  /** The most recently active, newest first; `offset` pages further back. */
  recent(limit: number, offset = 0): SessionRow[] {
    return this.#views.stmt(`SELECT * FROM sessions WHERE started IS NOT NULL ORDER BY updated DESC LIMIT ? OFFSET ?`).all(limit, offset) as unknown as SessionRow[];
  }

  counts(): { sessions: number } {
    return { sessions: (this.#views.stmt(`SELECT COUNT(*) AS n FROM sessions WHERE started IS NOT NULL`).get() as { n: number }).n };
  }
}

/** A view row as protocol's SessionInfo. */
export function sessionInfo(r: SessionRow): SessionInfo {
  return { key: r.key, id: r.id, agent: r.agent, path: r.path, cwd: r.cwd, branch: r.branch, title: r.title, firstPrompt: r.first_prompt, started: r.started, updated: r.updated, messages: r.messages, projectId: r.project_id };
}
