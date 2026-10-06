// Journal evals (docs/28 §6, D3): build cases from real days, write them with
// the current prompt (or a variant), score each answer (core/src/journal/eval.ts).
//
//   node scripts/evals/journal.ts corpus --data <copy of $CMD_HOME/data> --days 2026-10-05,2026-10-06 [--out DIR]
//   node scripts/evals/journal.ts run [--cases DIR] [--synthetic] [--system FILE] [--model sonnet] [--repeat N] [--claude]
//
// `corpus` writes one case per day: the digest (redacted, home folder as ~),
// the groups and minor refs from the threads. Real days stay out of the repo:
// the default folder is $CMD_HOME/evals/journal. Add `mention` to a case by
// hand for what a good day must say. `run` writes each case through the AI
// service (the provider and key in Settings), or `claude -p` with --claude, and
// prints a score per case and the mean, with the problems found.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_SETTINGS } from "../../packages/protocol/src/index.ts";
import { cmdHome } from "../../packages/protocol/src/node.ts";
import { AiService } from "../../packages/core/src/ai/service.ts";
import { buildContext } from "../../packages/core/src/ai/context.ts";
import { DataService } from "../../packages/core/src/data/service.ts";
import { ActivityView } from "../../packages/core/src/data/views/activity.ts";
import { SessionsView } from "../../packages/core/src/data/views/sessions.ts";
import { ViewsStore } from "../../packages/core/src/data/views/views.ts";
import { SecretsService } from "../../packages/core/src/secrets.ts";
import { digest } from "../../packages/core/src/journal/digest.ts";
import { scoreDay, type JournalCase } from "../../packages/core/src/journal/eval.ts";
import { gitEvents } from "../../packages/core/src/journal/git.ts";
import { JournalStore } from "../../packages/core/src/journal/store.ts";
import { buildThreads } from "../../packages/core/src/journal/threads.ts";
import { SCHEMA, SYSTEM, type WrittenDay } from "../../packages/core/src/journal/writer.ts";
import { redact } from "../../packages/core/src/redact.ts";
import { syntheticDay } from "../../packages/core/test/fixtures/journal-day.ts";

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: { data: { type: "string" }, days: { type: "string" }, out: { type: "string" }, cases: { type: "string" }, synthetic: { type: "boolean" }, system: { type: "string" }, model: { type: "string" }, repeat: { type: "string" }, claude: { type: "boolean" } },
});
const casesDir = a.out ?? a.cases ?? path.join(cmdHome(), "evals", "journal");
const tilde = (s: string) => s.split(os.homedir()).join("~");

/** A day's case from a journal store: the digest and the refs, as the writer would see them. */
function caseOf(store: JournalStore, name: string, from: number): JournalCase {
  const to = from + 86400_000;
  const events = store.events({ since: from - 7 * 86400_000, until: to });
  const threads = buildThreads(events, { from, to });
  const d = digest(threads, events, { title: `Work day: ${new Date(from).toDateString()}, 04:00 to 04:00. Everything on this Mac.` });
  const refOf = new Map([...d.refs].map(([ref, id]) => [id, ref]));
  const groups = new Map<string, string[]>();
  for (const t of threads.filter((t) => !t.minor)) groups.set(t.group, [...(groups.get(t.group) ?? []), refOf.get(t.id)!]);
  return { name, digest: tilde(redact(d.text)), groups: [...groups.values()], minor: threads.filter((t) => t.minor).map((t) => refOf.get(t.id)!) };
}

if (positionals[0] === "corpus") {
  if (!a.data || !a.days) throw new Error("corpus needs --data and --days");
  const data = new DataService({ file: path.join(a.data, "events.sqlite"), recordedBy: "eval", settings: () => DEFAULT_SETTINGS });
  const views = new ViewsStore(path.join(a.data, "views.sqlite"));
  const activity = new ActivityView(data, views);
  const sessions = new SessionsView(views, data);
  const store = new JournalStore(null, { data, turns: (s) => activity.turnsSince(s), sessions: (s) => sessions.sessionsSince(s) });
  fs.mkdirSync(casesDir, { recursive: true });
  for (const day of a.days.split(",")) {
    const from = new Date(`${day}T04:00:00`).getTime();
    for (const r of new Set(store.repos(from - 7 * 86400_000).map((x) => x.repo))) store.recordAll(await gitEvents(r, from - 7 * 86400_000));
    const c = caseOf(store, day, from);
    fs.writeFileSync(path.join(casesDir, `${day}.json`), JSON.stringify(c, null, 2));
    console.log(`${day}: ${c.groups.length} groups, ${c.minor.length} minor, ${c.digest.length} chars → ${path.join(casesDir, `${day}.json`)}`);
  }
} else if (positionals[0] === "run") {
  const cases: JournalCase[] = [];
  if (fs.existsSync(casesDir)) for (const f of fs.readdirSync(casesDir).filter((f) => f.endsWith(".json"))) cases.push(JSON.parse(fs.readFileSync(path.join(casesDir, f), "utf8")) as JournalCase);
  if (a.synthetic || !cases.length) {
    const store = new JournalStore();
    store.recordAll(syntheticDay("2026-10-07"));
    cases.push({ ...caseOf(store, "synthetic", new Date("2026-10-07T04:00:00").getTime()), mention: ["release", "flaky"], entries: [4, 10] });
  }
  const system = a.system ? fs.readFileSync(a.system, "utf8") : SYSTEM;
  const repeat = Math.max(1, Number(a.repeat ?? 1));
  const ai = a.claude ? null : new AiService({ settings: () => DEFAULT_SETTINGS, secrets: new SecretsService(path.join(cmdHome(), "secrets.json")), stateDir: cmdHome() });
  const write = async (c: JournalCase): Promise<WrittenDay> => {
    const ctx = buildContext({ purpose: "journal.day", budget: 160_000, parts: [{ name: "day", text: `<day>\n${c.digest}\n</day>` }] });
    if (ai) return (await ai.object<WrittenDay>({ tier: "smart", purpose: "journal.eval", system, prompt: ctx.text, schema: SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: 6000, model: a.model })).value;
    const out = execFileSync("claude", ["-p", "--model", a.model ?? "sonnet"], { input: `${system}\n\nAnswer with only a JSON object matching this schema, no prose:\n${JSON.stringify(SCHEMA)}\n\n${ctx.text}`, encoding: "utf8", maxBuffer: 1 << 24 });
    return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as WrittenDay;
  };
  const scores: number[] = [];
  for (const c of cases) {
    for (let i = 0; i < repeat; i++) {
      const t0 = Date.now();
      try {
        const s = scoreDay(c, await write(c));
        scores.push(s.score);
        console.log(`${c.name}${repeat > 1 ? ` #${i + 1}` : ""}: ${s.score.toFixed(3)} (${((Date.now() - t0) / 1000).toFixed(0)} s)  ${Object.entries(s.checks).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(" · ")}`);
        for (const p of s.problems.slice(0, 6)) console.log(`    - ${p}`);
      } catch (err) {
        scores.push(0);
        console.log(`${c.name}: failed (${(err as Error).message})`);
      }
    }
  }
  console.log(`\nmean ${(scores.reduce((x, y) => x + y, 0) / (scores.length || 1)).toFixed(3)} over ${scores.length} run${scores.length === 1 ? "" : "s"}`);
} else {
  console.error("usage: node scripts/evals/journal.ts corpus|run (see the top of the file)");
  process.exit(2);
}
