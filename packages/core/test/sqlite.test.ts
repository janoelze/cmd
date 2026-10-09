// The SQLite window's core side (docs/36-sqlite-viewer.md): the reader (schema,
// rows, queries; read-only), the service's worker per database, and the window
// type's routing, header check and sidecar mapping.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteReader } from "../src/sqlite/worker.ts";
import { refusedStatement, stripLeading } from "../src/sqlite/statements.ts";
import { databaseOf, isSqliteFile, SqliteService } from "../src/sqlite/service.ts";
import { registerBuiltins, sqliteType, targetFor, WindowTypes } from "../src/windows/index.ts";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sqlite-")));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function makeDb(name = "shop.sqlite"): string {
  const file = path.join(dir, name);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT DEFAULT 'Berlin');
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total REAL, note BLOB);
    CREATE UNIQUE INDEX customers_name ON customers(name);
    CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100;
    CREATE TRIGGER orders_ai AFTER INSERT ON orders BEGIN UPDATE customers SET city = city WHERE id = NEW.customer_id; END;
    INSERT INTO customers (name, city) VALUES ('Ada', 'London'), ('Grace', 'Arlington'), ('Linus', NULL);
    INSERT INTO orders (customer_id, total, note) VALUES (1, 250.5, X'0102'), (2, 20, NULL), (1, 99.99, NULL);
  `);
  db.close();
  return file;
}

describe("SqliteReader", () => {
  const file = makeDb();
  const reader = new SqliteReader(file);
  afterAll(() => reader.close());

  it("describes tables, views, indexes and triggers", () => {
    const s = reader.schema();
    expect(s.tables.map((t) => t.name)).toEqual(["customers", "orders"]);
    expect(s.views.map((v) => v.name)).toEqual(["big_orders"]);
    expect(s.size).toBeGreaterThan(0);
    expect(s.pageSize).toBe(4096);
    expect(s.encoding).toBe("UTF-8");
    const customers = s.tables[0]!;
    expect(customers.rows).toBe(3);
    expect(customers.columns).toEqual([
      { name: "id", type: "INTEGER", notNull: false, pk: 1, default: null },
      { name: "name", type: "TEXT", notNull: true, pk: 0, default: null },
      { name: "city", type: "TEXT", notNull: false, pk: 0, default: "'Berlin'" },
    ]);
    expect(s.tables[1]!.foreignKeys).toEqual([{ from: "customer_id", table: "customers", to: "id" }]);
    expect(s.views[0]).toMatchObject({ kind: "view", rows: null, columns: expect.arrayContaining([expect.objectContaining({ name: "total" })]) });
    expect(s.indexes.find((i) => i.name === "customers_name")).toMatchObject({ table: "customers", unique: true, columns: ["name"] });
    expect(s.triggers).toEqual([{ name: "orders_ai", table: "orders", sql: expect.stringContaining("CREATE TRIGGER") }]);
  });

  it("pages, sorts and filters a table's rows; blobs come as their size", () => {
    const all = reader.rows({ table: "orders" });
    expect(all.columns).toEqual(["id", "customer_id", "total", "note"]);
    expect(all.rows).toEqual([
      [1, 1, 250.5, { blob: 2 }],
      [2, 2, 20, null],
      [3, 1, 99.99, null],
    ]);
    expect(all).toMatchObject({ total: 3, truncated: false });

    const sorted = reader.rows({ table: "orders", sort: { column: "total", desc: true }, limit: 2 });
    expect(sorted.rows.map((r) => r[0])).toEqual([1, 3]);
    expect(sorted).toMatchObject({ total: 3, truncated: true });
    expect(reader.rows({ table: "orders", sort: { column: "total", desc: true }, limit: 2, offset: 2 }).rows.map((r) => r[0])).toEqual([2]);

    // The filter looks in every column, as text, and takes % and _ literally.
    expect(reader.rows({ table: "customers", filter: "lon" }).rows.map((r) => r[1])).toEqual(["Ada"]);
    expect(reader.rows({ table: "customers", filter: "99" }).rows).toEqual([]);
    expect(reader.rows({ table: "orders", filter: "99" }).rows.map((r) => r[0])).toEqual([3]);
    expect(reader.rows({ table: "customers", filter: "%" })).toMatchObject({ total: 0 });
    // Views page too; a sort column it doesn't have is ignored.
    expect(reader.rows({ table: "big_orders", sort: { column: "nope", desc: false } }).rows.map((r) => r[0])).toEqual([1]);
    expect(() => reader.rows({ table: "missing" })).toThrow(/no table or view named missing/);
  });

  it("runs one read-only statement and refuses writes and a second statement", () => {
    const r = reader.query({ sql: "SELECT name, count(*) AS n FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY name ORDER BY n DESC" });
    expect(r.columns).toEqual(["name", "n"]);
    expect(r.rows).toEqual([
      ["Ada", 2],
      ["Grace", 1],
    ]);
    expect(r).toMatchObject({ total: null, truncated: false });
    expect(reader.query({ sql: "SELECT id FROM orders", limit: 2 })).toMatchObject({ rows: [[1], [2]], truncated: true });
    expect(() => reader.query({ sql: "DELETE FROM orders" })).toThrow(/readonly/);
    expect(() => reader.query({ sql: "SELECT 1; SELECT 2" })).toThrow(/one statement at a time/);
    expect(() => reader.query({ sql: "SELEC 1" })).toThrow(/syntax error/);
    expect(() => reader.query({ sql: "  " })).toThrow(/Type a statement/);
    expect(reader.query({ sql: "SELECT 1;" }).rows).toEqual([[1]]);
    expect(reader.rows({ table: "orders" }).total).toBe(3);
  });

  it("refuses ATTACH, DETACH and VACUUM in any case and behind comments, so no other file is read", () => {
    const secret = path.join(dir, "secret.db");
    const db = new DatabaseSync(secret);
    db.exec("CREATE TABLE s (v TEXT); INSERT INTO s VALUES ('TOPSECRET')");
    db.close();
    for (const sql of [
      `ATTACH '${secret}' AS x`,
      `attach database '${secret}' as x`,
      `-- a comment\n  /* and another */ AtTaCh '${secret}' AS x;`,
      `;; ATTACH '${secret}' AS x`,
      `EXPLAIN ATTACH '${secret}' AS x`,
      "DETACH x",
      `VACUUM INTO '${path.join(dir, "copy.db")}'`,
      "vacuum",
    ]) {
      expect(() => reader.query({ sql }), sql).toThrow(/isn't allowed: this window reads only the database it opened/);
      expect(() => reader.query({ sql: "SELECT * FROM x.s" }), sql).toThrow(/no such table: x.s/);
    }
    expect(fs.existsSync(path.join(dir, "copy.db"))).toBe(false);
    expect(reader.query({ sql: "SELECT * FROM pragma_database_list" }).rows.map((r) => r[1])).toEqual(["main"]);
    expect(reader.query({ sql: "/* still fine */ SELECT count(*) FROM orders" }).rows).toEqual([[3]]);
    expect(stripLeading(" -- x\n /* y */ ;\n SELECT 1")).toBe("SELECT 1");
    expect(refusedStatement("SELECT 'ATTACH'")).toBeNull();
    expect(refusedStatement("SELECT * FROM attachments")).toBeNull();
    expect(refusedStatement("/* unterminated ATTACH")).toBeNull();
  });

  it("exports a table as CSV: a header, NULL empty, blobs as hex, quotes where needed", () => {
    const out = path.join(dir, "orders.csv");
    expect(reader.export("orders", out)).toEqual({ rows: 3, bytes: fs.statSync(out).size });
    expect(fs.readFileSync(out, "utf8")).toBe("id,customer_id,total,note\n1,1,250.5,0102\n2,2,20,\n3,1,99.99,\n");
    expect(reader.export("big_orders", out).rows).toBe(1);
    const quoted = path.join(dir, "q.csv");
    reader.export("customers", quoted);
    expect(fs.readFileSync(quoted, "utf8").split("\n")[1]).toBe("1,Ada,London");
  });

  it("cuts long text for transport, keeping its length", () => {
    const long = reader.query({ sql: `SELECT replace(hex(zeroblob(6000)), '0', 'x') AS t` });
    expect(long.rows[0]![0]).toEqual({ text: "x".repeat(10_000), chars: 12_000 });
  });
});

describe("SqliteService", () => {
  it("kills a reader stuck in a runaway query, and the next request gets a fresh one", async () => {
    const file = makeDb("runaway.sqlite");
    const svc = new SqliteService({ timeoutMs: 700 });
    try {
      const t0 = Date.now();
      await expect(svc.query({ path: file, sql: "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT count(*) FROM r" })).rejects.toThrow(/took too long/);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(svc.open()).toEqual([]);
      expect((await svc.query({ path: file, sql: "SELECT count(*) FROM customers" })).rows).toEqual([[3]]);
    } finally {
      svc.close();
    }
  });

  it("says why a file that looks like a database can't be opened", async () => {
    const bad = path.join(dir, "corrupt.sqlite");
    fs.writeFileSync(bad, Buffer.concat([Buffer.from("SQLite format 3\0", "latin1"), Buffer.alloc(4000, 7)]));
    const svc = new SqliteService();
    try {
      await expect(svc.schema(bad)).rejects.toThrow(/not a database|corrupt|malformed/i);
    } finally {
      svc.close();
    }
  });

  it("answers through a reader process, refuses what isn't a database, and stops idle readers", async () => {
    const file = makeDb("svc.sqlite");
    const svc = new SqliteService();
    try {
      const s = await svc.schema(file);
      expect(s.tables.map((t) => t.name)).toEqual(["customers", "orders"]);
      expect((await svc.rows({ path: file, table: "customers", limit: 1 })).rows).toEqual([[1, "Ada", "London"]]);
      expect((await svc.query({ path: file, sql: "SELECT count(*) FROM orders" })).rows).toEqual([[3]]);
      // The reader process keeps its connection: an alias must not outlive a refused ATTACH.
      await expect(svc.query({ path: file, sql: `ATTACH '${makeDb("other.sqlite")}' AS x` })).rejects.toThrow(/ATTACH isn't allowed/);
      await expect(svc.query({ path: file, sql: "SELECT * FROM x.customers" })).rejects.toThrow(/no such table/);
      expect(await svc.export(file, "customers", path.join(dir, "~svc.csv"))).toMatchObject({ rows: 3 });
      expect(svc.open()).toEqual([file]);
      const text = path.join(dir, "notes.db");
      fs.writeFileSync(text, "hello");
      await expect(svc.schema(text)).rejects.toThrow(/isn't a SQLite database/);
      await expect(svc.schema(path.join(dir, "gone.db"))).rejects.toThrow(/no file at/);
    } finally {
      svc.close();
    }
    expect(svc.open()).toEqual([]);
  });
});

describe("sqlite window type", () => {
  const types = new WindowTypes();
  registerBuiltins(types);
  const kindFor = (p: string) => types.resolve(targetFor(p)!)?.kind ?? null;

  it("opens .sqlite and .db files, and a sidecar opens its database", () => {
    const file = makeDb("routed.sqlite");
    expect(kindFor(file)).toBe("sqlite");
    fs.writeFileSync(path.join(dir, "x.db"), "whatever");
    expect(kindFor(path.join(dir, "x.db"))).toBe("sqlite"); // by extension; create checks the header
    fs.writeFileSync(`${file}-wal`, "");
    expect(kindFor(`${file}-wal`)).toBe("sqlite");
    expect(databaseOf(`${file}-wal`)).toBe(file);
    expect(databaseOf(path.join(dir, "lonely.db-wal"))).toBe(path.join(dir, "lonely.db-wal")); // no database beside it: left as is
    expect(sqliteType.create({ path: `${file}-wal` })).toEqual({ state: { path: file }, title: "routed.sqlite" });
    expect(sqliteType.create({ path: file, table: "orders" }).state).toEqual({ path: file, table: "orders" });
  });

  it("refuses a file that isn't a database, and keeps the table, tab and draft in its state", () => {
    const text = path.join(dir, "words.db");
    fs.writeFileSync(text, "not a database");
    expect(isSqliteFile(text)).toBe(false);
    expect(() => sqliteType.create({ path: text })).toThrow(/isn't a SQLite database/);
    const empty = path.join(dir, "empty.db");
    fs.writeFileSync(empty, "");
    expect(isSqliteFile(empty)).toBe(true);
    const file = makeDb("state.sqlite");
    const { state } = sqliteType.create({ path: file });
    const next = sqliteType.update!(state, { table: "orders", tab: "query", sql: "SELECT 1", bogus: 1 });
    expect(next.state).toEqual({ path: file, table: "orders", tab: "query", sql: "SELECT 1" });
    expect(sqliteType.update!(next.state, { table: null, tab: "nope" }).state).toEqual({ path: file, tab: "query", sql: "SELECT 1" });
  });
});
