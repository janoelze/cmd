// Phase 0 of the data layer (docs/28 §9): imports this Mac's data into the
// proposed events file, then measures what docs/26 "Measures" asks for.
//
//   node scripts/data/spike.ts --db <copy of cmd.sqlite> --out <events.sqlite> [--transcripts] [--homes ~/.claude,~/.claude-profiles/work] [--limit N] [--report file.md]
//
// Steps: import agent_events and journal_events; walk the agents' transcript
// folders into transcript.* events (blobs for big lines); build the FTS; replay
// the activity reducer over the imported hook events and compare with the turns
// the core stored; time the queries the UI would run; print sizes per class.
// Prints only counts, sizes and first words: never a secret (redaction runs on import).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { ActivityReducer } from "../../packages/core/src/agents/activity/reduce.ts";
import { normalize, type RawEvent } from "../../packages/core/src/agents/activity/normalize.ts";
import type { AgentTurn } from "@cmd/protocol";
import { decodeRows, decodeTurn } from "../../packages/core/src/stored.ts";
import { DataStore, type NewEvent } from "../../packages/core/src/data/store.ts";
import { hookEvents, journalEvents } from "../../packages/core/src/data/sources/legacy.ts";
import { FLAG_CUT } from "../../packages/core/src/data/schema.ts";
import { claudeLine, codexLine, type TranscriptFile } from "../../packages/core/src/data/sources/transcripts.ts";
import { redact, redactDeep } from "../../packages/core/src/redact.ts";

const args = process.argv.slice(2);
const opt = (name: string, dflt?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const flag = (name: string) => args.includes(`--${name}`);

const dbPath = opt("db");
const out = opt("out", path.join(os.tmpdir(), "cmd-spike-events.sqlite"))!;
const limit = Number(opt("limit", "0"));
/** Tool results (file reads, command output: 80% of all bytes) are cut here before storage; 0 = keep whole. */
const toolResultCap = Number(opt("tool-result-cap", "0"));
const homes = (opt("homes", `${os.homedir()}/.claude,${os.homedir()}/.claude-profiles/work,${os.homedir()}/.codex`) ?? "").split(",").filter(Boolean);
const report: string[] = [];
const say = (s = "") => (console.log(s), report.push(s));
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
const ms = (t: number) => `${t.toFixed(1)} ms`;

for (const f of [out, `${out}-wal`, `${out}-shm`]) fs.rmSync(f, { force: true });
const store = new DataStore(out, { recordedBy: "spike" });

say(`# Data spike, ${new Date().toISOString().slice(0, 16)}${toolResultCap ? ` (tool results cut at ${toolResultCap} chars)` : ""}`);
say();

// ── 1. Legacy tables ─────────────────────────────────────────
const src = dbPath ? new DatabaseSync(dbPath, { readOnly: true }) : null;
if (src) {
  let t = performance.now();
  const n1 = store.recordAll(redacted(hookEvents(src)));
  say(`- agent_events → ${n1} agent.hook events in ${ms(performance.now() - t)}`);
  t = performance.now();
  const n2 = store.recordAll(redacted(journalEvents(src)));
  say(`- journal_events (live kinds, git) → ${n2} events in ${ms(performance.now() - t)}`);
}

// ── 2. Transcripts ───────────────────────────────────────────
let files = 0, lines = 0, bytesIn = 0, blobbed = 0;
const perAgent = new Map<string, { files: number; lines: number; bytes: number }>();
if (flag("transcripts")) {
  const t0 = performance.now();
  for (const file of transcriptFiles(homes)) {
    if (limit && files >= limit) break;
    files++;
    const size = fs.statSync(file.path).size;
    bytesIn += size;
    const a = perAgent.get(file.agent) ?? { files: 0, lines: 0, bytes: 0 };
    a.files++, (a.bytes += size);
    const batch: NewEvent[] = [];
    const state: { sessionId?: string; cwd?: string } = {};
    const sessionHint = file.agent === "claude" ? path.basename(file.path, ".jsonl") : undefined;
    const rl = readline.createInterface({ input: fs.createReadStream(file.path), crlfDelay: Infinity });
    let n = 0;
    for await (const line of rl) {
      n++;
      const e = file.agent === "claude" ? claudeLine(line, n, file, sessionHint) : codexLine(line, n, file, state);
      if (!e) continue;
      if (e.content) blobbed++;
      batch.push(redactEvent(e));
      if (batch.length >= 500) store.recordAll(batch.splice(0));
    }
    store.recordAll(batch);
    lines += n;
    a.lines += n;
    perAgent.set(file.agent, a);
    if (files % 50 === 0) process.stderr.write(`  ${files} files, ${lines} lines, ${mb(bytesIn)}\n`);
  }
  say(`- transcripts: ${files} files, ${lines} lines, ${mb(bytesIn)} on disk → events with ${blobbed} blobs, in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  for (const [agent, a] of perAgent) say(`  - ${agent}: ${a.files} files, ${a.lines} lines, ${mb(a.bytes)}`);
}
store.checkpoint();

// ── 3. FTS ───────────────────────────────────────────────────
{
  const t = performance.now();
  // Body text wasn't kept in the row; rebuild from text only here, bodies were indexed during record().
  const before = store.pageBytes();
  const ftsBytes = Object.entries(before).filter(([k]) => k.startsWith("events_fts")).reduce((n, [, b]) => n + b, 0);
  say(`- FTS (built during import): ${mb(ftsBytes)} in pages; optimize ${ms(performance.now() - t)}`);
  store.db.exec(`INSERT INTO events_fts(events_fts) VALUES ('optimize')`);
}
store.checkpoint();

// ── 4. Sizes ─────────────────────────────────────────────────
{
  const s = store.stats();
  const pages = store.pageBytes();
  say();
  say(`## Size`);
  say(`- file: ${mb(s.fileBytes)}; events: ${s.events}; blobs: ${s.blobs.count}, ${mb(s.blobs.size)} raw → ${mb(s.blobs.stored)} stored (${s.blobs.size ? ((s.blobs.stored / s.blobs.size) * 100).toFixed(0) : 0}%)`);
  if (bytesIn) say(`- transcripts on disk ${mb(bytesIn)} → in the file ≈ ${mb((pages.events ?? 0) + (pages.blobs ?? 0))} (events + blobs pages, all sources)`);
  const top = Object.entries(pages).sort((a, b) => b[1] - a[1]).slice(0, 12);
  say(`- pages: ${top.map(([k, b]) => `${k} ${mb(b)}`).join(", ")}`);
  say();
  say(`| type | rows | inline bytes | with blob |`);
  say(`|---|---|---|---|`);
  for (const t of s.types) say(`| ${t.type} | ${t.rows} | ${mb(t.bytes)} | ${t.blobs} |`);
}

// ── 5. Replay the reducer over imported hook events ──────────
if (src) {
  say();
  say(`## Replay: turns from events vs. turns the core stored`);
  const agents = store.db.prepare(`SELECT DISTINCT agent_id FROM events WHERE type = 'agent.hook' AND agent_id IS NOT NULL`).all() as { agent_id: string }[];
  let same = 0, diffCount = 0, diffOutcome = 0, diffPrompt = 0, total = 0, replayMs = 0;
  const examples: string[] = [];
  /** Which rules derived the stored turns of agents whose replay differs: "format 1 by 0.11.0" → count. */
  const diffBy = new Map<string, number>();
  const sameBy = new Map<string, number>();
  for (const { agent_id } of agents) {
    const stored = decodeRows("turn", (src.prepare(`SELECT doc FROM agent_turns WHERE agent_id = ? ORDER BY idx`).all(agent_id) as { doc: string }[]).map((r) => r.doc), decodeTurn) as AgentTurn[];
    const rules = [...new Set(stored.map((t) => `format ${t.format} by ${t.derivedBy ?? "?"}`))].join(", ") || "no stored turns";
    const t = performance.now();
    const replayed = replay(store, agent_id, stored[0]?.agentKind ?? "claude");
    replayMs += performance.now() - t;
    total++;
    if (replayed.length !== stored.length) {
      diffCount++;
      diffBy.set(rules, (diffBy.get(rules) ?? 0) + 1);
      if (examples.length < 6) examples.push(`${agent_id.slice(0, 8)}: ${stored.length} stored (${rules}), ${replayed.length} replayed with ${replayed.reduce((n, x) => n + x.followUps.length, 0)} follow-ups`);
      continue;
    }
    sameBy.set(rules, (sameBy.get(rules) ?? 0) + 1);
    let ok = true;
    for (let i = 0; i < stored.length; i++) {
      const a = stored[i]!, b = replayed[i]!;
      if (a.outcome !== b.outcome && !(a.outcome === "interrupted" && b.outcome === "working")) (ok = false), diffOutcome++;
      if ((a.prompt ?? "").slice(0, 40) !== (b.prompt ?? "").slice(0, 40)) (ok = false), diffPrompt++;
      if (!ok && examples.length < 6) examples.push(`${agent_id.slice(0, 8)}#${i}: ${a.outcome}/${b.outcome}, prompt ${a.prompt ? `"${redact(a.prompt).slice(0, 30)}"` : "null"} vs ${b.prompt ? `"${redact(b.prompt).slice(0, 30)}"` : "null"}`);
    }
    if (ok) same++;
  }
  say(`- agents: ${total}; identical turn lists: ${same}; different count: ${diffCount}; outcome mismatches: ${diffOutcome}; prompt mismatches: ${diffPrompt}; replay time ${ms(replayMs)} total`);
  say(`- stored turns' rules where the replay matched: ${[...sameBy].map(([k, n]) => `${k}: ${n}`).join("; ") || "-"}`);
  say(`- stored turns' rules where the count differed: ${[...diffBy].map(([k, n]) => `${k}: ${n}`).join("; ") || "-"}`);
  say(`- expected differences: turns stored by an older TURN_FORMAT split on follow-up prompts (format 1 ended a turn at the next prompt; format 2 keeps it as a follow-up), and inferred interrupts depend on terminal activity that isn't in the log, so a stored "interrupted" vs replayed "working" is not counted`);
  for (const e of examples) say(`  - ${e}`);
}

// ── 6. Query timings ─────────────────────────────────────────
{
  say();
  say(`## Query timings (median of 7, after warm-up)`);
  const session = (store.db.prepare(`SELECT session_id, COUNT(*) n FROM events WHERE session_id IS NOT NULL GROUP BY session_id ORDER BY n DESC LIMIT 1`).get() as { session_id: string; n: number } | undefined);
  const project = (store.db.prepare(`SELECT project_id, COUNT(*) n FROM events WHERE project_id IS NOT NULL GROUP BY project_id ORDER BY n DESC LIMIT 1`).get() as { project_id: string; n: number } | undefined);
  const agent = (store.db.prepare(`SELECT agent_id, COUNT(*) n FROM events WHERE agent_id IS NOT NULL GROUP BY agent_id ORDER BY n DESC LIMIT 1`).get() as { agent_id: string; n: number } | undefined);
  const now = Date.now();
  const day = 86400_000;
  const timed = (name: string, fn: () => unknown) => {
    fn();
    const ts: number[] = [];
    let rows = 0;
    for (let i = 0; i < 7; i++) {
      const t = performance.now();
      const r = fn();
      ts.push(performance.now() - t);
      rows = Array.isArray(r) ? r.length : typeof r === "number" ? r : 0;
    }
    ts.sort((a, b) => a - b);
    say(`- ${name}: ${ms(ts[3]!)} (${rows} rows)`);
  };
  if (session) timed(`last 50 events of the busiest session (${session.n} events)`, () => store.query({ sessionId: session.session_id, order: "desc", limit: 50 }));
  if (session) timed(`all events of that session, oldest first`, () => store.query({ sessionId: session.session_id, limit: 100_000 }));
  if (project) timed(`events of the busiest project in the last 7 days`, () => store.query({ projectId: project.project_id, at: [now - 7 * day, now], limit: 100_000 }));
  if (agent) timed(`agent.hook events of the busiest agent (replay input)`, () => store.query({ agentId: agent.agent_id, types: ["agent.hook"], limit: 100_000 }));
  timed(`git.* events in the last 30 days`, () => store.query({ types: ["git."], at: [now - 30 * day, now], limit: 100_000 }));
  timed(`FTS "flaky test"`, () => store.query({ text: '"flaky" OR "test"', limit: 50 }));
  timed(`FTS "sqlite" in the busiest project`, () => store.query({ text: "sqlite", projectId: project?.project_id, limit: 50 }));
  timed(`events per type per day, last 30 days (counters)`, () => (store.db.prepare(`SELECT type, at / 86400000 AS d, COUNT(*) FROM events WHERE at >= ? GROUP BY type, d`).all(now - 30 * day) as unknown[]).length);
  timed(`a blob read (largest)`, () => {
    const h = (store.db.prepare(`SELECT hash FROM blobs ORDER BY size DESC LIMIT 1`).get() as { hash: string } | undefined)?.hash;
    return h ? store.blob(h)?.length ?? 0 : 0;
  });
}

const reportFile = opt("report");
if (reportFile) fs.writeFileSync(reportFile, report.join("\n") + "\n");
store.close();
src?.close();

// ── helpers ──────────────────────────────────────────────────

function* redacted(events: Iterable<NewEvent>): Generator<NewEvent> {
  for (const e of events) yield redactEvent(e);
}

function redactEvent(e: NewEvent): NewEvent {
  let content = typeof e.content === "string" ? redact(e.content) : e.content;
  let flags = e.flags ?? 0;
  // Policy under test (docs/26 A8): tool results cut at the cap; Codex's encrypted reasoning kept as a row, not as bytes.
  if (toolResultCap && e.type === "transcript.tool_result" && typeof content === "string" && content.length > toolResultCap) (content = content.slice(0, toolResultCap)), (flags |= FLAG_CUT);
  if (e.type === "transcript.other" && (e.data as { item?: string })?.item === "reasoning") (content = null), (flags |= FLAG_CUT);
  return { ...e, text: e.text ? redact(e.text) : e.text, body: e.body ? redact(e.body) : e.body, data: redactDeep(e.data), content, flags };
}

function* transcriptFiles(roots: string[]): Generator<TranscriptFile> {
  for (const home of roots) {
    const projects = path.join(home, "projects");
    if (fs.existsSync(projects)) {
      for (const f of walk(projects)) yield { agent: "claude", path: f, home };
      continue;
    }
    for (const sub of ["sessions", "archived_sessions"]) {
      const d = path.join(home, sub);
      if (fs.existsSync(d)) for (const f of walk(d)) yield { agent: "codex", path: f, home };
    }
  }
}

function* walk(dir: string): Generator<string> {
  let ents: fs.Dirent[] = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

/** The turns the reducer makes from an agent's imported hook events, in order. */
function replay(store: DataStore, agentId: string, kind: AgentTurn["agentKind"]): AgentTurn[] {
  const events = store.query({ agentId, types: ["agent.hook", "agent.note"], limit: 1_000_000 });
  const red = new ActivityReducer(agentId, 0, { agentKind: kind });
  const turns: AgentTurn[] = [];
  for (const e of events) {
    const d = e.data as { name: string; agent: string | null; env?: Record<string, string>; hook?: number | null; payload: Record<string, unknown> };
    if (e.type !== "agent.hook" || !d?.payload) continue;
    const raw: RawEvent = { at: e.at, agent: d.agent as RawEvent["agent"], name: d.name, payload: d.payload, env: d.env, hook: d.hook ?? undefined };
    const r = red.apply(normalize(raw, e.seq));
    if (r.closed) turns.push(r.closed);
  }
  if (red.turn && red.open) turns.push(red.turn);
  return turns;
}
