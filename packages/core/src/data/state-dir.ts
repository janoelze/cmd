// The core's state dir before anything opens it (main.ts): is it this
// instance's, and can this cmd serve its state (cmd.sqlite) and event log?
// Either no: the core doesn't start, and says why in core.log and to the app
// (StateDirRefused).
// The rule: a core never runs on the other instance's default state dir
// (protocol/instance.ts, foreignHome). A dev core on the installed app's data
// migrated its event log to a schema the installed cmd couldn't write to.
// Any other $CMD_HOME (tests, e2e, worktrees) is left alone.

import os from "node:os";
import path from "node:path";
import { foreignHome, instanceName, type CoreRefusalReason, type InstanceName } from "@cmd/protocol/node";
import { EventsLogTooNew, prepareEventsLog } from "./migrations.ts";
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

/**
 * Checks `home` belongs to `instance` and its cmd.sqlite isn't from a newer
 * cmd, then migrates its event log (or refuses a newer one). Throws
 * StateDirRefused before writing anything.
 */
export function prepareStateDir(home: string, instance: InstanceName = instanceName(), homedir = os.homedir()): void {
  const other = foreignHome(home, instance, homedir);
  if (other)
    throw new StateDirRefused(
      "foreign",
      `${home} is the ${other} instance's state dir, and this core is ${instance}: not opening it`,
      other === "release" ? "That data belongs to the installed cmd. Set CMD_HOME to another folder." : "That data belongs to cmd dev. Set CMD_HOME to another folder.",
    );
  try {
    checkStoreSchema(path.join(home, "cmd.sqlite"));
    prepareEventsLog(path.join(home, "data", "events.sqlite"));
  } catch (err) {
    if (err instanceof EventsLogTooNew || err instanceof StoreTooNew) throw new StateDirRefused("too-new", err.message, "The data is from a newer version of cmd. Update cmd to open it.");
    throw err;
  }
}
