// The core's state dir before anything opens it (main.ts): is it this
// instance's, and can this cmd serve its state (cmd.sqlite) and event log?
// Either no: the core doesn't start, and says why in core.log and to the app
// (StateDirRefused).
// The rule: a core never runs on the other instance's default state dir
// (protocol/instance.ts, foreignHome), and dev code (a checkout, a `pnpm dist`
// runtime) never on the release one, whatever instance it was started as. A
// dev build on the installed app's data migrated its event log to a schema
// the installed cmd couldn't write to. Any other $CMD_HOME (tests, e2e,
// worktrees) is left alone.
// Refused, nothing in the folder was written: the foreign check comes before
// the core makes the folder, its log or its lock (checkHome), and the schema
// checks only read, leaving no -wal/-shm (data/peek.ts).

import os from "node:os";
import path from "node:path";
import { foreignHome, foreignHomeText, instanceName, type CoreRefusalReason, type InstanceName } from "@cmd/protocol/node";
import { EventsLogTooNew, prepareEventsLog, schemaOf } from "./migrations.ts";
import { EVENTS_SCHEMA } from "./schema.ts";
import { peek } from "./peek.ts";
import { checkStoreSchema, StoreTooNew } from "../store.ts";

/** Why a core won't start on a state dir: `message` for core.log, `forPeople` for the app's dialog (coreRefusalLine). */
export class StateDirRefused extends Error {
  override name = "StateDirRefused";
  readonly reason: CoreRefusalReason;
  readonly forPeople: string;
  constructor(reason: CoreRefusalReason, message: string, forPeople: string) {
    super(message);
    this.reason = reason;
    this.forPeople = forPeople;
  }
}

export interface StateDirOptions {
  /** The instance the core runs as (--instance). */
  instance?: InstanceName;
  /** What its code is (codeInstance): dev code is refused the release dir even when told it's release. */
  code?: InstanceName;
  homedir?: string;
}

/** Throws StateDirRefused when `home` is another instance's default state dir. Only compares paths. */
export function checkHome(home: string, o: StateDirOptions = {}): void {
  const instance = o.instance ?? instanceName();
  const other = foreignHome(home, instance, o.homedir ?? os.homedir(), o.code ?? instance);
  if (other)
    throw new StateDirRefused(
      "foreign",
      `${home} is the ${other} instance's state dir, and this core is ${instance}${o.code && o.code !== instance ? ` (${o.code} code)` : ""}: not opening it`,
      foreignHomeText(other),
    );
}

/**
 * Checks `home` belongs to this core (checkHome) and its cmd.sqlite and event
 * log aren't from a newer cmd, then migrates an older event log. Throws
 * StateDirRefused before writing anything.
 */
export function prepareStateDir(home: string, o: StateDirOptions = {}): void {
  checkHome(home, o);
  const events = path.join(home, "data", "events.sqlite");
  try {
    checkStoreSchema(path.join(home, "cmd.sqlite"));
    // Read first: prepareEventsLog opens the file to write (WAL, pragmas) before it looks.
    const schema = peek(events, schemaOf) ?? 0;
    if (schema > EVENTS_SCHEMA) throw new EventsLogTooNew(events, schema, EVENTS_SCHEMA);
    prepareEventsLog(events);
  } catch (err) {
    if (err instanceof EventsLogTooNew || err instanceof StoreTooNew) throw new StateDirRefused("too-new", err.message, "It was saved by a newer version of cmd. Update cmd to open it.");
    throw err;
  }
}
