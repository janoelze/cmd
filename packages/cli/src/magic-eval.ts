// `cmd magic eval`: run the Magic eval cases (packages/core/src/magic/evals/
// cases.json) against one or more prompt variants, screenshot every widget, and
// write a side-by-side report (report.html) plus a summary on stderr. Each run
// is an ordinary run folder, so `cmd magic view` re-renders it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cmdHome } from "@cmd/protocol/node";
import { runMagic, type MagicEvent, type MagicResult } from "@cmd/core/magic";
import { loadThemes, pickBackend, shoot, writeRun, type RenderCheck } from "./magic.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const CASES = path.resolve(here, "../../core/src/magic/evals/cases.json");

interface Case {
  id: string;
  prompt: string;
  expect: { route?: string; kind?: string; source?: "fetch" | "command" | null; explores?: boolean };
  tags: string[];
}

interface Outcome {
  caseId: string;
  variant: string;
  rep: number;
  dir: string;
  pass: boolean;
  problems: string[];
  warnings: string[];
  title: string | null;
  kind: string | null;
  ms: number;
  steps: number;
  costUSD: number;
  tokens: number;
}

export const EVAL_HELP = `cmd magic eval — run the eval cases against prompt variants

usage: cmd magic eval [CASE…] [options]

  --variant NAME=FILE   a prompt variant (repeatable; default: base=prompt/prompt.md)
  --tag T               only cases with this tag (fast, portable, local)
  --repeat N            runs per case and variant (default 1)
  -j N                  runs in parallel (default 3)
  --provider/--model/--effort  as for cmd magic
  --unsandboxed         as for cmd magic
  --out DIR             default $CMD_HOME/magic/evals/<time>

Every run costs model tokens (fast-path cases don't).`;

function judge(c: Case, r: MagicResult, render: RenderCheck | null, lint: { literalColors: string[]; externalResources: string[] } | null): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const e = c.expect;
  if (!r.ok) problems.push(...r.errors.map((x) => x.split("\n")[0]!));
  if (e.route && r.route !== e.route) problems.push(`route ${r.route}, expected ${e.route}`);
  if (e.kind && r.header?.kind !== e.kind) problems.push(`kind ${r.header?.kind ?? "none"}, expected ${e.kind}`);
  if (e.source !== undefined && r.header?.kind === "widget") {
    const got = r.header.source?.type ?? null;
    if (got !== e.source) problems.push(`source ${got ?? "none"}, expected ${e.source ?? "none"}`);
  }
  const explored = r.trace.some((s) => ["run", "read", "list"].includes(s.tool));
  if (e.explores === true && !explored) problems.push("didn't look around");
  if (e.explores === false && explored) warnings.push("looked around without need");
  if (render) {
    for (const x of render.errors) problems.push(`script error: ${x}`);
    if (render.empty) problems.push("draws nothing");
    if (render.overflow) warnings.push("overflows");
    if (render.small?.overflowX) problems.push("overflows sideways when small (240×150)");
    if (render.small?.overflowY) warnings.push("taller than a small window (240×150)");
    if (render.small?.empty) problems.push("draws nothing when small");
  }
  if (lint?.literalColors.length) problems.push(`literal colours: ${lint.literalColors.join(" ")}`);
  if (lint?.externalResources.length) problems.push(`external resources: ${lint.externalResources.join(" ")}`);
  if (r.repairs.length) warnings.push(`${r.repairs.length} repair`);
  return { problems, warnings };
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

export async function evalCommand(argv: string[]): Promise<number> {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      variant: { type: "string", multiple: true },
      tag: { type: "string" },
      repeat: { type: "string" },
      j: { type: "string", short: "j" },
      provider: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      unsandboxed: { type: "boolean" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (o.help) {
    console.log(EVAL_HELP);
    return 0;
  }
  const all = JSON.parse(fs.readFileSync(CASES, "utf8")) as Case[];
  const cases = all.filter((c) => (!positionals.length || positionals.includes(c.id)) && (!o.tag || c.tags.includes(o.tag)));
  if (!cases.length) {
    console.error(`no cases match (have: ${all.map((c) => c.id).join(", ")})`);
    return 1;
  }
  const variants = (o.variant?.length ? o.variant : ["base="]).map((v) => {
    const [name, file] = v.split("=", 2);
    return { name: name!, file: file ? path.resolve(file) : undefined };
  });
  const repeat = Math.max(1, Number(o.repeat ?? 1));
  const out = path.resolve(o.out ?? path.join(cmdHome(), "magic", "evals", new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")));
  const themes = await loadThemes();
  const shotThemes = [themes.get("dark")!, themes.get("light")!];
  const backend = pickBackend({ provider: o.provider, model: o.model, effort: o.effort });
  const unsandboxed = o.unsandboxed || process.env.CMD_MAGIC_UNSANDBOXED === "1";

  const jobs = variants.flatMap((v) => cases.flatMap((c) => Array.from({ length: repeat }, (_, rep) => ({ v, c, rep }))));
  process.stderr.write(`eval: ${cases.length} cases × ${variants.length} variants × ${repeat} = ${jobs.length} runs · ${backend.name} ${backend.model} → ${out}\n`);
  const outcomes: Outcome[] = [];
  await pool(jobs, Number(o.j ?? 3), async ({ v, c, rep }) => {
    const dir = path.join(out, v.name, repeat > 1 ? `${c.id}-${rep + 1}` : c.id);
    const events: MagicEvent[] = [];
    let r: MagicResult;
    try {
      r = await runMagic({ prompt: c.prompt, backend, cwd: process.cwd(), sandbox: unsandboxed ? "off" : "required", systemFile: v.file, onEvent: (e) => events.push(e) });
    } catch (e) {
      const msg = (e as Error).message;
      outcomes.push({ caseId: c.id, variant: v.name, rep, dir, pass: false, problems: [`crashed: ${msg}`], warnings: [], title: null, kind: null, ms: 0, steps: 0, costUSD: 0, tokens: 0 });
      process.stderr.write(`  ✗ ${v.name}/${c.id}: ${msg}\n`);
      return;
    }
    writeRun(dir, r, { prompt: c.prompt, variant: v.name, system: v.file ?? null, case: c }, events, shotThemes[0]!);
    const render = await shoot(dir, r, shotThemes).catch((e: Error) => ({ errors: [`screenshot failed: ${e.message}`], empty: false, overflow: false, shots: [] }));
    const metrics = JSON.parse(fs.readFileSync(path.join(dir, "metrics.json"), "utf8"));
    const { problems, warnings } = judge(c, r, render, metrics.lint);
    const u = r.usage;
    const outcome: Outcome = {
      caseId: c.id, variant: v.name, rep, dir, pass: !problems.length, problems, warnings,
      title: r.header?.title ?? null, kind: r.header?.kind ?? r.route, ms: r.timings.done, steps: r.trace.length,
      costUSD: u.costUSD ?? 0, tokens: u.input + u.cacheRead + u.cacheWrite + u.output,
    };
    outcomes.push(outcome);
    fs.writeFileSync(path.join(dir, "outcome.json"), JSON.stringify(outcome, null, 2) + "\n");
    process.stderr.write(`  ${outcome.pass ? "✓" : "✗"} ${v.name}/${c.id}${repeat > 1 ? `#${rep + 1}` : ""} ${(r.timings.done / 1000).toFixed(1)}s ${r.trace.length} steps${problems.length ? " — " + problems.join("; ") : ""}${warnings.length ? ` (${warnings.join(", ")})` : ""}\n`);
  });

  fs.writeFileSync(path.join(out, "outcomes.json"), JSON.stringify(outcomes, null, 2) + "\n");
  fs.writeFileSync(path.join(out, "report.html"), report(cases, variants.map((v) => v.name), outcomes, out, backend.model));
  process.stderr.write("\n");
  for (const v of variants) {
    const mine = outcomes.filter((x) => x.variant === v.name);
    const pass = mine.filter((x) => x.pass).length;
    const med = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
    const cost = mine.reduce((s, x) => s + x.costUSD, 0);
    process.stderr.write(`${v.name}: ${pass}/${mine.length} pass · median ${(med(mine.map((x) => x.ms)) / 1000).toFixed(1)}s · ${med(mine.map((x) => x.steps))} steps · $${cost.toFixed(2)}\n`);
  }
  console.log(path.join(out, "report.html"));
  return outcomes.every((x) => x.pass) ? 0 : 1;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function report(cases: Case[], variants: string[], outcomes: Outcome[], root: string, model: string): string {
  const cell = (x: Outcome | undefined) => {
    if (!x) return "<td></td>";
    const rel = path.relative(root, x.dir);
    const shot = fs.existsSync(path.join(x.dir, "dark.png"))
      ? `<a href="${esc(rel)}/widget.html"><img src="${esc(rel)}/dark.png"><img src="${esc(rel)}/light.png"></a>`
      : x.kind === "terminal"
        ? `<pre>${esc(fs.existsSync(path.join(x.dir, "answer.txt")) ? (JSON.parse(fs.readFileSync(path.join(x.dir, "metrics.json"), "utf8")).command ?? "") : "")}</pre>`
        : "";
    return `<td class="${x.pass ? "pass" : "fail"}">
      <div class="head"><b>${x.pass ? "✓" : "✗"} ${esc(x.title ?? x.kind ?? "")}</b> <span>${esc(x.kind ?? "")}</span></div>
      ${shot}
      <div class="meta">${(x.ms / 1000).toFixed(1)}s · ${x.steps} steps · ${(x.tokens / 1000).toFixed(1)}k tok${x.costUSD ? ` · $${x.costUSD.toFixed(3)}` : ""} · <a href="${esc(rel)}/trace.json">trace</a> · <a href="${esc(rel)}/answer.txt">answer</a></div>
      ${x.problems.map((p) => `<div class="bad">${esc(p)}</div>`).join("")}${x.warnings.map((p) => `<div class="warn">${esc(p)}</div>`).join("")}
    </td>`;
  };
  const rows = cases
    .flatMap((c) => {
      const reps = Math.max(1, ...outcomes.filter((x) => x.caseId === c.id).map((x) => x.rep + 1));
      return Array.from({ length: reps }, (_, rep) =>
        `<tr><th><b>${esc(c.id)}</b>${reps > 1 ? ` #${rep + 1}` : ""}<div>${esc(c.prompt.slice(0, 120))}</div><div class="exp">${esc(JSON.stringify(c.expect))}</div></th>${variants
          .map((v) => cell(outcomes.find((x) => x.caseId === c.id && x.variant === v && x.rep === rep)))
          .join("")}</tr>`,
      );
    })
    .join("\n");
  const summary = variants
    .map((v) => {
      const mine = outcomes.filter((x) => x.variant === v);
      return `<th>${esc(v)}<div>${mine.filter((x) => x.pass).length}/${mine.length} pass · $${mine.reduce((s, x) => s + x.costUSD, 0).toFixed(2)}</div></th>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Magic eval</title><style>
:root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 15%, transparent); }
body { font: 13px -apple-system, sans-serif; margin: 20px; }
table { border-collapse: collapse; } th, td { border: 1px solid var(--line); padding: 8px; vertical-align: top; text-align: left; }
thead th div, th div { font-weight: normal; opacity: .7; max-width: 220px; } .exp { font: 11px ui-monospace, monospace; overflow-wrap: anywhere; }
td img { width: 240px; display: block; margin: 4px 0; border: 1px solid var(--line); border-radius: 6px; }
td .head span, .meta { opacity: .65; font-size: 11px; } .bad { color: #d33; font-size: 11px; } .warn { color: #b80; font-size: 11px; }
td.fail { background: color-mix(in srgb, #d33 6%, transparent); } pre { white-space: pre-wrap; max-width: 240px; }
</style></head><body><h3>Magic eval · ${esc(model)} · ${new Date().toLocaleString()}</h3>
<table><thead><tr><th>case</th>${summary}</tr></thead><tbody>${rows}</tbody></table></body></html>`;
}
