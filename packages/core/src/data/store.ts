// The facts store (docs/28 §2): records events idempotently by id, offloads big
// content to zstd blobs, keeps entities and links, answers the query shape of
// protocol/events.ts and says how big everything is. Policy (what to record,
// redaction, caps, retention) lives in service.ts; this file only stores.

import { createHash } from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { DataEvent, DataEventType, DataQuery, DataStats, NewDataEvent } from "@cmd/protocol";
import { DATA_FLAGS, EVENT_V } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { EVENTS_SCHEMA, FTS_SQL, SCHEMA_SQL } from "./schema.ts";

const log = logger("data");

/** A recorder's event plus what the store adds on the way in. */
export type StoreEvent = NewDataEvent & { v?: number; flags?: number };

export interface StoreOptions {
  /** The cmd that records (events.recorded). */
  recordedBy?: string;
  /** Blobs are compressed (zstd) when that saves at least a tenth. */
  compress?: boolean;
  /** `body` text indexed per event is cut here. */
  bodyCap?: number;
}

const DEFAULTS: Required<StoreOptions> = { recordedBy: "source", compress: true, bodyCap: 20_000 };

export class DataStore {
  readonly db: DatabaseSync;
  readonly file: string;
  #o: Required<StoreOptions>;
  #stmts = new Map<string, StatementSync>();

  constructor(file: string, o: StoreOptions = {}) {
    this.file = file;
    this.#o = { ...DEFAULTS, ...o };
    this.db = new DatabaseSync(file, { timeout: 5000 });
    this.db.exec(SCHEMA_SQL);
    this.db.exec(FTS_SQL);
    if (!this.meta("schema")) {
      this.setMeta("schema", String(EVENTS_SCHEMA));
      this.setMeta("blobs.recounted", "1"); // counted right from the start
    }
  }

  /**
   * Once per log: blob counts written before record() handled rewritten rows
   * right (some too high, some 0 while still in use) are counted again. Reads
   * the whole log (seconds on a big one), so it runs with retention, not at startup.
   */
  recountBlobs(): boolean {
    if (this.meta("blobs.recounted")) return false;
    this.transaction(() => {
      this.db.exec(`UPDATE blobs SET refs = 0; UPDATE blobs SET refs = x.n FROM (SELECT blob, COUNT(*) AS n FROM events WHERE blob IS NOT NULL GROUP BY blob) AS x WHERE blobs.hash = x.blob`);
      this.setMeta("blobs.recounted", "1");
    });
    return true;
  }

  close(): void {
    this.db.close();
  }

  #stmt(sql: string): StatementSync {
    let st = this.#stmts.get(sql);
    if (!st) this.#stmts.set(sql, (st = this.db.prepare(sql)));
    return st;
  }

  meta(key: string): string | null {
    return (this.#stmt(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#stmt(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(key, value);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Adds an event, or updates the one with its id: the span grows (`at` the
   * earliest, `until` the latest), `text`, `data` and the blob are the newest,
   * identities fill in what was null, `seq` stays. Returns the row's seq and
   * whether it was new.
   */
  record(e: StoreEvent): { seq: number; inserted: boolean } {
    const blob = e.content != null ? this.putBlob(e.content) : null;
    const data = JSON.stringify(e.data ?? null);
    const before = this.#stmt(`SELECT seq, blob FROM events WHERE id = ?`).get(e.id) as { seq: number; blob: string | null } | undefined;
    const r = this.#stmt(
      `INSERT INTO events (id, at, until, type, v, source, recorded, parent_id, space_id, project_id, session_id, agent_id, pane_id, window_id, device_id, text, data, blob, flags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, jsonb(?), ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         at = MIN(at, excluded.at),
         until = MAX(COALESCE(until, excluded.until), COALESCE(excluded.until, until)),
         text = COALESCE(excluded.text, text),
         data = excluded.data,
         blob = COALESCE(excluded.blob, blob),
         parent_id = COALESCE(parent_id, excluded.parent_id),
         space_id = COALESCE(space_id, excluded.space_id),
         project_id = COALESCE(project_id, excluded.project_id),
         session_id = COALESCE(session_id, excluded.session_id),
         agent_id = COALESCE(agent_id, excluded.agent_id),
         pane_id = COALESCE(pane_id, excluded.pane_id),
         window_id = COALESCE(window_id, excluded.window_id),
         device_id = COALESCE(device_id, excluded.device_id),
         flags = flags | excluded.flags
       RETURNING seq`,
    ).get(e.id, Math.round(e.at), e.until == null ? null : Math.round(e.until), e.type, e.v ?? EVENT_V[e.type as DataEventType] ?? 1, e.source, this.#o.recordedBy, e.parentId ?? null, e.spaceId ?? null, e.projectId ?? null, e.sessionId ?? null, e.agentId ?? null, e.paneId ?? null, e.windowId ?? null, e.deviceId ?? null, e.text ?? null, data, blob, e.flags ?? 0) as { seq: number };
    // A new blob replaces the old one (the same one: putBlob counted it twice); without one the row keeps its blob.
    if (before?.blob && blob) this.#unref(before.blob);
    if (before) this.#stmt(`DELETE FROM events_fts WHERE rowid = ?`).run(before.seq);
    if (e.text || e.body) this.#stmt(`INSERT INTO events_fts (rowid, text, body) VALUES (?, ?, ?)`).run(r.seq, e.text ?? "", (e.body ?? "").slice(0, this.#o.bodyCap));
    return { seq: r.seq, inserted: !before };
  }

  recordAll(events: Iterable<StoreEvent>): number {
    let n = 0;
    this.transaction(() => {
      for (const e of events) this.record(e), n++;
    });
    return n;
  }

  get(id: string): DataEvent | null {
    const row = this.#stmt(`SELECT *, json(data) AS data_json FROM events WHERE id = ?`).get(id) as unknown as Row | undefined;
    return row ? toEvent(row) : null;
  }

  /** Removes events (and their FTS rows, blob references); returns how many. */
  delete(where: { before?: number; types?: string[]; sessionId?: string; projectId?: string; seqs?: number[]; limit?: number }): number {
    if (where.limit) {
      // At most `limit` at a time (retention on a big log runs in batches): the oldest matching first.
      const [c, a] = conditions({ at: where.before ? [0, where.before] : undefined, types: where.types, sessionId: where.sessionId, projectId: where.projectId });
      const seqs = (this.db.prepare(`SELECT seq FROM events ${c ? `WHERE ${c}` : ""} ORDER BY seq LIMIT ?`).all(...a, where.limit) as { seq: number }[]).map((r) => r.seq);
      return seqs.length ? this.delete({ seqs }) : 0;
    }
    const [cond, args] = conditions({ at: where.before ? [0, where.before] : undefined, types: where.types, sessionId: where.sessionId, projectId: where.projectId });
    const parts = [...(cond ? [cond] : []), ...(where.seqs?.length ? [`seq IN (${where.seqs.map(() => "?").join(",")})`] : [])];
    if (!parts.length) return 0;
    const w = `WHERE ${parts.join(" AND ")}`;
    const all = [...args, ...(where.seqs ?? [])];
    return this.transaction(() => {
      for (const r of this.db.prepare(`SELECT blob FROM events ${w} AND blob IS NOT NULL`).all(...all) as { blob: string }[]) this.#unref(r.blob);
      this.db.prepare(`DELETE FROM events_fts WHERE rowid IN (SELECT seq FROM events ${w})`).run(...all);
      return Number(this.db.prepare(`DELETE FROM events ${w}`).run(...all).changes);
    });
  }

  /** Content-addressed; zstd when that saves space. Returns the hash. */
  putBlob(content: string | Buffer): string {
    const raw = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const hash = createHash("sha256").update(raw).digest("hex");
    const have = this.#stmt(`SELECT 1 FROM blobs WHERE hash = ?`).get(hash);
    if (have) {
      this.#stmt(`UPDATE blobs SET refs = refs + 1 WHERE hash = ?`).run(hash);
      return hash;
    }
    let bytes = raw;
    let enc = "raw";
    // zstd (Node ≥ 22.15): on the author's transcripts 36% of raw against deflate's 64%; level 3 is the fast default.
    if (this.#o.compress && raw.length > 256) {
      const z = zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
      if (z.length < raw.length * 0.9) (bytes = z), (enc = "zstd");
    }
    this.#stmt(`INSERT INTO blobs (hash, size, stored, enc, created, refs, bytes) VALUES (?, ?, ?, ?, ?, 1, ?)`).run(hash, raw.length, bytes.length, enc, Date.now(), bytes);
    return hash;
  }

  blob(hash: string): Buffer | null {
    const r = this.#stmt(`SELECT enc, bytes FROM blobs WHERE hash = ?`).get(hash) as { enc: string; bytes: Uint8Array } | undefined;
    if (!r) return null;
    const b = Buffer.from(r.bytes);
    return r.enc === "zstd" ? zlib.zstdDecompressSync(b) : r.enc === "deflate" ? zlib.inflateSync(b) : b;
  }

  #unref(hash: string): void {
    this.#stmt(`UPDATE blobs SET refs = refs - 1 WHERE hash = ?`).run(hash);
  }

  /** Deletes blobs nothing refers to; returns how many. */
  sweepBlobs(): number {
    if (this.recountBlobs()) log.info("blob references counted again");
    return Number(this.#stmt(`DELETE FROM blobs WHERE refs <= 0`).run().changes);
  }

  entity(kind: string, id: string, attrs: Record<string, unknown> = {}, at = Date.now()): void {
    this.#stmt(
      `INSERT INTO entities (kind, id, created, seen, attrs) VALUES (?, ?, ?, ?, jsonb(?))
       ON CONFLICT(kind, id) DO UPDATE SET seen = MAX(seen, excluded.seen), attrs = jsonb_patch(attrs, excluded.attrs)`,
    ).run(kind, id, at, at, JSON.stringify(attrs));
  }

  entities(kind: string): { id: string; created: number; seen: number; attrs: Record<string, unknown> }[] {
    return (this.#stmt(`SELECT id, created, seen, json(attrs) AS attrs FROM entities WHERE kind = ? ORDER BY seen DESC`).all(kind) as { id: string; created: number; seen: number; attrs: string }[]).map((r) => ({ ...r, attrs: JSON.parse(r.attrs) as Record<string, unknown> }));
  }

  /** One link per (from, to, kind): seen again, it keeps its first time and takes the newest end. */
  link(from: [string, string], to: [string, string], kind: string, at: number, until: number | null = null): void {
    this.#stmt(
      `INSERT INTO links (from_kind, from_id, to_kind, to_id, kind, at, until) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_kind, from_id, to_kind, to_id, kind) DO UPDATE SET at = MIN(at, excluded.at), until = COALESCE(excluded.until, until)`,
    ).run(from[0], from[1], to[0], to[1], kind, at, until);
  }

  /** One entity, or null. */
  entityOf(kind: string, id: string): { kind: string; id: string; created: number; seen: number; attrs: Record<string, unknown> } | null {
    const r = this.#stmt(`SELECT kind, id, created, seen, json(attrs) AS attrs FROM entities WHERE kind = ? AND id = ?`).get(kind, id) as { kind: string; id: string; created: number; seen: number; attrs: string } | undefined;
    return r ? { ...r, attrs: JSON.parse(r.attrs) as Record<string, unknown> } : null;
  }

  /** An entity's links, both ways. */
  linksOf(kind: string, id: string): { from: [string, string]; to: [string, string]; kind: string; at: number; until: number | null }[] {
    const rows = this.#stmt(`SELECT * FROM links WHERE (from_kind = ? AND from_id = ?) OR (to_kind = ? AND to_id = ?) ORDER BY at`).all(kind, id, kind, id) as { from_kind: string; from_id: string; to_kind: string; to_id: string; kind: string; at: number; until: number | null }[];
    return rows.map((r) => ({ from: [r.from_kind, r.from_id], to: [r.to_kind, r.to_id], kind: r.kind, at: r.at, until: r.until }));
  }

  /** Builds the full-text index over what's recorded (after an import, or when it was dropped). */
  buildFts(bodyOf?: (e: DataEvent) => string | null): void {
    this.db.exec(`DROP TABLE IF EXISTS events_vocab; DROP TABLE IF EXISTS events_fts`);
    this.db.exec(FTS_SQL);
    const ins = this.#stmt(`INSERT INTO events_fts (rowid, text, body) VALUES (?, ?, ?)`);
    this.transaction(() => {
      for (const row of this.db.prepare(`SELECT *, json(data) AS data_json FROM events ORDER BY seq`).iterate() as Iterable<Row>) {
        const e = toEvent(row);
        const body = bodyOf?.(e) ?? null;
        if (e.text || body) ins.run(e.seq, e.text ?? "", (body ?? "").slice(0, this.#o.bodyCap));
      }
    });
    this.db.exec(`INSERT INTO events_fts(events_fts) VALUES ('optimize')`);
  }

  query(q: DataQuery): DataEvent[] {
    const [cond, args] = conditions(q);
    const dir = q.order === "desc" ? "DESC" : "ASC";
    const sql = `SELECT *, json(data) AS data_json FROM events ${cond ? `WHERE ${cond}` : ""} ORDER BY ${q.by === "time" ? `at ${dir}, seq ${dir}` : `seq ${dir}`} LIMIT ?`;
    return (this.db.prepare(sql).all(...args, Math.min(q.limit ?? 1000, 100_000)) as unknown as Row[]).map(toEvent);
  }

  count(q: DataQuery): number {
    const [cond, args] = conditions(q);
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM events ${cond ? `WHERE ${cond}` : ""}`).get(...args) as { n: number }).n;
  }

  stats(): DataStats {
    return logStats(this.db, this.file);
  }

  /** Rows per type, from the type index (quick, unlike stats). */
  counts(): { type: string; rows: number }[] {
    return this.db.prepare(`SELECT type, COUNT(*) AS rows FROM events GROUP BY type`).all() as { type: string; rows: number }[];
  }

  /** Pages by table and index (dbstat), in bytes. */
  pageBytes(): Record<string, number> {
    const out: Record<string, number> = {};
    try {
      for (const r of this.db.prepare(`SELECT name, SUM(pgsize) AS b FROM dbstat GROUP BY name`).all() as { name: string; b: number }[]) out[r.name] = r.b;
    } catch {}
    return out;
  }

  checkpoint(): void {
    this.db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
  }
}

/** What a log holds, with sizes per type: reads every row (seconds on a big log; the core asks a worker, stats-worker.ts). */
export function logStats(db: DatabaseSync, file: string): DataStats {
  const types = db.prepare(`SELECT type, COUNT(*) AS rows, SUM(length(data) + COALESCE(length(text), 0) + length(id) + 80) AS bytes, SUM(CASE WHEN blob IS NOT NULL THEN 1 ELSE 0 END) AS blobs FROM events GROUP BY type ORDER BY bytes DESC`).all() as DataStats["types"];
  const blobs = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS size, COALESCE(SUM(stored), 0) AS stored FROM blobs`).get() as DataStats["blobs"];
  const events = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
  const now = Date.now();
  const day = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE at >= ?`).get(now - 86400_000) as { n: number }).n;
  const week = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE at >= ?`).get(now - 7 * 86400_000) as { n: number }).n;
  const oldest = (db.prepare(`SELECT MIN(at) AS t FROM events WHERE at > 0`).get() as { t: number | null }).t;
  let fileBytes = 0;
  try {
    if (file !== ":memory:") fileBytes = fs.statSync(file).size + (fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0);
  } catch {}
  return { file: file === ":memory:" ? null : file, fileBytes, events, blobs, types, recent: { day, week }, oldest };
}

const COL = { sessionId: "session_id", agentId: "agent_id", projectId: "project_id", spaceId: "space_id", paneId: "pane_id", windowId: "window_id", parentId: "parent_id" } as const;

/** WHERE clause and arguments for a query (without ORDER and LIMIT). */
function conditions(q: DataQuery): [string, (string | number)[]] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.types?.length) {
    const exact = q.types.filter((t) => !t.endsWith("."));
    const prefixes = q.types.filter((t) => t.endsWith("."));
    // With a type filter the (type, at) index is the narrow one: each branch carries the time range, so a
    // type looks up only its rows in range (one shared range outside the ORs walks every row of the types).
    const at = q.at ? ` AND at >= ? AND at < ?` : "";
    const range = q.at ? [q.at[0], q.at[1]] : [];
    // A range, not LIKE: LIKE is case-insensitive by default and skips the index.
    const parts = [...(exact.length ? [`(type IN (${exact.map(() => "?").join(",")})${at})`] : []), ...prefixes.map(() => `(type >= ? AND type < ?${at})`)];
    if (exact.length) args.push(...exact, ...range);
    for (const p of prefixes) args.push(p, `${p}￿`, ...range);
    where.push(`(${parts.join(" OR ")})`);
  } else if (q.at) where.push(`at >= ? AND at < ?`), args.push(q.at[0], q.at[1]);
  for (const k of ["sessionId", "agentId", "projectId", "spaceId", "paneId", "windowId", "parentId"] as const) {
    const v = q[k];
    if (v) where.push(`${COL[k]} = ?`), args.push(v);
  }
  if (q.after) where.push(`seq > ?`), args.push(q.after);
  if (q.text) where.push(`seq IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)`), args.push(q.text);
  return [where.join(" AND "), args];
}

interface Row {
  seq: number;
  id: string;
  at: number;
  until: number | null;
  type: string;
  v: number;
  source: string;
  recorded: string;
  parent_id: string | null;
  space_id: string | null;
  project_id: string | null;
  session_id: string | null;
  agent_id: string | null;
  pane_id: string | null;
  window_id: string | null;
  device_id: string | null;
  text: string | null;
  data: Uint8Array | string;
  data_json: string | null;
  blob: string | null;
  flags: number;
}

function toEvent(r: Row): DataEvent {
  // JSONB is bytes in the row; every read asks for json(data) beside it.
  let data: unknown = null;
  try {
    data = r.data_json ? JSON.parse(r.data_json) : null;
  } catch {}
  return {
    seq: r.seq,
    id: r.id,
    at: r.at,
    until: r.until,
    type: r.type as DataEventType,
    v: r.v,
    source: r.source,
    recorded: r.recorded,
    parentId: r.parent_id,
    spaceId: r.space_id,
    projectId: r.project_id,
    sessionId: r.session_id,
    agentId: r.agent_id,
    paneId: r.pane_id,
    windowId: r.window_id,
    deviceId: r.device_id,
    text: r.text,
    data: data as DataEvent["data"],
    blob: r.blob,
    flags: r.flags,
  };
}

export { DATA_FLAGS };
