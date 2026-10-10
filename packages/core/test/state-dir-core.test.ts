// The real core (main.ts) on a state dir it must refuse: it exits with
// CORE_REFUSED_EXIT and the line the app shows, and leaves the folder byte for
// byte as it was. Always under a fake $HOME: the defaults it guards are faked.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_REFUSED_EXIT, coreRefusal, defaultHome, PANE_ENV } from "@cmd/protocol/node";
import { EVENTS_SCHEMA } from "../src/data/schema.ts";
import { eventsV1, insertV1 } from "./events-v1.ts";
import { rmTemp } from "./tmp.ts";

const MAIN = path.resolve(import.meta.dirname, "../src/main.ts");
let fakeHome: string;
beforeEach(() => void (fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-statedir-core-")))));
afterEach(() => rmTemp(fakeHome));

/** The core from this checkout (dev code), as `instance`, with only `env` of cmd's variables. */
function core(instance: "dev" | "release", env: Record<string, string> = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome, CMD_USAGE_URL: "off", ...env };
  for (const k of ["CMD_HOME", "CMD_INSTANCE", "CMD_LOG_DIR", "CMD_CONFIG_DIR", ...PANE_ENV]) if (!(k in env)) delete base[k];
  return spawnSync(process.execPath, ["--no-warnings", MAIN, `--instance=${instance}`], { env: base, encoding: "utf8", timeout: 20_000 });
}

/** A schema-1 event log (as 0.23 wrote it) in `home`. */
function v1Log(home: string): void {
  const file = path.join(home, "data", "events.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = eventsV1(file, { spaces: true });
  insertV1(db, { seq: 1, id: "a", at: 1000, type: "command", text: "ls" }, true);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

/** Every file and folder under `d` with its bytes. */
function snapshot(d: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(d, { recursive: true }) as string[]) {
    const p = path.join(d, name);
    out[name] = fs.statSync(p).isFile() ? fs.readFileSync(p).toString("base64") : "dir";
  }
  return out;
}

describe("a refused core", () => {
  it("leaves the installed app's data alone when a dev core is pointed at it", () => {
    const release = defaultHome("release", fakeHome);
    v1Log(release);
    const before = snapshot(fakeHome);
    const r = core("dev", { CMD_HOME: release });
    expect(r.status).toBe(CORE_REFUSED_EXIT);
    expect(coreRefusal(r.stderr.split("\n"))).toEqual({ reason: "foreign", text: "That data belongs to the installed cmd. To try this build, set CMD_HOME to another folder." });
    expect(snapshot(fakeHome)).toEqual(before); // no logs/, core.lock or core.pid in it either
  });

  it("leaves it alone when dev code is started as release", () => {
    const release = defaultHome("release", fakeHome);
    v1Log(release);
    const before = snapshot(fakeHome);
    const r = core("release");
    expect(r.status).toBe(CORE_REFUSED_EXIT);
    expect(r.stderr).toMatch(/this core is release \(dev code\)/);
    expect(snapshot(fakeHome)).toEqual(before); // ~/Library/Logs/cmd not made either
  });

  it("leaves data from a newer cmd as it was", () => {
    const home = path.join(fakeHome, "state");
    const file = path.join(home, "data", "events.sqlite");
    v1Log(home);
    const db = new DatabaseSync(file);
    db.exec(`UPDATE meta SET value = '${EVENTS_SCHEMA + 1}' WHERE key = 'schema'; PRAGMA wal_checkpoint(TRUNCATE)`);
    db.close();
    const before = snapshot(home);
    const r = core("dev", { CMD_HOME: home, CMD_LOG_DIR: path.join(fakeHome, "logs") });
    expect(r.status).toBe(CORE_REFUSED_EXIT);
    expect(coreRefusal(r.stderr.split("\n"))?.reason).toBe("too-new");
    // The lock is taken first (one core per dir); nothing else is new, and the data is byte-identical.
    const after = snapshot(home);
    delete after["core.lock"];
    expect(after).toEqual(before);
    expect(fs.readFileSync(path.join(fakeHome, "logs", "core.log"), "utf8")).toMatch(/newer cmd \(event log schema 3/);
  });
});
