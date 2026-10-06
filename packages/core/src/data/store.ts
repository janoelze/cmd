// The facts store (docs/28 §2): records events idempotently by id, offloads big
// content to blobs, keeps entities and links, answers the basic queries and
// says how big everything is. Spike: enough to import and measure; phase 1 adds
// retention, redaction rules, the typed EventTypes map and the views' cursor.

import { createHash } from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { EVENTS_SCHEMA, FLAG_CUT, FTS_SQL, SCHEMA_SQL } from "./schema.ts";

/** What a recorder hands in. `content`: big text or bytes kept as a blob, not in the row. */
export interface NewEvent {
  id: string;
  at: number;
  until?: number | null;
  type: string;
  v?: number;
  source: string;
  parentId?: string | null;
  spaceId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  paneId?: string | null;
  windowId?: string | null;
  deviceId?: string | null;
  text?: string | null;
  data: unknown;
  content?: string | Buffer | null;
  /** Words for full text beyond `text` (a prompt, a message body); capped by the store. */
  body?: string | null;
  flags?: number;
}

export interface StoredEvent {
  seq: number;
  id: string;
  at: number;
  until: number | null;
  type: string;
  v: number;
  source: string;
  recorded: string;
  parentId: string | null;
  spaceId: string | null;
  projectId: string | null;
  sessionId: string | null;
  agentId: string | null;
  paneId: string | null;
  windowId: string | null;
  deviceId: string | null;
  text: string | null;
  data: unknown;
  blob: string | null;
  flags: number;
}

export interface EventQuery {
  types?: string[];
  at?: [number, number];
  sessionId?: string;
  agentId?: string;
  projectId?: string;
  spaceId?: string;
  paneId?: string;
  parentId?: string;
  /** FTS over text and body. */
  text?: string;
  order?: "asc" | "desc";
  limit?: number;
  after?: number;
}

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
  #fts = false;

  constructor(file: string, o: StoreOptions = {}) {
    this.file = file;
    this.#o = { ...DEFAULTS, ...o };
    this.db = new DatabaseSync(file, { timeout: 5000 });
    this.db.exec(SCHEMA_SQL);
    const v = this.meta("schema");
    if (!v) this.setMeta("schema", String(EVENTS_SCHEMA));
    this.db.exec(FTS_SQL);
    this.#fts = true;
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
   * Adds an event, or updates the one with its id: `until`, `text`, `data` and
   * the blob are the newest, identities fill in what was null, `seq` and `at`
   * stay. Returns the row's seq and whether it was new.
   */
  record(e: NewEvent): { seq: number; inserted: boolean } {
    const blob = e.content != null ? this.putBlob(e.content) : null;
    const data = JSON.stringify(e.data ?? null);
    const flags = (e.flags ?? 0) | (blob && !e.content ? FLAG_CUT : 0);
    const before = this.#stmt(`SELECT seq, blob FROM events WHERE id = ?`).get(e.id) as { seq: number; blob: string | null } | undefined;
    const r = this.#stmt(
      `INSERT INTO events (id, at, until, type, v, source, recorded, parent_id, space_id, project_id, session_id, agent_id, pane_id, window_id, device_id, text, data, blob, flags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, jsonb(?), ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         until = COALESCE(excluded.until, until),
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
    ).get(e.id, Math.round(e.at), e.until == null ? null : Math.round(e.until), e.type, e.v ?? 1, e.source, this.#o.recordedBy, e.parentId ?? null, e.spaceId ?? null, e.projectId ?? null, e.sessionId ?? null, e.agentId ?? null, e.paneId ?? null, e.windowId ?? null, e.deviceId ?? null, e.text ?? null, data, blob, flags) as { seq: number };
    if (before?.blob && before.blob !== blob) this.#unref(before.blob);
    if (this.#fts) {
      if (before) this.#stmt(`DELETE FROM events_fts WHERE rowid = ?`).run(before.seq);
      if (e.text || e.body) this.#stmt(`INSERT INTO events_fts (rowid, text, body) VALUES (?, ?, ?)`).run(r.seq, e.text ?? "", (e.body ?? "").slice(0, this.#o.bodyCap));
    }
    return { seq: r.seq, inserted: !before };
  }

  recordAll(events: Iterable<NewEvent>): number {
    let n = 0;
    this.transaction(() => {
      for (const e of events) this.record(e), n++;
    });
    return n;
  }

  /** Content-addressed; deflated when that saves space. Returns the hash. */
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
    // zstd (Node ≥ 22.15): on this Mac's transcripts 36% of raw against deflate's 64%; level 3 is the fast default.
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
    return Number(this.#stmt(`DELETE FROM blobs WHERE refs <= 0`).run().changes);
  }

  entity(kind: string, id: string, attrs: Record<string, unknown> = {}, at = Date.now()): void {
    this.#stmt(
      `INSERT INTO entities (kind, id, created, seen, attrs) VALUES (?, ?, ?, ?, jsonb(?))
       ON CONFLICT(kind, id) DO UPDATE SET seen = MAX(seen, excluded.seen), attrs = jsonb_patch(attrs, excluded.attrs)`,
    ).run(kind, id, at, at, JSON.stringify(attrs));
  }

  link(from: [string, string], to: [string, string], kind: string, at: number, until: number | null = null): void {
    this.#stmt(`INSERT OR REPLACE INTO links (from_kind, from_id, to_kind, to_id, kind, at, until) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(from[0], from[1], to[0], to[1], kind, at, until);
  }

  /** Builds the full-text index over what's recorded (after an import, or when it was dropped). */
  buildFts(bodyOf?: (e: StoredEvent) => string | null): void {
    this.db.exec(`DROP TABLE IF EXISTS events_fts`);
    this.db.exec(FTS_SQL);
    this.#fts = true;
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

  query(q: EventQuery): StoredEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.types?.length) {
      const exact = q.types.filter((t) => !t.endsWith("."));
      const prefixes = q.types.filter((t) => t.endsWith("."));
      // A range, not LIKE: LIKE is case-insensitive by default and skips the index.
      const parts = [...(exact.length ? [`type IN (${exact.map(() => "?").join(",")})`] : []), ...prefixes.map(() => `(type >= ? AND type < ?)`)];
      args.push(...exact, ...prefixes.flatMap((p) => [p, `${p}￿`]));
      where.push(`(${parts.join(" OR ")})`);
    }
    // With a type filter the (type, at) index is the narrow one; `+at` keeps the planner off the wide at index (spike: 50 ms → <1 ms).
    if (q.at) where.push(q.types?.length ? `+at >= ? AND +at < ?` : `at >= ? AND at < ?`), args.push(q.at[0], q.at[1]);
    for (const k of ["sessionId", "agentId", "projectId", "spaceId", "paneId", "parentId"] as const) {
      const v = q[k];
      if (v) where.push(`${COL[k]} = ?`), args.push(v);
    }
    if (q.after) where.push(`seq > ?`), args.push(q.after);
    if (q.text) where.push(`seq IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)`), args.push(q.text);
    const sql = `SELECT *, json(data) AS data_json FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq ${q.order === "desc" ? "DESC" : "ASC"} LIMIT ?`;
    args.push(q.limit ?? 1000);
    return (this.db.prepare(sql).all(...args) as unknown as Row[]).map(toEvent);
  }

  /** Rows and bytes per type, blob totals, the file's size. */
  stats(): { types: { type: string; rows: number; bytes: number; blobs: number }[]; blobs: { count: number; size: number; stored: number }; fileBytes: number; events: number } {
    const types = this.db.prepare(`SELECT type, COUNT(*) AS rows, SUM(length(data) + COALESCE(length(text), 0) + length(id) + 80) AS bytes, SUM(CASE WHEN blob IS NOT NULL THEN 1 ELSE 0 END) AS blobs FROM events GROUP BY type ORDER BY bytes DESC`).all() as { type: string; rows: number; bytes: number; blobs: number }[];
    const blobs = this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS size, COALESCE(SUM(stored), 0) AS stored FROM blobs`).get() as { count: number; size: number; stored: number };
    const events = (this.db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
    let fileBytes = 0;
    try {
      fileBytes = fs.statSync(this.file).size + (fs.existsSync(`${this.file}-wal`) ? fs.statSync(`${this.file}-wal`).size : 0);
    } catch {}
    return { types, blobs, fileBytes, events };
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

const COL = { sessionId: "session_id", agentId: "agent_id", projectId: "project_id", spaceId: "space_id", paneId: "pane_id", parentId: "parent_id" } as const;

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

function toEvent(r: Row): StoredEvent {
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
    type: r.type,
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
    data,
    blob: r.blob,
    flags: r.flags,
  };
}
