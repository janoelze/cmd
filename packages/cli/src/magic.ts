// `cmd magic`: make a widget package from a request (docs/56, "Magic on V3"). In a cmd
// terminal the app makes it (magic-app.ts: a Magic window beside, its steps here, the grants
// sheet there); elsewhere, or with --lab, the prompt lab builds it in this process (no core
// needed), printing the agent's steps, into a package folder you can check and change with
// `cmd widget`. The system prompt is read from packages/core/src/magic/prompt/ on every
// run, so edits apply immediately.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_SETTINGS, isAiProvider, parseJsonc, resolveSettings, type Settings, type WidgetPermissions } from "@cmd/protocol";
import { cmdHome, configDir } from "@cmd/protocol/node";
import { connect } from "@cmd/protocol/node";
import {
  AiService,
  buildPackage,
  checkoutToolchain,
  findDeno,
  playwrightPreviewer,
  SecretsService,
  sandboxAvailable,
  slugOf,
  wantsText,
  WidgetStore,
  type Backend,
  type BuildEvent,
  type BuildResult,
  type PackageBuildResult,
  type VerifyContext,
} from "@cmd/core/magic";

export const MAGIC_HELP = `cmd magic — make a widget package (or a terminal command) from a request

usage: cmd magic <request…> [options]
       cmd magic eval [case…]        run the eval cases against the prompt (see --help)
       cmd widget …                  check, link and add a widget package (cmd widget --help)

In a cmd terminal the app makes it: a Magic window opens beside you, asks for what
the widget wants, and becomes the widget; the package's folder is printed. Elsewhere
(or with --lab) it is built here, into --out.

  --provider P      anthropic | openai (default: ai.provider in your settings)
  --model M         default: that provider's model (ai.<provider>.model; auto picks the newest)
  --effort E        low | medium | high, for models that take it (default low)
  --system FILE     use FILE instead of prompt/prompt.md (prompt variants)
  --no-explore      don't let the agent look around this Mac
  --max-steps N     tool calls in the first turn (default 40)
  --lab             build here, not in the app
  --out DIR         the package folder (default $CMD_HOME/magic/runs/<time>-<request>/<name>)
  --decline         the lab declines what the package asks for (it allows it otherwise)
  --open            open the preview screenshot
  --json            print events as NDJSON instead of the trace
  --unsandboxed     run commands without sandbox-exec (only the policy and Deno's permissions guard them)

The API key is the one stored in Settings → AI (or with
\`cmd settings secret KEY\`); nothing is read from the environment.

env: CMD_MAGIC_UNSANDBOXED=1`;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "run";
export const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

/** The user's settings file as the core would read it (the prompt lab runs without a core). */
export function userSettings(): Settings {
  try {
    return resolveSettings(parseJsonc(fs.readFileSync(path.join(configDir(), "settings.json"), "utf8")) as Record<string, unknown>).settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** The provider, model and stored key the app would use; --provider and --model override the first two. */
export function pickBackend(o: { provider?: string; model?: string; effort?: string }): Backend {
  const s = userSettings();
  if (o.provider && !isAiProvider(o.provider)) throw new Error(`--provider: expected anthropic or openai`);
  const effort = o.effort === "low" || o.effort === "medium" || o.effort === "high" ? o.effort : undefined;
  if (o.effort && !effort) throw new Error(`--effort: expected low, medium or high`);
  // The core's model lists (ai-models.json) resolve Auto the way the app does.
  const ai = new AiService({ settings: () => s, secrets: new SecretsService(path.join(cmdHome(), "secrets.json")), stateDir: cmdHome() });
  return ai.backend({ tier: "smart", purpose: "magic.lab", provider: o.provider as never, model: o.model, effort });
}

/** A widget folder (anywhere) as a store entry, with Deno and a previewer, the way the core checks widgets. */
export async function widgetContext(dir: string, o: { unsandboxed?: boolean; config?: Record<string, unknown>; cwd?: string; preview?: boolean } = {}): Promise<VerifyContext> {
  const abs = path.resolve(dir);
  const unsandboxed = o.unsandboxed || process.env.CMD_MAGIC_UNSANDBOXED === "1";
  const deno = findDeno({ setting: userSettings()["magic.deno"], stateDir: cmdHome() });
  return {
    store: new WidgetStore(path.dirname(abs)),
    id: path.basename(abs),
    deno: deno ? { deno, denoDir: path.join(cmdHome(), "runtime", "deno-cache"), sandbox: unsandboxed ? "off" : "required" } : null,
    previewer: o.preview === false ? null : await playwrightPreviewer(),
    cwd: o.cwd ?? process.cwd(),
    config: o.config,
  };
}

export function sandboxNote(unsandboxed: boolean): void {
  if (!unsandboxed && !sandboxAvailable()) process.stderr.write(dim("  note: sandbox-exec is unavailable here (inside another sandbox?), so commands and data.ts won't run; use --unsandboxed to rely on the policy and Deno's permissions alone\n"));
}

// ── trace printing ──────────────────────────────────────

const tty = process.stderr.isTTY;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = c("2");
export const green = c("32");
export const red = c("31");
export const yellow = c("33");
export const bold = c("1");
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function describeInput(tool: string, input: Record<string, unknown>): string {
  const v = input.command ?? input.path ?? input.url ?? "";
  const s = typeof v === "string" ? v : "";
  return `${tool === "run" ? "" : tool + " "}${s}`.replace(/\s+/g, " ").slice(0, 70);
}

function printer(): (e: BuildEvent) => void {
  const starts = new Map<number, { why: string; detail: string }>();
  return (e) => {
    switch (e.type) {
      case "route":
        if (e.route !== "agent") process.stderr.write(dim(`  fast path: ${e.route}\n`));
        break;
      case "step-start":
        starts.set(e.id, { why: e.why, detail: describeInput(e.tool, e.input) });
        break;
      case "step-end": {
        const s = starts.get(e.id)!;
        const mark = e.isError ? red("✗") : green("✓");
        const first = e.isError ? "  " + red(e.output.split("\n")[0]!.slice(0, 110)) : "";
        process.stderr.write(`  ${mark} ${s.why.padEnd(34).slice(0, 34)} ${dim(s.detail)} ${dim(secs(e.ms))}${first ? "\n   " + first : ""}\n`);
        break;
      }
      case "title":
        process.stderr.write(`  ${bold("▸")} ${e.title}\n`);
        break;
      case "verify":
        process.stderr.write(dim("  cmd checks the widget…\n"));
        break;
      case "repair":
        process.stderr.write(`  ${red("↻")} ${dim(e.reason.split("\n")[0]!.slice(0, 110))}\n`);
        break;
    }
  };
}

/** The verdict as lines on stderr; returns whether it passed. */
export function printVerdict(v: BuildResult["verdict"]): boolean {
  if (v.ok) process.stderr.write(`  ${green("✓")} checks passed${v.warnings.length ? dim(` (${v.warnings.length} warning${v.warnings.length > 1 ? "s" : ""})`) : ""}\n`);
  else process.stderr.write(`  ${v.usable ? yellow("!") : red("✗")} ${v.usable ? "renders, but" : "doesn't work:"}\n`);
  for (const p of v.problems) process.stderr.write(red(`    ${p.split("\n")[0]!.slice(0, 200)}\n`));
  for (const w of v.warnings) process.stderr.write(dim(`    ${w.split("\n")[0]!.slice(0, 200)}\n`));
  return v.ok;
}

// ── command ─────────────────────────────────────────────

export async function magicCommand(argv: string[]): Promise<number> {
  if (argv[0] === "eval") return (await import("./magic-eval.ts")).evalCommand(argv.slice(1));
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      system: { type: "string" },
      "no-explore": { type: "boolean" },
      "max-steps": { type: "string" },
      out: { type: "string" },
      lab: { type: "boolean" },
      decline: { type: "boolean" },
      open: { type: "boolean" },
      json: { type: "boolean" },
      unsandboxed: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const prompt = positionals.join(" ").trim();
  if (o.help || !prompt) {
    console.log(MAGIC_HELP);
    return prompt || o.help ? 0 : 1;
  }
  // In a cmd terminal, the app makes it (a window, its steps, the grants sheet), unless asked for the lab.
  if (!o.lab && !o.out && !o.system && process.env.CMD_PANE_ID) {
    const conn = await connect().catch(() => null);
    if (conn) {
      try {
        return await (await import("./magic-app.ts")).magicInApp(conn.client, prompt, { json: !!o.json });
      } finally {
        conn.close();
      }
    }
  }
  const unsandboxed = !!o.unsandboxed || process.env.CMD_MAGIC_UNSANDBOXED === "1";
  sandboxNote(unsandboxed);
  let backend: Backend;
  try {
    backend = pickBackend({ provider: o.provider, model: o.model, effort: o.effort });
  } catch (e) {
    process.stderr.write(red(`  ✗ ${(e as Error).message}\n`));
    return 1;
  }
  const name = slugOf(prompt);
  const dir = path.resolve(o.out ?? path.join(cmdHome(), "magic", "runs", `${stamp()}-${slug(prompt)}`, name));
  const toolchain = checkoutToolchain();
  if (!toolchain) process.stderr.write(red("  ✗ this cmd has no TypeScript and Vitest to check packages with (a checkout's pnpm install has)\n"));
  const previewer = await playwrightPreviewer();
  if (!previewer) process.stderr.write(dim("  note: Playwright isn't available, so widgets aren't drawn\n"));

  const events: BuildEvent[] = [];
  const print = o.json ? (e: BuildEvent) => console.log(JSON.stringify(e)) : printer();
  const ac = new AbortController();
  process.once("SIGINT", () => ac.abort());
  if (!o.json) process.stderr.write(`${bold("✦")} ${prompt} ${dim(`· ${backend.name} ${backend.model}`)}\n`);
  let r: PackageBuildResult;
  let granted: WidgetPermissions | null = null;
  try {
    r = await buildPackage({
      prompt,
      backend,
      dir,
      name: path.basename(dir),
      cwd: process.cwd(),
      // Run from a project folder, it is the workspace, as a window's workspace is in the app.
      workspace: process.cwd() !== os.homedir() ? { name: path.basename(process.cwd()), root: process.cwd() } : null,
      explore: !o["no-explore"],
      maxSteps: o["max-steps"] ? Number(o["max-steps"]) : undefined,
      maxTokens: userSettings()["magic.maxTokens"] || undefined,
      sandbox: unsandboxed ? "off" : "required",
      systemFile: o.system ? path.resolve(o.system) : undefined,
      toolchain,
      previewer: async () => previewer,
      // The lab is the person at the terminal: what the package asks for is allowed (in the app, the grants sheet asks).
      ask: async (pkg) => {
        const allow = !o.decline;
        if (!o.json) process.stderr.write(`  ${allow ? green("✓") : red("✗")} ${wantsText(pkg.permissions)} ${dim(allow ? "(allowed: the app asks the person)" : "(--decline)")}\n`);
        if (allow) granted = pkg.permissions;
        return { allow };
      },
      granted: () => granted,
      signal: ac.signal,
      onEvent: (e) => {
        events.push(e);
        print(e);
      },
    });
  } catch (e) {
    process.stderr.write(red(`  ✗ ${(e as Error).message}\n`));
    return 1;
  }
  const runDir = path.dirname(dir);
  writeRun(runDir, r, { prompt, provider: backend.name, model: backend.model, effort: o.effort ?? null, system: o.system ?? null, explore: !o["no-explore"], at: new Date().toISOString(), cwd: process.cwd() }, events);
  if (o.json) {
    console.log(JSON.stringify({ type: "result", dir, ok: r.ok, usable: r.verdict.usable, ending: r.ending, stopped: r.stopped ?? null, problems: r.verdict.problems, warnings: r.verdict.warnings, timings: r.timings, usage: r.usage, promptHash: r.promptHash }));
  } else {
    const u = r.usage;
    const tokens = u.input || u.output ? ` · ${k(u.input + u.cacheRead + u.cacheWrite)} in (${k(u.cacheRead)} cached) / ${k(u.output)} out` : "";
    process.stderr.write(`  ${secs(r.timings.done)} · ${r.trace.length} steps${r.repairs.length ? ` · ${r.repairs.length} repair` : ""}${tokens} · prompt ${r.promptHash}\n`);
    if (r.fast) process.stderr.write(dim(`  fast path (${r.fast.route}): the app makes it as a widget of its own; the lab makes packages\n`));
    else printPackageVerdict(r);
    if (r.summary) process.stderr.write(`  ${dim(r.summary)}\n`);
    console.log(r.ending?.kind === "terminal" ? r.ending.command : r.verdict.pkg ? dir : "");
  }
  const shot = path.join(runDir, "preview.png");
  if (o.open && fs.existsSync(shot)) spawn("open", [shot], { stdio: "ignore", detached: true }).unref();
  return r.ok ? 0 : 1;
}

/** A package build's outcome as lines on stderr. */
export function printPackageVerdict(r: PackageBuildResult): void {
  const v = r.verdict;
  if (r.ending?.kind === "terminal") return void process.stderr.write(`  ${green("✓")} a terminal: ${r.ending.command}\n`);
  if (r.ending?.kind === "needs-program") return void process.stderr.write(`  ${yellow("!")} no widget: ${r.ending.reason} ${dim(`(needs ${r.ending.programs.join(", ")})`)}\n`);
  if (r.stopped) process.stderr.write(`  ${red("✗")} ${r.stopped}\n`);
  if (v.ok) process.stderr.write(`  ${green("✓")} check, test and preview passed${v.tests ? dim(` (${v.tests.passed} tests)`) : ""}${v.warnings.length ? dim(` (${v.warnings.length} warning${v.warnings.length > 1 ? "s" : ""})`) : ""}\n`);
  else if (!r.stopped) process.stderr.write(`  ${v.usable ? yellow("!") : red("✗")} ${v.usable ? "usable, but" : "doesn't work:"}\n`);
  for (const p of v.problems) process.stderr.write(red(`    ${p.split("\n")[0]!.slice(0, 200)}\n`));
  for (const w of v.warnings) process.stderr.write(dim(`    ${w.split("\n")[0]!.slice(0, 200)}\n`));
}

/** Next to the package folder: what was asked, the events, the trace, metrics and the preview screenshot. */
export function writeRun(dir: string, r: PackageBuildResult, request: unknown, events: BuildEvent[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const w = (f: string, s: string) => fs.writeFileSync(path.join(dir, f), s);
  w("request.json", JSON.stringify(request, null, 2) + "\n");
  w("events.ndjson", events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  w("trace.json", JSON.stringify(r.trace, null, 2) + "\n");
  const v = r.verdict;
  const widget = v.pkg?.widgets[0];
  const metrics = {
    ok: r.ok,
    usable: v.usable,
    route: r.route,
    kind: r.ending?.kind ?? (v.pkg ? "widget" : null),
    name: v.pkg?.name ?? null,
    title: widget?.title ?? (r.ending?.kind === "terminal" ? r.ending.title : null),
    size: widget?.size ?? null,
    surface: widget?.surface ?? null,
    permissions: v.pkg?.permissions ?? null,
    ending: r.ending,
    stopped: r.stopped ?? null,
    steps: r.trace.length,
    explored: r.trace.some((s) => ["run", "read", "list"].includes(s.tool)),
    checksRun: { check: r.trace.some((s) => s.tool === "check"), test: r.trace.some((s) => s.tool === "test"), preview: r.trace.some((s) => s.tool === "preview") },
    tests: v.tests ?? null,
    toolErrors: r.trace.filter((s) => s.isError).length,
    repairs: r.repairs.length,
    problems: v.problems,
    warnings: v.warnings,
    timings: r.timings,
    usage: r.usage,
    model: r.model,
    backend: r.backend,
    promptHash: r.promptHash,
    summary: r.summary,
  };
  w("metrics.json", JSON.stringify(metrics, null, 2) + "\n");
  if (v.shot) fs.writeFileSync(path.join(dir, "preview.png"), Buffer.from(v.shot, "base64"));
}

export function openFile(p: string): void {
  if (process.platform === "darwin") spawnSync("open", [p]);
  else console.log(pathToFileURL(p).href);
}
