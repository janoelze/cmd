// Sessions as a view over transcript events (docs/28 §3): one row per agent
// session with what the Navigator, the palette, resume and the journal need
// (agent, file, env, folder, branch, title, first prompt, span). Fed as events
// arrive; rebuilt from the log when its rules change or the views file is gone.

import type { AgentKind, DataEvent } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import type { DataService } from "../service.ts";
import type { ViewsStore } from "./views.ts";

const log = logger("sessions");

const VERSION = 1;
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
    if (rebuilt && data.store.count({ types: ["transcript."], limit: 1 }) > 0) this.rebuild();
  }

  /** Folds transcript events into their sessions. `file`: the file they came from (path, resume env). */
  /** `file.mtime`: when events carry no time of their own (some agents' lines), the file's stands in. */
  apply(events: DataEvent[], file?: { path: string; env: Record<string, string> | null; mtime?: number }): void {
    const upsert = this.#views.stmt(`INSERT INTO sessions (key, id, agent, path, env, started, updated, messages) VALUES (?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(key) DO UPDATE SET path = COALESCE(excluded.path, path), env = COALESCE(excluded.env, env), started = MIN(COALESCE(started, excluded.started), COALESCE(excluded.started, started)), updated = MAX(COALESCE(updated, excluded.updated), COALESCE(excluded.updated, updated))`);
    const set = (col: string) => this.#views.stmt(`UPDATE sessions SET ${col} = ? WHERE key = ? AND ${col} IS NULL`);
    const title = this.#views.stmt(`UPDATE sessions SET title = ? WHERE key = ?`);
    const bump = this.#views.stmt(`UPDATE sessions SET messages = messages + 1 WHERE key = ?`);
    this.#views.transaction(() => {
      for (const e of events) {
        if (!e.sessionId || !e.type.startsWith("transcript.")) continue;
        const i = e.sessionId.indexOf(":");
        const agent = e.sessionId.slice(0, i) as AgentKind;
        const id = e.sessionId.slice(i + 1);
        const at = e.at > 0 ? e.at : (file?.mtime ?? null);
        const until = e.until && e.until > 0 ? e.until : at;
        upsert.run(e.sessionId, id, agent, file?.path ?? null, file?.env ? JSON.stringify(file.env) : null, at, until);
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
  }

  /** The view from every transcript event in the log, in order. */
  rebuild(): number {
    const t0 = Date.now();
    this.#views.db.exec(`DELETE FROM sessions`);
    let after = 0;
    let n = 0;
    for (;;) {
      const page = this.#data.store.query({ types: ["transcript."], after, limit: 5000 });
      if (!page.length) break;
      this.apply(page);
      n += page.length;
      after = page.at(-1)!.seq;
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

  /** The most recently active, newest first. */
  recent(limit: number): SessionRow[] {
    return this.#views.stmt(`SELECT * FROM sessions WHERE started IS NOT NULL ORDER BY updated DESC LIMIT ?`).all(limit) as unknown as SessionRow[];
  }

  counts(): { sessions: number } {
    return { sessions: (this.#views.stmt(`SELECT COUNT(*) AS n FROM sessions WHERE started IS NOT NULL`).get() as { n: number }).n };
  }
}
