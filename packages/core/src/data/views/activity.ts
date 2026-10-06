// Agent activity over the event log (docs/18, docs/28 §3): hook events are
// `agent.hook` events, the core's inferences `agent.note`; turns are a view in
// views.sqlite, derived by the reducer as events arrive and rebuilt by replaying
// them when TURN_FORMAT changes. The API is the one the tracker, the journal,
// summaries and `cmd agents` used on the old activity log (ActivityLog, now
// gone), with the row id replaced by the event's seq.

import { ACTIVITY_SCHEMA, TURN_FORMAT, type ActivityEvent, type ActivityKind, type AgentCoverage, type AgentId, type AgentKind, type AgentTurn, type DataEvent, type PaneId } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { capPayload, normalize, type RawEvent } from "../../agents/activity/normalize.ts";
import { ActivityReducer } from "../../agents/activity/reduce.ts";
import { decodeDoc, decodeRows, decodeTurn } from "../../stored.ts";
import type { DataService } from "../service.ts";
import type { ViewsStore } from "./views.ts";
import { projectIdOf } from "../project.ts";

const log = logger("activity");

const TYPES = ["agent.hook", "agent.note"];
const TURNS_SQL = `
  CREATE TABLE IF NOT EXISTS turns (
    agent_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    started_at REAL NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    cwd TEXT,
    doc TEXT NOT NULL,
    PRIMARY KEY (agent_id, idx)
  );
  CREATE INDEX IF NOT EXISTS turns_started ON turns(started_at);
`;

interface HookData {
  name: string;
  agent: AgentKind | null;
  env?: Record<string, string>;
  hook?: number | null;
  agentVersion?: string | null;
  payload: Record<string, unknown>;
}

export interface EventsQuery {
  agentId?: AgentId;
  paneId?: PaneId;
  afterId?: number;
  since?: number;
  limit?: number;
  raw?: boolean;
  oldest?: boolean;
}

export class ActivityView {
  #data: DataService;
  #views: ViewsStore;
  #n = 0;
  readonly recordedBy: string | null;

  constructor(data: DataService, views: ViewsStore) {
    this.#data = data;
    this.#views = views;
    this.recordedBy = data.recordedBy;
    const { rebuilt } = views.ensure("turns", TURN_FORMAT, ["turns"], TURNS_SQL);
    if (rebuilt && this.#data.store.count({ types: TYPES, limit: 1 }) > 0) this.rebuild();
    data.onPrune((before) => this.prune(before));
  }

  schemaVersion(): number {
    return ACTIVITY_SCHEMA;
  }

  /** The Space a pane is in, for agent events (set by the core; tests leave it). */
  spaceOf: (paneId: PaneId) => string | null = () => null;

  /**
   * Stores an event an agent's hook reported; returns it normalised. The row
   * keeps the payload with long strings cut (normalising needs the shape, not a
   * file's contents); a payload that was cut is kept whole as the event's
   * content, within the agents class's cap.
   */
  insert(r: RawEvent, paneId: PaneId | null, agentId: AgentId | null, agentVersion: string | null = null): ActivityEvent {
    const sessionId = typeof r.payload.session_id === "string" ? r.payload.session_id : null;
    const full = JSON.stringify(r.payload);
    const payload = capPayload(r.payload) as Record<string, unknown>;
    const cut = JSON.stringify(payload).length < full.length;
    const data: HookData = { name: r.name, agent: r.agent, env: r.env, hook: r.hook ?? null, agentVersion, payload };
    const text = typeof r.payload.prompt === "string" ? line1(r.payload.prompt) : typeof r.payload.tool_name === "string" ? r.payload.tool_name : typeof r.payload.last_assistant_message === "string" ? line1(r.payload.last_assistant_message) : r.name;
    const body = typeof r.payload.prompt === "string" ? r.payload.prompt : typeof r.payload.last_assistant_message === "string" ? r.payload.last_assistant_message : null;
    const toolId = typeof r.payload.tool_use_id === "string" ? r.payload.tool_use_id : null;
    const ev = this.#data.record({
      id: `hook:${paneId ?? "-"}:${Math.round(r.at * 1000)}:${r.name}:${this.#n++}`,
      at: r.at,
      type: "agent.hook",
      source: `hook:${r.agent ?? "?"}${agentVersion ? `@${agentVersion}` : ""}`,
      parentId: toolId && r.name !== "PreToolUse" && paneId ? this.#startOf(paneId, toolId) : null,
      sessionId: sessionId ? `${r.agent ?? "agent"}:${sessionId}` : null,
      agentId,
      paneId,
      spaceId: paneId ? this.spaceOf(paneId) : null,
      projectId: projectIdOf(typeof r.payload.cwd === "string" ? r.payload.cwd : null),
      text,
      body,
      data,
      content: cut ? full : null,
    });
    if (!ev) throw new Error("agent events are always recorded");
    return toActivity(ev, false);
  }

  /** The PreToolUse event of a tool call in a pane, for PostToolUse's parent. */
  #startOf(paneId: PaneId, toolId: string): string | null {
    const row = this.#data.store.db.prepare(`SELECT id FROM events WHERE pane_id = ? AND type = 'agent.hook' AND json_extract(data, '$.payload.tool_use_id') = ? AND json_extract(data, '$.name') = 'PreToolUse' ORDER BY seq DESC LIMIT 1`).get(paneId, toolId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Stores something the core inferred or noticed (interrupt, anomaly). */
  note(kind: "interrupt" | "anomaly", text: string, at: number, paneId: PaneId | null, agentId: AgentId | null, agent: AgentKind | null): ActivityEvent {
    const ev = this.#data.record({ id: `note:${paneId ?? "-"}:${Math.round(at * 1000)}:${kind}:${this.#n++}`, at, type: "agent.note", source: `cmd:${this.recordedBy ?? "?"}`, agentId, paneId, spaceId: paneId ? this.spaceOf(paneId) : null, text, data: { name: kind, agent, text } });
    if (!ev) throw new Error("agent notes are always recorded");
    return toActivity(ev, false);
  }

  /** Gives a pane's unclaimed events since `notBefore` to the agent now running there; returns them. */
  claim(paneId: PaneId, agentId: AgentId, notBefore: number, agentVersion: string | null = null): ActivityEvent[] {
    this.#data.store.db
      .prepare(`UPDATE events SET agent_id = ?, data = CASE WHEN ? IS NOT NULL AND json_extract(data, '$.agentVersion') IS NULL THEN jsonb_set(data, '$.agentVersion', ?) ELSE data END WHERE pane_id = ? AND agent_id IS NULL AND at >= ? AND (type = 'agent.hook' OR type = 'agent.note')`)
      .run(agentId, agentVersion, agentVersion, paneId, notBefore);
    return this.events({ agentId });
  }

  /** Oldest first: the newest `limit`, or with `oldest` the first `limit` (paging with afterId). */
  events(q: EventsQuery): ActivityEvent[] {
    const agentId = q.agentId ? this.#full("agent_id", q.agentId) : undefined;
    const paneId = q.paneId ? this.#full("pane_id", q.paneId) : undefined;
    if ((q.agentId && !agentId) || (q.paneId && !paneId)) return [];
    const limit = q.limit ?? 5000;
    const rows = this.#data.store.query({ types: TYPES, agentId, paneId, after: q.afterId, at: q.since ? [q.since, Number.MAX_SAFE_INTEGER] : undefined, order: q.oldest ? "asc" : "desc", limit });
    if (!q.oldest) rows.reverse();
    return rows.map((e) => toActivity(e, !!q.raw));
  }

  /** Full ids, or prefixes (the CLI's short ids for agents that are gone). */
  #full(col: "agent_id" | "pane_id", v: string): string | undefined {
    if (v.length >= 36) return v;
    const row = this.#data.store.db.prepare(`SELECT ${col} AS id FROM events WHERE ${col} >= ? AND ${col} < ? ORDER BY seq DESC LIMIT 1`).get(v, `${v}￿`) as { id: string } | undefined;
    return row?.id;
  }

  /** `lastSeq`: the newest event reduced into it (a restarted core replays only later ones). `cwd`: where the agent ran. */
  saveTurn(t: AgentTurn, lastSeq?: number, cwd?: string | null): void {
    this.#views
      .stmt(
        `INSERT INTO turns (agent_id, idx, started_at, last_seq, cwd, doc) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, idx) DO UPDATE SET doc = excluded.doc, last_seq = MAX(last_seq, excluded.last_seq), cwd = COALESCE(excluded.cwd, cwd)`,
      )
      .run(t.agentId, t.index, t.startedAt, lastSeq ?? 0, cwd ?? null, JSON.stringify(t));
  }

  lastTurn(agentId: AgentId): { turn: AgentTurn; lastEvent: number } | null {
    const r = this.#views.stmt(`SELECT doc, last_seq FROM turns WHERE agent_id = ? ORDER BY idx DESC LIMIT 1`).get(agentId) as { doc: string; last_seq: number } | undefined;
    const t = r && decodeDoc("turn", r.doc, decodeTurn);
    return r && t ? { turn: t, lastEvent: r.last_seq } : null;
  }

  turns(agentId: AgentId, limit = 50): AgentTurn[] {
    const full = this.#full("agent_id", agentId) ?? agentId;
    const rows = this.#views.stmt(`SELECT doc FROM (SELECT doc, idx FROM turns WHERE agent_id = ? ORDER BY idx DESC LIMIT ?) ORDER BY idx`).all(full, limit) as { doc: string }[];
    return decodeRows("turn", rows.map((r) => r.doc), decodeTurn);
  }

  /** Every agent's turns that started since `since`, oldest first, with where the agent ran (the journal, exports). */
  turnsSince(since: number, limit = 100_000): { turn: AgentTurn; cwd: string | null }[] {
    const rows = this.#views.stmt(`SELECT doc, cwd FROM turns WHERE started_at >= ? ORDER BY started_at LIMIT ?`).all(since, limit) as { doc: string; cwd: string | null }[];
    const out: { turn: AgentTurn; cwd: string | null }[] = [];
    for (const r of rows) {
      const turn = decodeDoc("turn", r.doc, decodeTurn);
      if (turn) out.push({ turn, cwd: r.cwd });
    }
    return out;
  }

  /** Turns from the events again, every agent's, with the current rules (TURN_FORMAT changed, or asked to). */
  rebuild(): { agents: number; turns: number } {
    const t0 = Date.now();
    const agents = this.#data.store.db.prepare(`SELECT DISTINCT agent_id FROM events WHERE type = 'agent.hook' AND agent_id IS NOT NULL`).all() as { agent_id: string }[];
    let turns = 0;
    this.#views.transaction(() => {
      this.#views.db.exec(`DELETE FROM turns`);
      for (const { agent_id } of agents) {
        const events = this.events({ agentId: agent_id, oldest: true, limit: 1_000_000 });
        const kind = events.find((e) => e.agent)?.agent ?? "unknown";
        const version = events.find((e) => e.agentVersion)?.agentVersion ?? null;
        const cwd = events.find((e) => e.cwd)?.cwd ?? null;
        const red = new ActivityReducer(agent_id, 0, { agentKind: kind, agentVersion: version, derivedBy: this.recordedBy });
        for (const ev of events) {
          const r = red.apply(ev);
          // Every turn the event touched, by (agent, idx): a closed one and the one it opened may both be in `r`.
          if (r.closed) this.saveTurn(r.closed, ev.id, cwd);
          if (r.turn && r.turn !== r.closed) this.saveTurn(r.turn, ev.id, cwd);
        }
      }
      turns = (this.#views.db.prepare(`SELECT COUNT(*) AS n FROM turns`).get() as { n: number }).n;
    });
    log.info("turns rebuilt from events", { agents: agents.length, turns, ms: Date.now() - t0 });
    return { agents: agents.length, turns };
  }

  /** What each agent's events carried over the last `days`: kinds, fields present, unmapped names. */
  coverage(days = 7): AgentCoverage[] {
    const rows = this.events({ since: Date.now() - days * 86400_000, oldest: true, limit: 1_000_000 });
    const by = new Map<string, { c: AgentCoverage; sessions: Set<string>; has: Map<string, [number, number]>; unmapped: Set<string> }>();
    for (const ev of rows) {
      const agent = ev.agent ?? "unknown";
      let a = by.get(agent);
      if (!a) by.set(agent, (a = { c: { agent: agent as AgentKind, events: 0, sessions: 0, kinds: {}, fields: {}, unmapped: [], anomalies: 0, lastAt: null }, sessions: new Set(), has: new Map(), unmapped: new Set() }));
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

  /** Turns older than `before` go with their events (the data layer's retention). */
  prune(before: number): void {
    this.#views.stmt(`DELETE FROM turns WHERE started_at < ?`).run(before);
  }
}

const line1 = (s: string) => (s.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 300);

/** A stored event as the ActivityEvent the rest of the core knows. */
export function toActivity(e: DataEvent, raw: boolean): ActivityEvent {
  if (e.type === "agent.note") {
    const d = e.data as { name: ActivityKind; agent: AgentKind | null; text: string };
    return { id: e.seq, at: e.at, agentId: e.agentId, paneId: e.paneId, agent: d.agent, source: "core", name: d.name, kind: d.name, text: d.text, recorded: { schema: ACTIVITY_SCHEMA, cmd: e.recorded, hook: null } };
  }
  const d = e.data as HookData;
  const ev = normalize({ at: e.at, agent: d.agent, name: d.name, payload: d.payload ?? {}, env: d.env, hook: d.hook ?? undefined }, e.seq);
  ev.agentId = e.agentId;
  ev.paneId = e.paneId;
  if (d.agentVersion) ev.agentVersion = d.agentVersion;
  ev.recorded = { schema: ACTIVITY_SCHEMA, cmd: e.recorded, hook: d.hook ?? null };
  if (raw) ev.raw = d.payload;
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
