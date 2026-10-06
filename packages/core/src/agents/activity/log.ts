// The activity log: every event received about an agent, kept raw in SQLite, and
// the turns derived from them. Events are normalised when read (normalize.ts), so
// a better adapter improves history too. Bounded: old events are pruned.
//
// Every row says who wrote it in which formats (schema, cmd's version, the hook's
// record format, the agent's version), so data from different cmd and agent
// versions can be told apart. The tables only grow: a newer cmd adds the columns
// it needs to an older database (COLUMNS), and records the schema version it
// left in schema_versions.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { ACTIVITY_SCHEMA, type ActivityEvent, type ActivityKind, type AgentCoverage, type AgentId, type AgentKind, type AgentTurn, type PaneId } from "@cmd/protocol";
import { capPayload, normalize, type RawEvent } from "./normalize.ts";
import { decodeDoc, decodeRows, decodeTurn } from "../../stored.ts";
import { redactDeep } from "../../redact.ts";

/** Events and turns older than this are dropped. */
const KEEP_MS = 14 * 86400_000;

interface Row {
  id: number;
  at: number;
  pane_id: string | null;
  agent_id: string | null;
  agent: string | null;
  source: string;
  name: string;
  doc: string;
  env: string | null;
  schema: number | null;
  cmd: string | null;
  hook: number | null;
  agent_version: string | null;
}

/** Columns added after a table was first created: added to older databases as they're opened. */
const COLUMNS: Record<string, [string, string][]> = {
  agent_events: [
    ["schema", "INTEGER"],
    ["cmd", "TEXT"],
    ["hook", "INTEGER"],
    ["agent_version", "TEXT"],
    ["session_id", "TEXT"],
  ],
  agent_turns: [["last_event", "INTEGER NOT NULL DEFAULT 0"]],
};

export interface ActivityLogOptions {
  /** The cmd that records: its version, or "source+<build>". */
  recordedBy?: string | null;
}

export class ActivityLog {
  #db: DatabaseSync;
  #stmts = new Map<string, StatementSync>();

  readonly recordedBy: string | null;

  /** `db`: the core's database (Store.db); in memory without one. */
  constructor(db: DatabaseSync | null = null, o: ActivityLogOptions = {}) {
    this.#db = db ?? new DatabaseSync(":memory:");
    this.recordedBy = o.recordedBy ?? null;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at REAL NOT NULL,
        pane_id TEXT,
        agent_id TEXT,
        agent TEXT,
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        doc TEXT NOT NULL,
        env TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_events_agent ON agent_events(agent_id, id);
      CREATE INDEX IF NOT EXISTS agent_events_pane ON agent_events(pane_id, id);
      CREATE INDEX IF NOT EXISTS agent_events_at ON agent_events(at);
      CREATE TABLE IF NOT EXISTS agent_turns (
        agent_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        started_at REAL NOT NULL,
        last_event INTEGER NOT NULL DEFAULT 0,
        doc TEXT NOT NULL,
        PRIMARY KEY (agent_id, idx)
      );
      CREATE INDEX IF NOT EXISTS agent_turns_started ON agent_turns(started_at);
      CREATE TABLE IF NOT EXISTS schema_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    `);
    for (const [table, cols] of Object.entries(COLUMNS)) {
      const have = new Set((this.#db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      for (const [name, type] of cols) if (!have.has(name)) this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
    this.#db.exec(`CREATE INDEX IF NOT EXISTS agent_events_session ON agent_events(session_id)`);
    const v = this.#db.prepare(`SELECT version FROM schema_versions WHERE name = 'activity'`).get() as { version: number } | undefined;
    if (!v || v.version < ACTIVITY_SCHEMA) this.#db.prepare(`INSERT OR REPLACE INTO schema_versions (name, version, updated_at) VALUES ('activity', ?, ?)`).run(ACTIVITY_SCHEMA, Date.now());
  }

  /** The schema version of the database (a newer cmd may have written it). */
  schemaVersion(): number {
    return (this.#db.prepare(`SELECT version FROM schema_versions WHERE name = 'activity'`).get() as { version: number }).version;
  }

  #stmt(sql: string): StatementSync {
    let st = this.#stmts.get(sql);
    if (!st) this.#stmts.set(sql, (st = this.#db.prepare(sql)));
    return st;
  }

  /** Stores an event an agent's hook reported; returns it normalised. `agentVersion`: of the agent it's from, when known. */
  insert(r: RawEvent, paneId: PaneId | null, agentId: AgentId | null, agentVersion: string | null = null): ActivityEvent {
    // Raw as the agent sent it, minus credentials: a pasted key or a `curl -H "Authorization: …"` is never kept.
    const doc = JSON.stringify(redactDeep(capPayload(r.payload)));
    const env = r.env && Object.keys(r.env).length ? JSON.stringify(r.env) : null;
    const sessionId = typeof r.payload.session_id === "string" ? r.payload.session_id : null;
    const { lastInsertRowid } = this.#stmt(
      `INSERT INTO agent_events (at, pane_id, agent_id, agent, source, name, doc, env, schema, cmd, hook, agent_version, session_id) VALUES (?, ?, ?, ?, 'hook', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.at, paneId, agentId, r.agent, r.name, doc, env, ACTIVITY_SCHEMA, this.recordedBy, r.hook ?? null, agentVersion, sessionId);
    return { ...normalize({ ...r, payload: JSON.parse(doc) as Record<string, unknown> }, Number(lastInsertRowid)), paneId, agentId, ...(agentVersion ? { agentVersion } : {}), recorded: { schema: ACTIVITY_SCHEMA, cmd: this.recordedBy, hook: r.hook ?? null } };
  }

  /** Stores something the core inferred or noticed (interrupt, anomaly). */
  note(kind: "interrupt" | "anomaly", text: string, at: number, paneId: PaneId | null, agentId: AgentId | null, agent: AgentKind | null): ActivityEvent {
    const { lastInsertRowid } = this.#stmt(`INSERT INTO agent_events (at, pane_id, agent_id, agent, source, name, doc, schema, cmd) VALUES (?, ?, ?, ?, 'core', ?, ?, ?, ?)`).run(at, paneId, agentId, agent, kind, JSON.stringify({ text }), ACTIVITY_SCHEMA, this.recordedBy);
    return { id: Number(lastInsertRowid), at, agentId, paneId, agent, source: "core", name: kind, kind, text, recorded: { schema: ACTIVITY_SCHEMA, cmd: this.recordedBy, hook: null } };
  }

  /** Gives a pane's unclaimed events since `notBefore` to the agent now running there; returns them. */
  claim(paneId: PaneId, agentId: AgentId, notBefore: number, agentVersion: string | null = null): ActivityEvent[] {
    this.#stmt(`UPDATE agent_events SET agent_id = ?, agent_version = COALESCE(agent_version, ?) WHERE pane_id = ? AND agent_id IS NULL AND at >= ?`).run(agentId, agentVersion, paneId, notBefore);
    return this.events({ agentId });
  }

  /** Oldest first: the newest `limit`, or with `oldest` the first `limit` (paging with afterId). */
  events(q: { agentId?: AgentId; paneId?: PaneId; afterId?: number; since?: number; limit?: number; raw?: boolean; oldest?: boolean }): ActivityEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    // Full ids, or prefixes (the CLI's short ids for agents that are gone).
    const id = (col: string, v: string) => (v.length >= 36 ? (where.push(`${col} = ?`), args.push(v)) : (where.push(`substr(${col}, 1, ?) = ?`), args.push(v.length, v)));
    if (q.agentId) id("agent_id", q.agentId);
    if (q.paneId) id("pane_id", q.paneId);
    if (q.afterId) where.push("id > ?"), args.push(q.afterId);
    if (q.since) where.push("at >= ?"), args.push(q.since);
    const limit = q.limit ?? 5000;
    const cond = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = q.oldest ? `SELECT * FROM agent_events ${cond} ORDER BY id LIMIT ?` : `SELECT * FROM (SELECT * FROM agent_events ${cond} ORDER BY id DESC LIMIT ?) ORDER BY id`;
    const rows = this.#db.prepare(sql).all(...args, limit) as unknown as Row[];
    return rows.map((row) => toEvent(row, !!q.raw));
  }

  /** `lastEvent`: the newest event reduced into it (a restarted core replays only later ones). */
  saveTurn(t: AgentTurn, lastEvent?: number): void {
    this.#stmt(
      `INSERT INTO agent_turns (agent_id, idx, started_at, last_event, doc) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, idx) DO UPDATE SET doc = excluded.doc, last_event = MAX(last_event, excluded.last_event)`,
    ).run(t.agentId, t.index, t.startedAt, lastEvent ?? 0, JSON.stringify(t));
  }

  lastTurn(agentId: AgentId): { turn: AgentTurn; lastEvent: number } | null {
    const r = this.#stmt(`SELECT doc, last_event FROM agent_turns WHERE agent_id = ? ORDER BY idx DESC LIMIT 1`).get(agentId) as { doc: string; last_event: number } | undefined;
    const t = r && decodeDoc("turn", r.doc, decodeTurn);
    return r && t ? { turn: t, lastEvent: r.last_event } : null;
  }

  turns(agentId: AgentId, limit = 50): AgentTurn[] {
    const rows = this.#stmt(`SELECT doc FROM (SELECT doc, idx FROM agent_turns WHERE agent_id = ? ORDER BY idx DESC LIMIT ?) ORDER BY idx`).all(agentId, limit) as { doc: string }[];
    return decodeRows("turn", rows.map((r) => r.doc), decodeTurn);
  }

  /** Every agent's turns that started since `since`, oldest first (exports). */
  turnsSince(since: number, limit = 100_000): AgentTurn[] {
    const rows = this.#stmt(`SELECT doc FROM agent_turns WHERE started_at >= ? ORDER BY started_at LIMIT ?`).all(since, limit) as { doc: string }[];
    return decodeRows("turn", rows.map((r) => r.doc), decodeTurn);
  }

  /** What each agent's events carried over the last `days`: kinds, fields present, unmapped names. */
  coverage(days = 7): AgentCoverage[] {
    const rows = this.#stmt(`SELECT * FROM agent_events WHERE at >= ? ORDER BY id`).all(Date.now() - days * 86400_000) as unknown as Row[];
    const by = new Map<string, { c: AgentCoverage; sessions: Set<string>; has: Map<string, [number, number]>; unmapped: Set<string> }>();
    for (const row of rows) {
      const ev = toEvent(row, false);
      const agent = ev.agent ?? "unknown";
      let a = by.get(agent);
      if (!a) by.set(agent, (a = { c: { agent, events: 0, sessions: 0, kinds: {}, fields: {}, unmapped: [], anomalies: 0, lastAt: null }, sessions: new Set(), has: new Map(), unmapped: new Set() }));
      a.c.events++;
      a.c.kinds[ev.kind] = (a.c.kinds[ev.kind] ?? 0) + 1;
      a.c.lastAt = Math.max(a.c.lastAt ?? 0, ev.at);
      if (ev.sessionId) a.sessions.add(ev.sessionId);
      if (ev.kind === "anomaly") a.c.anomalies++;
      if (ev.kind === "other" && ev.source === "hook") a.unmapped.add(ev.name);
      for (const [field, present] of fieldsOf(ev)) {
        const key = `${ev.kind}.${field}`;
        const [n, yes] = a.has.get(key) ?? [0, 0];
        a.has.set(key, [n + 1, yes + (present ? 1 : 0)]);
      }
    }
    return [...by.values()].map(({ c, sessions, has, unmapped }) => ({
      ...c,
      sessions: sessions.size,
      fields: Object.fromEntries([...has].map(([k, [n, yes]]) => [k, Math.round((yes / n) * 100) / 100])),
      unmapped: [...unmapped],
    }));
  }

  prune(now = Date.now()): void {
    this.#stmt(`DELETE FROM agent_events WHERE at < ?`).run(now - KEEP_MS);
    this.#stmt(`DELETE FROM agent_turns WHERE started_at < ?`).run(now - KEEP_MS);
  }
}

function toEvent(row: Row, raw: boolean): ActivityEvent {
  const doc = JSON.parse(row.doc) as Record<string, unknown>;
  // Rows from before these columns existed (development builds): schema 1, unknown cmd.
  const recorded = { schema: row.schema ?? 1, cmd: row.cmd ?? null, hook: row.hook ?? null };
  if (row.source === "core") {
    const kind = row.name as ActivityKind;
    return { id: row.id, at: row.at, agentId: row.agent_id, paneId: row.pane_id, agent: row.agent, source: "core", name: row.name, kind, text: String(doc.text ?? ""), recorded };
  }
  const env = row.env ? (JSON.parse(row.env) as Record<string, string>) : undefined;
  const ev = normalize({ at: row.at, agent: row.agent, name: row.name, payload: doc, env }, row.id);
  ev.agentId = row.agent_id;
  ev.paneId = row.pane_id;
  if (row.agent_version) ev.agentVersion = row.agent_version;
  ev.recorded = recorded;
  if (raw) ev.raw = doc;
  return ev;
}

/** The fields worth knowing an agent sends, per kind: [name, present]. */
function fieldsOf(ev: ActivityEvent): [string, boolean][] {
  const common: [string, boolean][] = [["sessionId", !!ev.sessionId], ["cwd", !!ev.cwd]];
  switch (ev.kind) {
    case "session.start":
      return [...common, ["transcriptPath", !!ev.transcriptPath], ["home", !!ev.home]];
    case "prompt":
      return [...common, ["text", !!ev.text], ["turnId", !!ev.turnId]];
    case "tool.start":
      return [...common, ["tool", !!ev.tool], ["tool.id", !!ev.tool?.id], ["tool.label", !!ev.tool?.label]];
    case "tool.end":
      return [...common, ["tool", !!ev.tool], ["tool.id", !!ev.tool?.id], ["tool.durationMs", ev.tool?.durationMs !== undefined]];
    case "ask":
      return [...common, ["text", !!ev.text], ["tool", !!ev.tool]];
    case "stop":
    case "fail":
      return [...common, ["text", !!ev.text]];
    default:
      return common;
  }
}
