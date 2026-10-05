// Turns a pane's hook spool (<status root>/<pane>/log, before cmd reads it) into a
// fixture: node test/fixtures/agents/record.ts <spool dir> <out.jsonl> [<path>=<placeholder> …]
// The home dir always becomes /Users/me.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toFixture } from "../../../src/agents/activity/fixture.ts";
import type { RawEvent } from "../../../src/agents/activity/normalize.ts";

const [dir = "", out = "", ...rest] = process.argv.slice(2);
const events: RawEvent[] = fs
  .readdirSync(dir)
  .filter((n) => !n.startsWith("."))
  .map((n) => {
    const file = path.join(dir, n);
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    return { at: Number(fs.statSync(file, { bigint: true }).mtimeNs / 1000n) / 1000, agent: r.agent, name: r.event.hook_event_name ?? n.split(".")[2], payload: r.event, ...(r.env && Object.keys(r.env).length ? { env: r.env } : {}) };
  })
  .sort((a, b) => a.at - b.at);
const subs = Object.fromEntries([...rest.map((s) => s.split("=") as [string, string]), [os.homedir(), "/Users/me"]]);
fs.writeFileSync(out, toFixture(events, subs));
console.log(`${events.length} events → ${out}`);
