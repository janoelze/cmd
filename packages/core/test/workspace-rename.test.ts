// Before 0.24 workspaces were Spaces: databases written then open with the new
// names (the state's table and documents, the log's column, types, entities and
// links, the journal's scopes).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.ts";
import { DataStore } from "../src/data/store.ts";
import { eventsV1 } from "./events-v1.ts";
import { JournalStore } from "../src/journal/store.ts";
import { rmTemp } from "./tmp.ts";

let dir: string;
beforeEach(() => void (dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-rename-")))));
afterEach(() => rmTemp(dir));

describe("databases from before workspaces", () => {
  it("state: the spaces table and spaceId in windows, panes and agents", () => {
    const file = path.join(dir, "cmd.sqlite");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE spaces (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, doc TEXT NOT NULL);
      CREATE TABLE windows (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE panes (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE agents (id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL, doc TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO spaces VALUES ('s1', '/src/shop', '{"id":"s1","root":"/src/shop"}');
      INSERT INTO windows VALUES ('w1', '{"id":"w1","spaceId":"s1"}');
      INSERT INTO panes VALUES ('p1', '{"id":"p1","spaceId":"s1"}');
      INSERT INTO agents VALUES ('a1', NULL, 'a1', '{"id":"a1","spaceId":"s1"}', 0);
    `);
    old.close();
    new Store(file).close();
    const db = new DatabaseSync(file);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain("workspaces");
    expect(tables).not.toContain("spaces");
    expect(db.prepare(`SELECT root FROM workspaces`).get()).toEqual({ root: "/src/shop" });
    for (const t of ["windows", "panes", "agents"]) expect(JSON.parse((db.prepare(`SELECT doc FROM ${t}`).get() as { doc: string }).doc)).toMatchObject({ workspaceId: "s1" });
    db.close();
  });

  it("the log: space_id, space.open and the space entity and links", () => {
    const file = path.join(dir, "events.sqlite");
    const old = eventsV1(file, { spaces: true });
    old.exec(`
      INSERT INTO events (id, at, type, v, source, recorded, space_id, data) VALUES ('space:s1:open:1', 1000, 'space.open', 1, 'user', 'test', 's1', jsonb('{"name":"shop","root":"/src/shop"}'));
      INSERT INTO entities VALUES ('space', 's1', 0, 0, jsonb('{}'));
      INSERT INTO links VALUES ('pane', 'p1', 'space', 's1', 'in', 0, NULL);
    `);
    old.close();
    const s = new DataStore(file);
    expect(s.query({ types: ["workspace.open"] })).toMatchObject([{ type: "workspace.open", workspaceId: "s1" }]);
    expect(s.query({ workspaceId: "s1" }).length).toBe(1);
    expect(s.linksOf("pane", "p1")).toMatchObject([{ to: ["workspace", "s1"] }]);
    s.close();
    // A second open finds nothing left to do.
    new DataStore(file).close();
  });

  it("the journal: space:<id> scopes and spaceId in its days", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE journal_days (scope TEXT NOT NULL, date INTEGER NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (scope, date));
      INSERT INTO journal_days VALUES ('space:s1', 1, '{"threads":[{"spaceId":"s1"}]}'), ('all', 1, '{"threads":[{"spaceId":null}]}');
    `);
    new JournalStore(db);
    expect(db.prepare(`SELECT scope, doc FROM journal_days ORDER BY scope`).all()).toEqual([
      { scope: "all", doc: '{"threads":[{"workspaceId":null}]}' },
      { scope: "workspace:s1", doc: '{"threads":[{"workspaceId":"s1"}]}' },
    ]);
  });
});
