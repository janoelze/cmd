// Journal lab: backfill a throwaway journal from real data (a copy of cmd.sqlite,
// the transcript index, git) and print a day's threads, digest or journal.
//   node scripts/journal/lab.ts threads --data <copy of $CMD_HOME/data> --day 2026-10-05 [--repo ~/src/cmd]
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { JournalStore } from "../../packages/core/src/journal/store.ts";
import { DataService } from "../../packages/core/src/data/service.ts";
import { ActivityView } from "../../packages/core/src/data/views/activity.ts";
import { ViewsStore } from "../../packages/core/src/data/views/views.ts";
import { DEFAULT_SETTINGS } from "../../packages/protocol/src/index.ts";
import path from "node:path";
import { sessionEvents, turnEvents } from "../../packages/core/src/journal/backfill.ts";
import { SessionsView } from "../../packages/core/src/data/views/sessions.ts";
import { gitEvents } from "../../packages/core/src/journal/git.ts";
import { buildThreads } from "../../packages/core/src/journal/threads.ts";
import { digest } from "../../packages/core/src/journal/digest.ts";
import { SCHEMA, SYSTEM, toDay, type WrittenDay } from "../../packages/core/src/journal/writer.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const { values: a, positionals } = parseArgs({ allowPositionals: true, options: { synthetic: { type: "boolean" }, model: { type: "string", default: "sonnet" }, out: { type: "string" }, data: { type: "string" }, day: { type: "string" }, repo: { type: "string" }, all: { type: "boolean" } } });
const day = new Date(`${a.day}T04:00:00`).getTime();
const from = day, to = day + 86400_000;
const since = from - 3 * 86400_000;

const store = new JournalStore();
// --data: a copy of $CMD_HOME/data (events.sqlite and views.sqlite): turns and sessions from its views.
if (a.data) {
  const data = new DataService({ file: path.join(a.data, "events.sqlite"), recordedBy: "lab", settings: () => DEFAULT_SETTINGS });
  const views = new ViewsStore(path.join(a.data, "views.sqlite"));
  store.recordAll(turnEvents(new ActivityView(data, views).turnsSince(since)));
  store.recordAll(sessionEvents(new SessionsView(views, data).sessionsSince(since)));
}
if (a.synthetic) store.recordAll((await import("../../packages/core/test/fixtures/journal-day.ts")).syntheticDay(a.day!));
const repos = new Set(store.repos(since).map((r) => r.repo));
if (!a.synthetic) for (const r of repos) store.recordAll(await gitEvents(r, since));
const events = store.events({ since, until: to, repo: a.repo?.replace(/^~/, process.env.HOME!) });
const threads = buildThreads(events, { from, to });

const hm = (t: number) => new Date(t).toTimeString().slice(0, 5);
const home = (p: string | null) => (p ?? "").replace(process.env.HOME!, "~");
if (positionals[0] === "threads") {
  const byKind: Record<string, number> = {};
  for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  console.log("events", events.length, byKind, "repos", [...repos].map(home));
  for (const t of threads) {
    if (t.minor && !a.all) continue;
    console.log(`${hm(t.start)}–${hm(t.end)} ${t.minor ? "·" : " "} ${t.kind.padEnd(8)} ${home(t.repo).padEnd(22)} ${t.label.slice(0, 60).padEnd(60)} ${t.events.length}ev`);
    for (const l of t.links) console.log(`${" ".repeat(16)}→ ${l.to.replace(/^.*?:/, "").replace(process.env.HOME!, "~")}  (${l.rule})`);
  }
  console.log("threads", threads.length, "minor", threads.filter((t) => t.minor).length);
}

const title = `Work day: ${new Date(from).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}, 04:00 to 04:00. ${a.repo ? `Project: ${a.repo}` : "All projects"}.`;
const d = digest(threads, events, { title });
if (positionals[0] === "digest") console.log(d.text, `\n\n(${d.text.length} chars, hash ${d.hash})`);
if (positionals[0] === "write") {
  const prompt = `${SYSTEM}\n\nAnswer with only a JSON object matching this schema, no prose:\n${JSON.stringify(SCHEMA)}\n\n<day>\n${d.text}\n</day>`;
  const t0 = Date.now();
  const out = execFileSync("claude", ["-p", "--model", a.model!], { input: prompt, encoding: "utf8", maxBuffer: 1 << 24, shell: "/bin/zsh" });
  const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  const w = JSON.parse(json) as WrittenDay;
  const day = toDay(w, d, threads, events, { date: new Date(from).setHours(0, 0, 0, 0), scope: a.repo ?? "all", writtenBy: a.model!, window: { from, to } });
  if (a.out) fs.writeFileSync(a.out, JSON.stringify({ day, threads, digest: d.text }, null, 2));
  console.log(`# ${new Date(from).toDateString()}  (${((Date.now() - t0) / 1000).toFixed(0)} s, ${d.text.length} chars in)\n\n${day.headline}\n`);
  for (const e of day.entries) console.log(`${hm(e.start)}–${hm(e.end)}  [${e.kind}${e.outcome ? `/${e.outcome}` : ""}] ${e.title}\n             ${e.summary}\n             ${e.threads.map((t) => t.replace(/^(\w+):.*?#?([^#]*)$/, "$1:$2").slice(0, 40)).join(", ")}  ${JSON.stringify(e.counts)}`);
}
