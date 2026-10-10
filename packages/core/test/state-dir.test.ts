// A core's state dir before it opens anything (data/state-dir.ts): the other
// instance's default dir and data from a newer cmd are refused, untouched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreRefusal, coreRefusalLine, defaultHome, foreignHome } from "@cmd/protocol/node";
import { prepareStateDir, StateDirRefused } from "../src/data/state-dir.ts";
import { DataStore } from "../src/data/store.ts";
import { EVENTS_SCHEMA } from "../src/data/schema.ts";
import { schemaOf } from "../src/data/migrations.ts";
import { Store, STORE_SCHEMA, StoreTooNew } from "../src/store.ts";
import { eventsV1, insertV1 } from "./events-v1.ts";
import { rmTemp } from "./tmp.ts";

let dir: string;
beforeEach(() => void (dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-statedir-")))));
afterEach(() => rmTemp(dir));

/** A schema-1 event log (as 0.23 wrote it) in `home`; returns its path. */
function v1Log(home: string): string {
  const file = path.join(home, "data", "events.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = eventsV1(file, { spaces: true });
  insertV1(db, { seq: 1, id: "a", at: 1000, type: "command", text: "ls" }, true);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return file;
}

/**
 * The files in `dir` (recursively) with their bytes, to show nothing was
 * written. An empty WAL and the shared-memory index are left out: SQLite makes
 * them for a reader and can't remove them after a read-only one.
 */
function snapshot(d: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(d, { recursive: true }) as string[]) {
    const p = path.join(d, name);
    const st = fs.statSync(p);
    if (!st.isFile() || name.endsWith("-shm") || (name.endsWith("-wal") && st.size === 0)) continue;
    out[name] = fs.readFileSync(p).toString("base64");
  }
  return out;
}

function refusal(fn: () => void): StateDirRefused {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StateDirRefused);
    return err as StateDirRefused;
  }
  throw new Error("not refused");
}

describe("foreignHome", () => {
  it("names the other instance on its default state dir only", () => {
    expect(foreignHome(defaultHome("release", dir), "dev", dir)).toBe("release");
    expect(foreignHome(defaultHome("dev", dir), "release", dir)).toBe("dev");
    expect(foreignHome(defaultHome("dev", dir), "dev", dir)).toBeNull();
    expect(foreignHome(defaultHome("release", dir), "release", dir)).toBeNull();
    expect(foreignHome(path.join(dir, "worktree", ".cmd-dev"), "dev", dir)).toBeNull();
    expect(foreignHome(path.join(dir, "e2e"), "release", dir)).toBeNull();
  });

  it("sees through a symlink and a trailing slash", () => {
    const release = defaultHome("release", dir);
    fs.mkdirSync(release, { recursive: true });
    fs.symlinkSync(release, path.join(dir, "link"));
    expect(foreignHome(path.join(dir, "link"), "dev", dir)).toBe("release");
    expect(foreignHome(`${release}/`, "dev", dir)).toBe("release");
  });
});

describe("prepareStateDir", () => {
  it("won't let a dev core migrate the installed app's event log", () => {
    const home = defaultHome("release", dir);
    v1Log(home);
    const before = snapshot(home);
    const e = refusal(() => prepareStateDir(home, "dev", dir));
    expect(e.reason).toBe("foreign");
    expect(e.forPeople).toBe("That data belongs to the installed cmd. Set CMD_HOME to another folder.");
    expect(snapshot(home)).toEqual(before);
  });

  it("won't let a release core open cmd dev's state dir", () => {
    const home = defaultHome("dev", dir);
    v1Log(home);
    expect(refusal(() => prepareStateDir(home, "release", dir)).reason).toBe("foreign");
  });

  it("migrates its own instance's log, and any CMD_HOME's", () => {
    for (const [home, instance] of [
      [defaultHome("dev", dir), "dev"],
      [path.join(dir, "worktree", ".cmd-dev"), "dev"],
    ] as const) {
      const file = v1Log(home);
      prepareStateDir(home, instance, dir);
      const db = new DatabaseSync(file);
      expect(schemaOf(db)).toBe(EVENTS_SCHEMA);
      db.close();
    }
  });

  it("refuses an event log from a newer cmd, writing nothing", () => {
    const home = path.join(dir, "home");
    const file = path.join(home, "data", "events.sqlite");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    new DataStore(file).close();
    const db = new DatabaseSync(file);
    db.exec(`UPDATE meta SET value = '${EVENTS_SCHEMA + 1}' WHERE key = 'schema'; PRAGMA wal_checkpoint(TRUNCATE)`);
    db.close();
    const before = snapshot(home);
    const e = refusal(() => prepareStateDir(home, "release", dir));
    expect(e.reason).toBe("too-new");
    expect(e.message).toMatch(/newer cmd \(event log schema/);
    expect(e.forPeople).toBe("The data is from a newer version of cmd. Update cmd to open it.");
    expect(snapshot(home)).toEqual(before);
  });

  it("refuses a cmd.sqlite from a newer cmd before touching the event log", () => {
    const home = path.join(dir, "home");
    v1Log(home);
    const store = new Store(path.join(home, "cmd.sqlite"));
    store.db.exec(`UPDATE meta SET value = '${STORE_SCHEMA + 1}' WHERE key = 'schema'; PRAGMA wal_checkpoint(TRUNCATE)`);
    store.close();
    const before = snapshot(home);
    const e = refusal(() => prepareStateDir(home, "release", dir));
    expect(e.reason).toBe("too-new");
    expect(e.message).toMatch(/newer cmd \(state schema/);
    expect(snapshot(home)).toEqual(before);
  });
});

describe("cmd.sqlite schema", () => {
  it("is recorded in a new file, and in one from before it was", () => {
    const file = path.join(dir, "cmd.sqlite");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, doc TEXT NOT NULL); INSERT INTO spaces VALUES ('s1', '/src/shop', '{"id":"s1","root":"/src/shop"}')`);
    old.close();
    const s = new Store(file);
    expect(s.db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get()).toEqual({ value: String(STORE_SCHEMA) });
    expect(s.workspaces().map((w) => w.root)).toEqual(["/src/shop"]);
    s.close();
  });

  it("refuses a file from a newer cmd instead of starting over on it", () => {
    const file = path.join(dir, "cmd.sqlite");
    const s = new Store(file);
    s.saveWorkspace({ id: "w1", root: "/src/shop" } as Parameters<Store["saveWorkspace"]>[0]);
    s.db.exec(`UPDATE meta SET value = '${STORE_SCHEMA + 1}' WHERE key = 'schema'; PRAGMA wal_checkpoint(TRUNCATE)`);
    s.close();
    const before = snapshot(dir);
    expect(() => new Store(file)).toThrow(StoreTooNew);
    expect(snapshot(dir)).toEqual(before);
  });
});

describe("coreRefusal", () => {
  it("finds the refusal a core printed, for the app", () => {
    const line = coreRefusalLine("too-new", "The data is from a newer version of cmd. Update cmd to open it.");
    expect(coreRefusal(["Node warning", line, ""])).toEqual({ reason: "too-new", text: "The data is from a newer version of cmd. Update cmd to open it." });
    expect(coreRefusal(["cmd core: a core is already running for /x"])).toBeNull();
  });
});
