// Jam evals (pnpm livecode eval): send requests through the AI change (core
// livecode/change.ts), query what the answers do in Strudel (headless Chromium,
// the same @strudel/web as the app), score that as music (core livecode/analyze.ts),
// optionally play them (--audio), and keep everything to listen to and rate.
//
//   refs                       measure Strudel's own tunes (the yardstick)
//   run [--case id] [--repeat N] [--system FILE] [--model M] [--effort E] [--label L] [--audio]
//   report [run]               scores per case, and where they sit among the references
//   rescore [run] [--audio]    score a run's saved answers again (after changing analyze.ts)
//   rate <run> <case> <1-10>   your ear; report compares it with the score
//   listen <run> <case>        open an answer as a Jam window in the running "cmd dev" app
//   show <run> <case>          print an answer's code
//   sound <code>               play one piece of code and print what the audio check hears
//
// Data lives in .cmd-dev/livecode/evals (gitignored). The reference tunes are
// Strudel's (CC BY-NC-SA, and its FAQ asks that tunes not be used for AI): they
// are only measured here, never committed and never sent to a model.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_SETTINGS } from "../../packages/protocol/src/index.ts";
import { AiService } from "../../packages/core/src/ai/service.ts";
import { SecretsService } from "../../packages/core/src/secrets.ts";
import { devKeys } from "../../packages/core/src/dev-keys.ts";
import { changeCode } from "../../packages/core/src/livecode/change.ts";
import { analyze, GENRES, score, type Features, type GenreName, type Score } from "../../packages/core/src/livecode/analyze.ts";
import { LIVECODE_STARTER } from "../../packages/core/src/windows/builtin.ts";
import { bpmOf, openStrudel, root, type Audio } from "./browser.ts";

const DIR = path.join(root, ".cmd-dev/livecode/evals");
const BARS = 16;

interface Case {
  id: string;
  request: string;
  genre: GenreName;
  start?: "starter";
}

interface Result {
  case: string;
  i: number;
  request: string;
  ms: number;
  summary?: string;
  error?: string;
  features?: Features;
  unknown?: string[];
  score?: Score;
  audio?: Audio;
  rating?: number;
}

export async function evalCommand(argv: string[]): Promise<void> {
  const { values: a, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { audio: { type: "boolean" }, case: { type: "string" }, repeat: { type: "string" }, system: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, label: { type: "string" } },
  });
  const cmd = positionals[0];
  fs.mkdirSync(DIR, { recursive: true });

  if (cmd === "refs") {
    const sources = ["website/src/repl/tunes.mjs", "website/src/examples.mjs", "test/testtunes.mjs"];
    const tunes: { name: string; code: string }[] = [];
    for (const src of sources) {
      const res = await fetch(`https://codeberg.org/uzu/strudel/raw/branch/main/${src}`);
      if (!res.ok) continue;
      const text = await res.text();
      for (const m of text.matchAll(/export const (\w+) = `([\s\S]*?)`;/g)) tunes.push({ name: m[1]!, code: m[2]!.replace(/\\`/g, "`") });
    }
    console.log(`${tunes.length} tunes`);
    const s = await openStrudel();
    const out: { name: string; features: Features }[] = [];
    for (const t of tunes) {
      const r = await s.run(t.code, BARS).catch((e: Error) => ({ error: e.message, events: [], unknown: [] }));
      if (r.error || !r.events.length) {
        console.log(`  ✗ ${t.name}: ${r.error ?? "no events"}`.slice(0, 120));
        continue;
      }
      out.push({ name: t.name, features: analyze(r.events, BARS, bpmOf(t.code)) });
      console.log(`  ✓ ${t.name}`);
    }
    await s.close();
    fs.writeFileSync(path.join(DIR, "refs.json"), JSON.stringify(out, null, 1));
    console.log(`${out.length} measured → ${path.relative(root, path.join(DIR, "refs.json"))}`);
  } else if (cmd === "run") {
    const cases = (JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "cases.json"), "utf8")) as Case[]).filter((c) => !a.case || c.id === a.case);
    const repeat = Number(a.repeat ?? 1);
    const system = a.system ? fs.readFileSync(a.system, "utf8") : undefined;
    const run = `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}${a.label ? "-" + a.label : ""}`;
    const runDir = path.join(DIR, "runs", run);
    fs.mkdirSync(runDir, { recursive: true });
    const ai = new AiService({ settings: () => DEFAULT_SETTINGS, secrets: new SecretsService(null, devKeys(root)), stateDir: DIR });
    const s = await openStrudel();
    const sounds = await s.sounds();
    const results: Result[] = [];
    for (const c of cases)
      for (let i = 0; i < repeat; i++) {
        const t0 = Date.now();
        const base: Result = { case: c.id, i, request: c.request, ms: 0 };
        try {
          const answer = await changeCode((o) => ai.object(o), { code: c.start === "starter" ? LIVECODE_STARTER : "", request: c.request, sounds }, { system, model: a.model, effort: a.effort as never });
          base.ms = Date.now() - t0;
          base.summary = answer.summary;
          fs.writeFileSync(path.join(runDir, `${c.id}.${i}.strudel`), answer.code);
          const r = await s.run(answer.code, BARS);
          if (r.error) base.error = r.error;
          else {
            const genre = GENRES[c.genre];
            base.features = analyze(r.events, BARS, bpmOf(answer.code), genre);
            base.unknown = r.unknown;
            base.score = score(base.features, genre, r.unknown.length);
            // Play it too: a part that makes no sound is a bug the events can't show.
            if (a.audio) base.audio = await s.audio(answer.code);
          }
        } catch (e) {
          base.ms = Date.now() - t0;
          base.error = (e as Error).message;
        }
        results.push(base);
        const heard = base.audio ? `  [audio: peak ${base.audio.peak}, lows ${Math.round(100 * base.audio.lows)}%${base.audio.silent.length ? `, SILENT ${base.audio.silent.join(" ")}` : ""}]` : "";
        console.log(`${base.score ? String(base.score.total).padStart(3) : "  ✗"}  ${c.id}.${i}  ${(base.ms / 1000).toFixed(1)} s  ${base.error ?? base.score!.checks.filter((x) => x.score < 0.999).map((x) => `${x.name}: ${x.note}`).join(" · ")}${heard}`);
      }
    await s.close();
    fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify(results, null, 1));
    const scored = results.filter((r) => r.score);
    console.log(`\n${run}: mean ${(scored.reduce((x, r) => x + r.score!.total, 0) / Math.max(1, scored.length)).toFixed(1)} over ${scored.length}/${results.length} (${results.length - scored.length} failed)`);
  } else if (cmd === "report") {
    const runs = fs.readdirSync(path.join(DIR, "runs")).sort();
    const run = positionals[1] ?? runs.at(-1)!;
    const results = JSON.parse(fs.readFileSync(path.join(DIR, "runs", run, "results.json"), "utf8")) as Result[];
    const refs = fs.existsSync(path.join(DIR, "refs.json")) ? (JSON.parse(fs.readFileSync(path.join(DIR, "refs.json"), "utf8")) as { features: Features }[]) : [];
    const pct = (key: keyof Features, x: number) => {
      const xs = refs.map((r) => r.features[key]).filter((v): v is number => typeof v === "number");
      return xs.length ? Math.round((100 * xs.filter((v) => v <= x).length) / xs.length) : null;
    };
    console.log(`${run}\n`);
    for (const r of results) {
      if (!r.features) {
        console.log(`  ✗ ${r.case}.${r.i}: ${r.error}`);
        continue;
      }
      const f = r.features;
      const where = (["parts", "density", "variety", "sectionChanges", "chordSize"] as const).map((k) => `${k} ${typeof f[k] === "number" ? (f[k] as number).toFixed(2) : f[k]} (p${pct(k, f[k] as number) ?? "-"})`).join("  ");
      console.log(`${String(r.score!.total).padStart(3)}${r.rating !== undefined ? ` ear ${r.rating}` : ""}  ${r.case}.${r.i}  ${where}`);
    }
    if (refs.length) {
      const med = (k: keyof Features) => {
        const xs = refs.map((r) => r.features[k]).filter((v): v is number => typeof v === "number").sort((x, y) => x - y);
        return xs[Math.floor(xs.length / 2)]?.toFixed(2);
      };
      console.log(`\nreferences (${refs.length} tunes), medians: parts ${med("parts")}, density ${med("density")}, variety ${med("variety")}, sectionChanges ${med("sectionChanges")}, chordSize ${med("chordSize")}`);
    }
    const rated = results.filter((r) => r.rating !== undefined && r.score);
    if (rated.length >= 3) {
      const xs = rated.map((r) => r.score!.total), ys = rated.map((r) => r.rating!);
      const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
      const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0);
      const r = cov / Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
      console.log(`\nscore vs your ear: r = ${r.toFixed(2)} over ${rated.length} ratings`);
    }
  } else if (cmd === "rescore") {
    const run = positionals[1] ?? fs.readdirSync(path.join(DIR, "runs")).sort().at(-1)!;
    const file = path.join(DIR, "runs", run, "results.json");
    const results = JSON.parse(fs.readFileSync(file, "utf8")) as Result[];
    const cases = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "cases.json"), "utf8")) as Case[];
    const s = await openStrudel();
    for (const r of results) {
      const code = path.join(DIR, "runs", run, `${r.case}.${r.i}.strudel`);
      if (!fs.existsSync(code)) continue;
      const text = fs.readFileSync(code, "utf8");
      const out = await s.run(text, BARS);
      if (out.error) continue;
      const genre = GENRES[cases.find((c) => c.id === r.case)?.genre ?? "any"];
      r.features = analyze(out.events, BARS, bpmOf(text), genre);
      r.unknown = out.unknown;
      r.score = score(r.features, genre, out.unknown.length);
      if (a.audio) r.audio = await s.audio(text);
      const heard = r.audio ? `  [audio: peak ${r.audio.peak}, lows ${Math.round(100 * r.audio.lows)}%${r.audio.silent.length ? `, SILENT ${r.audio.silent.join(" ")}` : ""}]` : "";
      console.log(`${String(r.score.total).padStart(3)}  ${r.case}.${r.i}  ${r.score.checks.filter((x) => x.score < 0.999).map((x) => `${x.name}: ${x.note}`).join(" · ")}${heard}`);
    }
    await s.close();
    fs.writeFileSync(file, JSON.stringify(results, null, 1));
    const scored = results.filter((r) => r.score);
    console.log(`\n${run}: mean ${(scored.reduce((x, r) => x + r.score!.total, 0) / Math.max(1, scored.length)).toFixed(1)}`);
  } else if (cmd === "rate") {
    const [, run, id, n] = positionals;
    const file = path.join(DIR, "runs", run!, "results.json");
    const results = JSON.parse(fs.readFileSync(file, "utf8")) as Result[];
    const [c, i] = id!.split(".");
    const r = results.find((x) => x.case === c && x.i === Number(i ?? 0));
    if (!r) throw new Error(`no ${id} in ${run}`);
    r.rating = Number(n);
    fs.writeFileSync(file, JSON.stringify(results, null, 1));
    console.log(`${id}: ${n}/10`);
  } else if (cmd === "listen") {
    const [, run, id] = positionals;
    const code = fs.readFileSync(path.join(DIR, "runs", run!, `${id!.includes(".") ? id : id + ".0"}.strudel`), "utf8");
    // The dev app's core (not this checkout's CMD_HOME): where you listen.
    const { connect } = await import("../../packages/protocol/src/node.ts");
    const { enterInstance, coreSocketPath } = await import("../../packages/protocol/src/instance.ts");
    delete process.env.CMD_HOME;
    enterInstance("dev");
    const { client, close } = await connect(process.env.CMD_SOCKET || coreSocketPath());
    const w = await client.call("window.open", { kind: "livecode", input: { code } });
    console.log(`opened ${id} in cmd dev (${w.id}): press Play, then rate it: pnpm livecode eval rate ${run} ${id} <1-10>`);
    close();
  } else if (cmd === "sound") {
    // Debugging the audio check: play one piece of code and print what it heard.
    const s = await openStrudel();
    const errors: string[] = [];
    console.log(JSON.stringify(await s.audio(positionals[1]!), null, 1), errors);
    await s.close();
  } else if (cmd === "show") {
    const [, run, id] = positionals;
    console.log(fs.readFileSync(path.join(DIR, "runs", run!, `${id!.includes(".") ? id : id + ".0"}.strudel`), "utf8"));
  } else {
    console.log("usage: pnpm livecode eval refs | run [--case id] [--repeat N] [--system FILE] [--model M] [--effort E] [--label L] [--audio] | report [run] | rescore [run] [--audio] | rate <run> <case> <1-10> | listen <run> <case> | show <run> <case> | sound <code>");
  }
}
