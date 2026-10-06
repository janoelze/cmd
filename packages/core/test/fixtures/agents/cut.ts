// Cuts one agent's recorded events out of a cmd core's database into a fixture
// (docs/19-agent-activity-review.md, "The lab loop"):
//   node test/fixtures/agents/cut.ts <events.sqlite> <pane-prefix> <agent> <out.jsonl> <scenario> [--scrub] [--from HH:MM:SS --to HH:MM:SS]
// Paths: the session's folder becomes /work/repo, the home folder /Users/me.
// --scrub replaces prompts, messages, tool inputs and outputs with placeholders
// (for sessions from real work); without it the payloads stay as recorded (lab
// sessions with scripted prompts in a throwaway repository). Read the file before committing.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import { toFixture } from "../../../src/agents/activity/fixture.ts";
import type { RawEvent } from "../../../src/agents/activity/normalize.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const scrub = args.includes("--scrub") && (args.splice(args.indexOf("--scrub"), 1), true);
const from = flag("--from");
const to = flag("--to");
const [dbPath = "", panePrefix = "", agent = "", out = "", scenario = ""] = args;
if (!out) {
  console.error("usage: cut.ts <events.sqlite> <pane-prefix> <agent> <out.jsonl> <scenario> [--scrub] [--from HH:MM:SS --to HH:MM:SS]");
  process.exit(2);
}

type Row = { at: number; agent: string; name: string; doc: string; env: string | null; hook: number | null; agent_version: string | null; cmd: string | null };
const db = new DatabaseSync(dbPath, { readOnly: true });
let rows = db
  .prepare(`SELECT at, json_extract(data, '$.agent') AS agent, json_extract(data, '$.name') AS name, json_extract(data, '$.payload') AS doc, json_extract(data, '$.env') AS env, json_extract(data, '$.hook') AS hook, json_extract(data, '$.agentVersion') AS agent_version, recorded AS cmd FROM events WHERE pane_id >= ? AND pane_id < ? AND type = 'agent.hook' AND json_extract(data, '$.agent') = ? ORDER BY seq`)
  .all(panePrefix, `${panePrefix}\uffff`, agent) as unknown as Row[];
const clock = (t: number) => new Date(t).toTimeString().slice(0, 8);
if (from) rows = rows.filter((r) => clock(r.at) >= from);
if (to) rows = rows.filter((r) => clock(r.at) <= to);
if (!rows.length) throw new Error("no events match");

const KEEP = new Set(["session_id", "transcript_path", "cwd", "prompt_id", "turn_id", "permission_mode", "hook_event_name", "tool_name", "tool_use_id", "agent_id", "agent_type", "notification_type", "stop_hook_active", "error", "model", "source", "reason", "trigger", "effort", "timestamp", "background_tasks"]);
let n = 0;
function scrubbed(p: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (KEEP.has(k)) o[k] = v;
    else if (k === "prompt") o[k] = `<prompt ${++n}>`;
    else if (k === "last_assistant_message" || k === "prompt_response") o[k] = `<message ${++n}>`;
    else if (k === "message") o[k] = v; // notification wording is the agent's, not the user's
    else if (k === "tool_input") o[k] = { command: `<command ${++n}>`, description: `<description ${n}>` };
    else if (k === "tool_response") o[k] = { stdout: "", stderr: "", interrupted: false };
    else o[k] = Array.isArray(v) ? [] : typeof v === "string" ? `<${k}>` : v;
  }
  return o;
}

const raws: RawEvent[] = rows.map((r) => {
  const payload = JSON.parse(r.doc) as Record<string, unknown>;
  return { at: r.at, agent: r.agent, name: r.name, payload: scrub ? scrubbed(payload) : payload, ...(r.hook ? { hook: r.hook } : {}), ...(r.env ? { env: JSON.parse(r.env) as Record<string, string> } : {}) };
});
const cwd = rows.map((r) => (JSON.parse(r.doc) as { cwd?: string }).cwd).find(Boolean);
const subs: Record<string, string> = { [os.homedir()]: "/Users/me" };
if (cwd) {
  subs[cwd] = "/work/repo";
  subs[cwd.replaceAll("/", "-")] = "-work-repo"; // Claude's project folder names
  subs[cwd.split("/").pop()!] = "repo";
}
subs[os.userInfo().username] = "me";
fs.writeFileSync(out, toFixture(raws, subs, { agent, agentVersion: rows[0]!.agent_version, recordedBy: rows[0]!.cmd, hook: rows[0]!.hook, scenario, ...(scrub ? { note: "prompts, messages and tool payloads replaced" } : {}) }));
console.log(`${raws.length} events → ${out} (agent ${agent} ${rows[0]!.agent_version ?? "?"}, recorded by cmd ${rows[0]!.cmd ?? "?"})`);
