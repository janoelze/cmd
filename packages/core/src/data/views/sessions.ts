// Sessions as a view over transcript events (docs/28 §3): one row per agent
// session with what the Navigator, the palette, resume and the journal need
// (agent, file, env, folder, branch, title, first prompt, span). Fed as events
// arrive; rebuilt from the log when its rules change or the views file is gone.

import type { AgentKind, DataEvent, SessionInfo } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { inlinePacer, type Pacer } from "../../scheduler.ts";
import type { DataService } from "../service.ts";
import type { ViewsStore } from "./views.ts";

const log = logger("sessions");

// 2: message counts were doubled for transcripts read twice (archived copies).
// 3: names (session.name events, docs/32).
const VERSION = 3;
/**
 * A rebuild steps through the log by seq in spans this wide (a rowid range: no
 * sort, no index scan per step) and folds each span's events per session before
 * writing, so a step is a few ms however many events it holds.
 */
const SPAN = 5000;
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
    project_id TEXT,
    name TEXT,
    name_by TEXT,
    named_at REAL
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
  name: string | null;
  name_by: string | null;
  named_at: number | null;
}

/** A transcript event's fields a rebuild reads (sessions.ts's span query). */
interface FoldRow {
  seq: number;
  type: string;
  at: number;
  until: number | null;
  sessionId: string | null;
  projectId: string | null;
  text: string | null;
  cwd: unknown;
  gitBranch: unknown;
  role: unknown;
  isSidechain: unknown;
  isMeta: unknown;
}

/** One session's part of a rebuild step, before its upsert. */
interface Fold {
  key: string;
  id: string;
  agent: string;
  started: number | null;
  updated: number | null;
  cwd: string | null;
  branch: string | null;
  projectId: string | null;
  title: string | null;
  /** A title line was seen: it overwrites the stored title (a summary only fills an empty one). */
  titleSet: boolean;
  firstPrompt: string | null;
  messages: number;
}

export class SessionsView {
  #views: ViewsStore;
  #data: DataService;

  /** The view's rules changed (or it is new): rebuild() is due. With `deferRebuild` the owner runs it (Core.start). */
  readonly needsRebuild: boolean;
  /** Between steps of a rebuild (the scheduler; by default the next tick). */
  #pace: Pacer;

  constructor(views: ViewsStore, data: DataService, o: { deferRebuild?: boolean; pace?: Pacer } = {}) {
    this.#views = views;
    this.#data = data;
    this.#pace = o.pace ?? inlinePacer;
    const { rebuilt } = views.ensure("sessions", VERSION, ["sessions"], SQL);
    this.needsRebuild = rebuilt && !!o.deferRebuild;
    if (rebuilt && !o.deferRebuild && data.store.count({ types: ["transcript."], limit: 1 }) > 0) void this.rebuild();
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

  /**
   * apply() for a rebuild's step: the same rules, folded per session first (a
   * span of thousands of events touches a few dozen sessions), then one upsert
   * per session. Order within a session: a title line overwrites the title, a
   * summary fills an empty one, the first user message is the first prompt,
   * the first cwd, branch and project stick (COALESCE at the upsert).
   */
  #applyFolded(rows: FoldRow[]): void {
    const folds = new Map<string, Fold>();
    for (const r of rows) {
      if (!r.sessionId) continue;
      const i = r.sessionId.indexOf(":");
      let f = folds.get(r.sessionId);
      if (!f) folds.set(r.sessionId, (f = { key: r.sessionId, id: r.sessionId.slice(i + 1), agent: r.sessionId.slice(0, i), started: null, updated: null, cwd: null, branch: null, projectId: null, title: null, titleSet: false, firstPrompt: null, messages: 0 }));
      const at = r.at > 0 ? r.at : null;
      const until = r.until && r.until > 0 ? r.until : at;
      if (at !== null) f.started = f.started === null ? at : Math.min(f.started, at);
      if (until !== null) f.updated = f.updated === null ? until : Math.max(f.updated, until);
      if (typeof r.cwd === "string") f.cwd ??= r.cwd;
      if (typeof r.gitBranch === "string") f.branch ??= r.gitBranch;
      if (r.projectId) f.projectId ??= r.projectId;
      if (r.type === "transcript.title" && r.text) (f.title = r.text), (f.titleSet = true);
      else if (r.type === "transcript.summary" && r.text) f.title ??= r.text;
      else if (r.type === "transcript.message") {
        f.messages++;
        if (r.role === "user" && r.text && !r.isSidechain && !r.isMeta) f.firstPrompt ??= r.text;
      }
    }
    const upsert = (title: "set" | "fill") =>
      this.#views.stmt(
        `INSERT INTO sessions (key, id, agent, started, updated, cwd, branch, project_id, title, first_prompt, messages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           started = MIN(COALESCE(started, excluded.started), COALESCE(excluded.started, started)),
           updated = MAX(COALESCE(updated, excluded.updated), COALESCE(excluded.updated, updated)),
           cwd = COALESCE(cwd, excluded.cwd), branch = COALESCE(branch, excluded.branch), project_id = COALESCE(project_id, excluded.project_id),
           title = ${title === "set" ? "excluded.title" : "COALESCE(title, excluded.title)"},
           first_prompt = COALESCE(first_prompt, excluded.first_prompt), messages = messages + excluded.messages`,
      );
    this.#views.transaction(() => {
      for (const f of folds.values()) upsert(f.titleSet ? "set" : "fill").run(f.key, f.id, f.agent, f.started, f.updated, f.cwd, f.branch, f.projectId, f.title, f.firstPrompt, f.messages);
    });
  }

  /** A session's name from a session.name event (the newest wins); the row may come before its transcript. */
  applyName(key: string, name: string | null, by: string, at: number): void {
    const i = key.indexOf(":");
    if (i < 0) return;
    this.#views.stmt(`INSERT INTO sessions (key, id, agent, messages) VALUES (?, ?, ?, 0) ON CONFLICT(key) DO NOTHING`).run(key, key.slice(i + 1), key.slice(0, i));
    this.#views.stmt(`UPDATE sessions SET name = ?, name_by = ?, named_at = ? WHERE key = ? AND (named_at IS NULL OR named_at <= ?)`).run(name, name ? by : null, at, key, at);
    const row = this.get(key);
    if (!this.#rebuilding && row?.started != null) for (const fn of this.#listeners) fn([sessionInfo(row)]);
  }

  /** Called with the sessions an apply changed (not during a rebuild), for live queries. */
  onChange(fn: (rows: SessionInfo[]) => void): void {
    this.#listeners.push(fn);
  }
  #listeners: ((rows: SessionInfo[]) => void)[] = [];
  /** Called after a rebuild: every row may have changed or gone. */
  onReset(fn: () => void): void {
    this.#resetListeners.push(fn);
  }
  #resetListeners: (() => void)[] = [];
  #rebuilding = false;

  /** Sessions matching a view query, newest activity first. */
  /** `keep`: a filter SQL can't do (a Space by folder); pages back until full, a few thousand rows at most. */
  list(q: { sessionId?: string; projectId?: string; since?: number; limit?: number }, keep?: (row: SessionRow) => boolean): SessionInfo[] {
    const where: string[] = ["started IS NOT NULL"];
    const args: (string | number)[] = [];
    if (q.sessionId) where.push("key = ?"), args.push(q.sessionId);
    if (q.projectId) where.push("project_id = ?"), args.push(q.projectId);
    if (q.since) where.push("updated >= ?"), args.push(q.since);
    const limit = Math.min(q.limit ?? 50, 1000);
    const stmt = this.#views.stmt(`SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY updated DESC LIMIT ? OFFSET ?`);
    if (!keep) return (stmt.all(...args, limit, 0) as unknown as SessionRow[]).map(sessionInfo);
    const out: SessionInfo[] = [];
    const page = Math.max(limit * 4, 200);
    for (let offset = 0; offset < 5000; offset += page) {
      const rows = stmt.all(...args, page, offset) as unknown as SessionRow[];
      for (const r of rows) if (keep(r) && out.push(sessionInfo(r)) === limit) return out;
      if (rows.length < page) break;
    }
    return out;
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
    const done = this.#pace.mark("sessions rebuild");
    const span = this.#data.store.db.prepare(
      `SELECT seq, type, at, until, session_id AS sessionId, project_id AS projectId, text, json_extract(data, '$.cwd') AS cwd, json_extract(data, '$.gitBranch') AS gitBranch, json_extract(data, '$.role') AS role, json_extract(data, '$.isSidechain') AS isSidechain, json_extract(data, '$.isMeta') AS isMeta
       FROM events WHERE seq > ? AND seq <= ? AND type >= 'transcript.' AND type < 'transcript/' ORDER BY seq`,
    );
    const last = (this.#data.store.db.prepare(`SELECT MAX(seq) AS m FROM events`).get() as { m: number | null }).m ?? 0;
    let n = 0;
    try {
      for (let after = 0; after < last; after += SPAN) {
        const rows = span.all(after, after + SPAN) as unknown as FoldRow[];
        if (!rows.length) continue;
        this.#applyFolded(rows);
        n += rows.length;
        await this.#pace.yield();
      }
      // Names, in the order they were given.
      for (let after = 0; ; ) {
        const rows = this.#data.store.db.prepare(`SELECT seq, at, session_id AS key, json_extract(data, '$.name') AS name, json_extract(data, '$.by') AS by FROM events WHERE type = 'session.name' AND session_id IS NOT NULL AND seq > ? ORDER BY seq LIMIT 5000`).all(after) as { seq: number; at: number; key: string; name: string | null; by: string }[];
        if (!rows.length) break;
        this.#views.transaction(() => {
          for (const r of rows) this.applyName(r.key, r.name, r.by, r.at);
        });
        after = rows.at(-1)!.seq;
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
          await this.#pace.yield();
        }
      }
    } finally {
      done();
      this.#rebuilding = false;
    }
    log.info("sessions rebuilt from events", { events: n, sessions: this.counts().sessions, ms: Date.now() - t0 });
    for (const fn of this.#resetListeners) fn();
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

  counts(): { sessions: number } {
    return { sessions: (this.#views.stmt(`SELECT COUNT(*) AS n FROM sessions WHERE started IS NOT NULL`).get() as { n: number }).n };
  }
}

/** A view row as protocol's SessionInfo. */
export function sessionInfo(r: SessionRow): SessionInfo {
  return { key: r.key, id: r.id, agent: r.agent, path: r.path, env: r.env ? (JSON.parse(r.env) as Record<string, string>) : null, cwd: r.cwd, branch: r.branch, title: r.title, firstPrompt: r.first_prompt, started: r.started, updated: r.updated, messages: r.messages, projectId: r.project_id, name: r.name ?? null };
}
