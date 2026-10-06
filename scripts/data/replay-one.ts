// Replays one agent's imported hook events through the reducer and prints its
// turns compactly (no prompt text): node scripts/data/replay-one.ts <events.sqlite> <agent id prefix>

import { ActivityReducer } from "../../packages/core/src/agents/activity/reduce.ts";
import { normalize, type RawEvent } from "../../packages/core/src/agents/activity/normalize.ts";
import { DataStore } from "../../packages/core/src/data/store.ts";

const [file, prefix] = process.argv.slice(2);
const store = new DataStore(file!);
const agentId = (store.db.prepare(`SELECT DISTINCT agent_id FROM events WHERE agent_id LIKE ?`).get(`${prefix}%`) as { agent_id: string }).agent_id;
const events = store.query({ agentId, types: ["agent.hook", "agent.note"], limit: 1_000_000 });
const red = new ActivityReducer(agentId, 0, { agentKind: "claude" });
const t = (ms: number) => new Date(ms).toISOString().slice(11, 19);
let i = 0;
for (const e of events) {
  const d = e.data as { name: string; agent: string | null; env?: Record<string, string>; hook?: number | null; payload: Record<string, unknown> };
  if (e.type !== "agent.hook") {
    console.log(`  ${t(e.at)} core note: ${d?.name ?? e.text}`);
    continue;
  }
  const raw: RawEvent = { at: e.at, agent: d.agent as RawEvent["agent"], name: d.name, payload: d.payload, env: d.env, hook: d.hook ?? undefined };
  const ev = normalize(raw, e.seq);
  const r = red.apply(ev);
  if (ev.kind === "prompt" || ev.kind === "stop" || ev.kind === "session.start" || ev.kind === "session.end" || ev.kind === "idle" || ev.kind === "ask" || ev.kind === "fail") console.log(`  ${t(e.at)} ${ev.kind}${ev.sessionId ? ` s=${ev.sessionId.slice(0, 8)}` : ""}${ev.auto ? " auto" : ""}${ev.subagent ? " sub" : ""} → turn ${red.turn?.index ?? "-"} ${red.turn?.outcome ?? ""}`);
  if (r.closed) console.log(`closed #${i++}: ${r.closed.outcome}, ${r.closed.followUps.length} follow-ups, ${r.closed.events} events, ${t(r.closed.startedAt)}–${r.closed.endedAt ? t(r.closed.endedAt) : "…"}`);
}
if (red.turn && red.open) console.log(`open  #${i}: ${red.turn.outcome}, ${red.turn.followUps.length} follow-ups`);
