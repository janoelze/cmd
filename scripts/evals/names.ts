// Name evals (docs/32-session-names.md, "Measuring it"): build cases from real
// sessions in cmd's copy of the transcripts, replay each through the namer turn
// by turn as the live core would (core/src/agents/names-eval.ts), and score the
// names: the hand-named sessions in docs/32's table, renames per session, what
// it costs in model calls.
//
//   node scripts/evals/names.ts corpus --data <copy of $CMD_HOME/data> [--days 14] [--min-turns 2] [--out DIR]
//   node scripts/evals/names.ts run [--cases DIR] [--only ID,…] [--model M] [--claude] [--dry] [--verbose]
//
// `corpus` writes one case per session (prompts redacted, home folder as ~) to
// $CMD_HOME/evals/names, out of the repo; sessions whose agent title is in
// docs/32's table get that table's name as their expectation. `run` names each
// case with the fast tier of the AI provider in Settings, or `claude -p` with
// --claude, or answers nothing with --dry (to see when it would ask). Real
// sessions go to a model only when the person says so.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_SETTINGS } from "../../packages/protocol/src/index.ts";
import { cmdHome } from "../../packages/protocol/src/node.ts";
import { AiService } from "../../packages/core/src/ai/service.ts";
import { DataService } from "../../packages/core/src/data/service.ts";
import { conversationOf } from "../../packages/core/src/data/views/conversation.ts";
import { SessionsView } from "../../packages/core/src/data/views/sessions.ts";
import { ViewsStore } from "../../packages/core/src/data/views/views.ts";
import { SecretsService } from "../../packages/core/src/secrets.ts";
import { cleanClaudePrompt } from "../../packages/core/src/search/parser.ts";
import { redact } from "../../packages/core/src/redact.ts";
import { NAME_SCHEMA, nameSystem, type NamerAnswer, type NamerTurn } from "../../packages/core/src/agents/namer.ts";
import { askText, replay, scoreCase, summarize, type Ask, type NameCase } from "../../packages/core/src/agents/names-eval.ts";

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: { data: { type: "string" }, days: { type: "string" }, "min-turns": { type: "string" }, out: { type: "string" }, cases: { type: "string" }, only: { type: "string" }, model: { type: "string" }, claude: { type: "boolean" }, dry: { type: "boolean" }, verbose: { type: "boolean" } },
});
const casesDir = a.out ?? a.cases ?? path.join(cmdHome(), "evals", "names");
const tilde = (s: string) => s.split(os.homedir()).join("~");

/** docs/32's table: the agent's own title → the names a person would accept (null: none). */
const HAND: Record<string, string[] | null> = {
  "Data model changes and agent sessions": ["Session names", "Data model"],
  "Marketing videos and UI accessibility survey": ["Tours"],
  "Workspace-übergreifende notifications": ["Notify permission", "Notification permission"],
  "Navigator recent agent sessions filtering": ["Recent by Space", "Recent sessions"],
  "Magic widgets status indicator refactoring": ["Widget status lights", "Widget status"],
  "Latest prod update doesn't start": ["Broken update", "Update startup"],
  "Icon sizing audit and retina support": ["Icon sizes"],
  "Release CI pipeline performance": ["Slow release CI", "Release CI"],
  "Hack the planet SVG": ["Hack the planet"],
  "Read journalling and agent state data": ["Journal data"],
  "Remove gopher link from navigation": ["Gopher link"],
  "Widget Library close e2e test flaky": ["Flaky ⌘W test", "Widget Library test"],
  "Torrent search with multiple sources": ["Torrent search"],
  "Download production db with crawls": ["Crawl database", "Production database"],
  "Hooks werden aufgerufen ohne CMD": ["Hooks without cmd"],
  "JSON in notification": ["JSON in notification"],
  "Read files": null,
};

const WRITES = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|str_replace_based_edit_tool): (\S+)/;

/** A session's turns from cmd's copy of its transcript: each prompt, the files it wrote, the last answer. */
function turnsOf(data: DataService, key: string): NamerTurn[] {
  const turns: NamerTurn[] = [];
  for (const e of conversationOf(data, key)) {
    if (e.role === "user") {
      const p = cleanClaudePrompt(e.text).trim();
      // Injected messages (task notifications, command output, interruptions) aren't the person.
      if (!p || p.startsWith("<") || p.startsWith("[Request interrupted")) continue;
      turns.push({ at: e.at ?? turns.at(-1)?.at ?? 0, prompt: tilde(redact(p)).slice(0, 4000), files: [], final: null });
    } else if (turns.length && e.role === "tool") {
      const m = WRITES.exec(e.text);
      if (m) turns.at(-1)!.files.push(tilde(m[2]!));
    } else if (turns.length && e.role === "assistant") {
      turns.at(-1)!.final = tilde(redact(e.text)).slice(0, 1500);
    }
  }
  return turns;
}

if (positionals[0] === "corpus") {
  if (!a.data) throw new Error("corpus needs --data (a copy of $CMD_HOME/data)");
  const data = new DataService({ file: path.join(a.data, "events.sqlite"), recordedBy: "eval", settings: () => DEFAULT_SETTINGS });
  const sessions = new SessionsView(new ViewsStore(path.join(a.data, "views.sqlite")), data);
  // A view of an older version rebuilds in the background: wait for it.
  await sessions.rebuild();
  const since = Date.now() - Number(a.days ?? 14) * 86400_000;
  const min = Number(a["min-turns"] ?? 1);
  fs.mkdirSync(casesDir, { recursive: true });
  let n = 0;
  for (const s of sessions.sessionsSince(since)) {
    const turns = turnsOf(data, s.key);
    const hand = s.title && s.title in HAND ? HAND[s.title] : undefined;
    if (turns.length < min && hand === undefined) continue;
    const c: NameCase = { id: s.key, turns, ...(hand !== undefined ? { expect: hand ? { final: hand } : { none: true } } : {}) };
    fs.writeFileSync(path.join(casesDir, `${s.key.replace(/[^\w-]/g, "_")}.json`), JSON.stringify(c, null, 2));
    n++;
    console.log(`${s.key.slice(0, 20)}  ${String(turns.length).padStart(4)} turns  ${hand !== undefined ? "★ " : "  "}${(s.title ?? s.first_prompt ?? "").slice(0, 60)}`);
  }
  console.log(`\n${n} cases → ${casesDir}`);
} else if (positionals[0] === "run") {
  if (!fs.existsSync(casesDir)) throw new Error(`no cases in ${casesDir}: run corpus first`);
  const only = a.only ? new Set(a.only.split(",")) : null;
  const cases = fs.readdirSync(casesDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(casesDir, f), "utf8")) as NameCase).filter((c) => !only || [...only].some((o) => c.id.startsWith(o)));
  const system = nameSystem();
  const ai = a.claude || a.dry ? null : new AiService({ settings: () => DEFAULT_SETTINGS, secrets: new SecretsService(path.join(cmdHome(), "secrets.json")), stateDir: cmdHome() });
  const ask: Ask = async (input) => {
    if (a.dry) return null;
    const prompt = askText(input);
    try {
      if (ai) return (await ai.object<NamerAnswer>({ tier: "fast", purpose: "names.eval", system, prompt, schema: NAME_SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: 200, model: a.model })).value;
      const out = execFileSync("claude", ["-p", "--model", a.model ?? "haiku"], { input: `${system}\n\nAnswer with only a JSON object {"intent": "continue"|"develop"|"change", "name": string|null}, no prose.\n\n${prompt}`, encoding: "utf8", maxBuffer: 1 << 22, timeout: 90_000 });
      return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as NamerAnswer;
    } catch (err) {
      console.log(`    ! ${(err as Error).message.split("\n")[0]}`);
      return null;
    }
  };
  const scores = [];
  for (const c of cases) {
    const r = await replay(c, ask);
    const s = scoreCase(c, r);
    scores.push(s);
    const mark = s.match === null ? " " : s.match ? "✓" : "✗";
    console.log(`${mark} ${c.id.slice(0, 20)}  ${String(s.turns).padStart(4)} turns ${String(s.calls).padStart(3)} calls  ${s.names.join(" → ") || "(none)"}`);
    for (const i of s.issues.slice(0, 4)) console.log(`    - ${i}`);
    if (a.verbose) for (const st of r.steps.filter((x) => x.why)) console.log(`    ${st.turn + 1}: ${st.why} → ${st.answer ? `${st.answer.intent} ${st.answer.name ?? "-"}` : "no answer"} = ${st.name ?? "-"}`);
  }
  const sum = summarize(scores);
  console.log(`\n${sum.cases} sessions, ${sum.named} named; match ${sum.match === null ? "n/a" : sum.match.toFixed(2)} on the hand-named; renames mean ${sum.renames.mean.toFixed(2)}, max ${sum.renames.max}, ${sum.renames.over2} over 2; ${sum.callsPerTurn.toFixed(2)} calls per turn; ${sum.problems} rejected proposals`);
} else {
  console.error("usage: node scripts/evals/names.ts corpus|run (see the top of the file)");
  process.exit(2);
}
