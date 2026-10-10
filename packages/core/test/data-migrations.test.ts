// The event log's migrations (data/migrations.ts) and payload upcasters (data/upcast.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVENT_V } from "@cmd/protocol";
import { DataStore } from "../src/data/store.ts";
import { EVENTS_SCHEMA } from "../src/data/schema.ts";
import { EventsLogTooNew, MIGRATIONS, migrate, prepareEventsLog, schemaOf } from "../src/data/migrations.ts";
import { UPCASTERS, upcast } from "../src/data/upcast.ts";
import { ftsSql } from "../src/data/fts.ts";
import { eventsV1, insertV1 } from "./events-v1.ts";
import { rmTemp } from "./tmp.ts";

let dir: string;
beforeEach(() => void (dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-migrate-")))));
afterEach(() => rmTemp(dir));

/** Tables and indexes as created (whitespace aside), for comparing two files; the full-text tables are search's. */
const shape = (db: DatabaseSync) =>
  (db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'events_fts%' AND name NOT LIKE 'events_vocab%' ORDER BY type, name`).all() as { type: string; name: string; tbl_name: string; sql: string | null }[]).map((r) => ({ ...r, sql: r.sql?.replace("IF NOT EXISTS ", "").replace('"events"', "events").replace(/\s+/g, "") ?? null }));

describe("event log migrations", () => {
  it("brings a schema-1 log to the newest schema, copied aside first", () => {
    const file = path.join(dir, "events.sqlite");
    const old = eventsV1(file);
    insertV1(old, { seq: 1, id: "a", at: 1000, type: "command", text: "ls" });
    insertV1(old, { seq: 2, id: "b", at: 2000, type: "transcript.message", text: "flaky test", session: "claude:s1" });
    old.close();

    const s = new DataStore(file);
    expect(s.meta("schema")).toBe(String(EVENTS_SCHEMA));
    expect(schemaOf(s.db)).toBe(EVENTS_SCHEMA);
    // Rows keep their seqs, and the full-text index (rowid = seq) still finds them.
    expect(s.query({}).map((e) => [e.seq, e.id])).toEqual([[1, "a"], [2, "b"]]);
    expect(s.query({ text: "flaky" }).map((e) => e.id)).toEqual(["b"]);
    s.close();

    // The copy is the file as it was.
    const bak = new DatabaseSync(`${file}.bak-v1`, { readOnly: true });
    expect(schemaOf(bak)).toBe(1);
    expect(bak.prepare(`SELECT COUNT(*) AS n FROM events`).get()).toEqual({ n: 2 });
    bak.close();
  });

  it("ends up as a new log would: same tables and indexes", () => {
    const fresh = new DataStore(path.join(dir, "fresh.sqlite"));
    const file = path.join(dir, "old.sqlite");
    const old = eventsV1(file, { spaces: true });
    insertV1(old, { seq: 1, id: "a", at: 1, type: "command" }, true);
    old.close();
    const migrated = new DataStore(file);
    expect(shape(migrated.db)).toEqual(shape(fresh.db));
    fresh.close();
    migrated.close();
  });

  it("moves workspaces from before 0.24 and drops transcript lines stored at 0", () => {
    const file = path.join(dir, "events.sqlite");
    const old = eventsV1(file, { spaces: true });
    old.exec(`INSERT INTO blobs VALUES ('h', 1, 1, 'raw', 0, 2, x'00')`);
    insertV1(old, { seq: 1, id: "space:s1:open:1", at: 1000, type: "space.open", space: "s1" }, true);
    insertV1(old, { seq: 2, id: "t0", at: 0, type: "transcript.message", text: "no time", blob: "h" }, true);
    insertV1(old, { seq: 3, id: "t1", at: 5, type: "transcript.message", text: "a time", blob: "h" }, true);
    old.exec(`INSERT INTO entities VALUES ('space', 's1', 0, 0, jsonb('{}')); INSERT INTO links VALUES ('pane', 'p1', 'space', 's1', 'in', 0, NULL);`);
    // A rebuild of the full-text index that a stop cut short: it goes on from its cursor after the migration.
    old.exec(`${ftsSql("events_fts_next")} INSERT INTO events_fts_next (rowid, text, body, kind) VALUES (2, 'no time', '', 'other'), (3, 'a time', '', 'other'); INSERT INTO meta VALUES ('fts.cursor', '3');`);
    old.close();
    const s = new DataStore(file);
    expect(s.query({ types: ["workspace.open"] })).toMatchObject([{ workspaceId: "s1" }]);
    expect(s.linksOf("pane", "p1")).toMatchObject([{ to: ["workspace", "s1"] }]);
    expect(s.query({ types: ["transcript."] }).map((e) => e.id)).toEqual(["t1"]);
    expect(s.query({ text: "time" }).map((e) => e.id)).toEqual(["t1"]);
    expect(s.db.prepare(`SELECT rowid FROM events_fts_next WHERE events_fts_next MATCH 'time'`).all().map((r) => r.rowid)).toEqual([3]);
    expect(s.db.prepare(`SELECT refs FROM blobs WHERE hash = 'h'`).get()).toEqual({ refs: 1 });
    s.close();
  });

  it("refuses a log from a newer cmd, writing nothing to it", () => {
    const file = path.join(dir, "events.sqlite");
    new DataStore(file).close();
    const db = new DatabaseSync(file);
    db.exec(`UPDATE meta SET value = '${EVENTS_SCHEMA + 1}' WHERE key = 'schema'; PRAGMA wal_checkpoint(TRUNCATE)`);
    db.close();
    const before = fs.readFileSync(file);
    expect(() => new DataStore(file)).toThrow(EventsLogTooNew);
    expect(() => prepareEventsLog(file)).toThrow(/newer cmd/);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.existsSync(`${file}.bak-v${EVENTS_SCHEMA + 1}`)).toBe(false);
  });

  it("runs every step or none: a failing step leaves the file as it was", () => {
    const file = path.join(dir, "events.sqlite");
    const old = eventsV1(file, { spaces: true });
    insertV1(old, { seq: 1, id: "a", at: 1, type: "command" }, true);
    const steps = [...MIGRATIONS, { to: EVENTS_SCHEMA + 1, label: "broken", run: () => void old.exec(`SELECT nope FROM nowhere`) }];
    expect(() => migrate(old, file, steps, EVENTS_SCHEMA + 1)).toThrow(/nowhere/);
    expect(schemaOf(old)).toBe(1);
    expect(old.prepare(`SELECT 1 FROM pragma_table_info('events') WHERE name = 'space_id'`).get()).toBeTruthy();
    old.close();
  });

  it("numbers its steps one after another, up to EVENTS_SCHEMA", () => {
    expect(MIGRATIONS.map((m) => m.to)).toEqual(Array.from({ length: EVENTS_SCHEMA - 1 }, (_, i) => i + 2));
  });

  it("leaves a new or current log alone", () => {
    const file = path.join(dir, "events.sqlite");
    new DataStore(file).close();
    const db = new DatabaseSync(file);
    expect(migrate(db, file)).toBeNull();
    db.close();
    expect(fs.existsSync(`${file}.bak-v1`)).toBe(false);
  });
});

describe("payload upcasters", () => {
  it("every type above version 1 has a step for each version before it", () => {
    for (const [type, v] of Object.entries(EVENT_V)) if (v > 1) expect(UPCASTERS[type as keyof typeof UPCASTERS]?.length ?? 0, type).toBe(v - 1);
  });

  it("brings a stored payload up to the current version, a step at a time", () => {
    const table = { thing: [(d: unknown) => ({ ...(d as object), b: 1 }), (d: unknown) => ({ ...(d as object), c: 2 })] };
    expect(upcast("thing", 1, { a: 0 }, table, { thing: 3 })).toEqual({ v: 3, data: { a: 0, b: 1, c: 2 } });
    expect(upcast("thing", 2, { a: 0 }, table, { thing: 3 })).toEqual({ v: 3, data: { a: 0, c: 2 } });
    expect(upcast("thing", 3, { a: 0 }, table, { thing: 3 })).toEqual({ v: 3, data: { a: 0 } });
  });
});
