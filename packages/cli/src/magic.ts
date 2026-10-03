// `cmd magic`: the Magic window prompt lab (docs/12-magic-windows.md). Runs the
// Magic agent in this process (no core needed), prints its steps, and writes
// the run to a folder: events, answer, data, metrics and a standalone
// widget.html that opens in any browser. The system prompt is read from
// packages/core/src/magic/prompt/ on every run, so edits apply immediately.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_SETTINGS, MAGIC_PROVIDERS, parseJsonc, resolveSettings, type Settings } from "@cmd/protocol";
import { cmdHome, configDir } from "@cmd/protocol/node";
import {
  backendFor,
  isProvider,
  readSecrets,
  runMagic,
  sandboxAvailable,
  SIZES,
  widgetHtml,
  widgetTokens,
  type Backend,
  type MagicEvent,
  type MagicResult,
  type ThemeLike,
  parseAnswer,
} from "@cmd/core/magic";
import { lintBody } from "@cmd/core/magic/lint";

export const MAGIC_HELP = `cmd magic — turn a request into a live widget or a terminal command

usage: cmd magic <request…> [options]
       cmd magic view <run dir…>     re-render saved runs (dark + light screenshots), no model
       cmd magic eval [case…]        run the eval cases against prompt variants (see --help)

  --provider P      anthropic | openai (default: magic.provider in your settings)
  --model M         default: that provider's model in your settings
  --effort E        low | medium | high, for models that take it (default low)
  --system FILE     use FILE instead of prompt/prompt.md (prompt variants)
  --no-explore      don't let the agent look around this Mac
  --no-fast         always use the agent (skip the JSON / command fast paths)
  --max-steps N     tool calls before it must answer (default 12)
  --theme ID        theme for widget.html (default: follows macOS appearance)
  --out DIR         write the run here (default $CMD_HOME/magic/runs/<time>-<request>)
  --open            open widget.html in the browser
  --shot            screenshot the widget (dark + light) and check it renders
  --json            print events as NDJSON instead of the trace
  --unsandboxed     run commands without sandbox-exec (only the policy guards them)

The API key is the one stored in Settings → Magic Windows (or with
\`cmd settings secret KEY\`); nothing is read from the environment.

env: CMD_MAGIC_UNSANDBOXED=1`;

const here = path.dirname(fileURLToPath(import.meta.url));
const THEMES_DIR = path.resolve(here, "../../../apps/desktop/src/renderer/src/themes");

/** Every built-in theme, by id (the theme files are plain data). */
export async function loadThemes(): Promise<Map<string, ThemeLike & { id: string }>> {
  const out = new Map<string, ThemeLike & { id: string }>();
  for (const f of fs.readdirSync(THEMES_DIR)) {
    if (!f.endsWith(".ts") || ["builtin.ts", "registry.ts", "types.ts"].includes(f)) continue;
    const mod = (await import(pathToFileURL(path.join(THEMES_DIR, f)).href)) as Record<string, unknown>;
    for (const v of Object.values(mod)) {
      const t = v as { id?: string; colors?: unknown; terminal?: unknown };
      if (t && typeof t.id === "string" && t.colors && t.terminal) out.set(t.id, t as ThemeLike & { id: string });
    }
  }
  return out;
}

function systemAppearance(): "dark" | "light" {
  const r = spawnSync("defaults", ["read", "-g", "AppleInterfaceStyle"], { encoding: "utf8" });
  return r.stdout?.trim() === "Dark" ? "dark" : "light";
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "run";
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

/** The user's settings file as the core would read it (the prompt lab runs without a core). */
function userSettings(): Settings {
  try {
    return resolveSettings(parseJsonc(fs.readFileSync(path.join(configDir(), "settings.json"), "utf8")) as Record<string, unknown>).settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** The provider, model and stored key the app would use; --provider and --model override the first two. */
export function pickBackend(o: { provider?: string; model?: string; effort?: string }): Backend {
  const s = userSettings();
  const provider = o.provider ?? s["magic.provider"];
  const p = isProvider(provider) ? MAGIC_PROVIDERS[provider] : undefined;
  const effort = o.effort === "low" || o.effort === "medium" || o.effort === "high" ? o.effort : undefined;
  if (o.effort && !effort) throw new Error(`--effort: expected low, medium or high`);
  return backendFor({ provider, model: o.model ?? (p ? s[p.modelSetting] : ""), apiKey: p ? readSecrets(path.join(cmdHome(), "secrets.json"))[p.keySecret] : undefined, effort });
}

// ── trace printing ──────────────────────────────────────

const tty = process.stderr.isTTY;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c("2");
const green = c("32");
const red = c("31");
const bold = c("1");
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function describeInput(tool: string, input: Record<string, unknown>): string {
  const v = input.command ?? input.path ?? input.url ?? input.question ?? (input.source as { url?: string; command?: string } | undefined)?.url ?? (input.source as { command?: string } | undefined)?.command;
  const s = typeof v === "string" ? v : "";
  return `${tool === "run" ? "" : tool + " "}${s}`.replace(/\s+/g, " ").slice(0, 70);
}

function printer(): (e: MagicEvent) => void {
  const starts = new Map<number, { why: string; detail: string }>();
  let drew = false;
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
        const first = e.isError ? "  " + red(e.output.split("\n")[0]!.slice(0, 90)) : "";
        process.stderr.write(`  ${mark} ${s.why.padEnd(34).slice(0, 34)} ${dim(s.detail)} ${dim(secs(e.ms))}${first ? "\n   " + first : ""}\n`);
        break;
      }
      case "header":
        if (!drew) process.stderr.write(`  ${bold("▸")} ${e.header.title} ${dim(`(${e.header.kind}${e.header.kind === "widget" ? ` · ${e.header.size}` : ""}${e.header.source ? ` · ${e.header.source.type} every ${e.header.refresh}s` : ""})`)} ${dim("drawing…")}\n`);
        drew = true;
        break;
      case "turn":
        drew = false;
        break;
      case "repair":
        process.stderr.write(`  ${red("↻")} ${dim(e.reason.split("\n")[0]!.slice(0, 110))}\n`);
        break;
    }
  };
}

// ── writing a run ───────────────────────────────────────

export interface RunFiles {
  dir: string;
  widget?: string;
}

export function writeRun(dir: string, r: MagicResult, request: unknown, events: MagicEvent[], theme: ThemeLike): RunFiles {
  fs.mkdirSync(dir, { recursive: true });
  const w = (f: string, s: string) => fs.writeFileSync(path.join(dir, f), s);
  w("request.json", JSON.stringify(request, null, 2) + "\n");
  w("events.ndjson", events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  w("answer.txt", r.answer);
  w("trace.json", JSON.stringify(r.trace, null, 2) + "\n");
  const data = r.route === "json" ? r.data : r.sample?.ok ? r.sample.data : undefined;
  if (data !== undefined) w("data.json", JSON.stringify(data, null, 2) + "\n");
  const lint = r.body ? lintBody(r.body) : null;
  const metrics = {
    ok: r.ok,
    route: r.route,
    kind: r.header?.kind ?? (r.route === "json" ? "json" : null),
    title: r.header?.title ?? null,
    size: r.header?.size ?? null,
    source: r.header?.source ?? null,
    refresh: r.header?.refresh ?? 0,
    command: r.header?.command ?? null,
    steps: r.trace.length,
    explored: r.trace.some((s) => ["run", "read", "list"].includes(s.tool)),
    tested: r.trace.some((s) => s.tool === "test_source" && !s.isError),
    toolErrors: r.trace.filter((s) => s.isError).length,
    repairs: r.repairs.length,
    errors: r.errors,
    timings: r.timings,
    usage: r.usage,
    model: r.model,
    backend: r.backend,
    lint,
  };
  w("metrics.json", JSON.stringify(metrics, null, 2) + "\n");
  const files: RunFiles = { dir };
  if (r.header?.kind === "widget" && r.body) {
    files.widget = path.join(dir, "widget.html");
    w("widget.html", widgetHtml({ title: r.header.title, body: r.body, tokens: widgetTokens(theme), data }));
  }
  return files;
}

// ── screenshots ─────────────────────────────────────────

export interface RenderCheck {
  errors: string[];
  empty: boolean;
  overflow: boolean;
  shots: string[];
  /** Rendered at SMALL as well (windows get resized, gridded, zoomed out). */
  small?: { overflowX: boolean; overflowY: boolean; empty: boolean };
}

/** A small window, as in a dense grid or a zoomed-out canvas. */
export const SMALL = [240, 150] as const;

/**
 * Render a run's widget in headless Chromium at its size, once per theme:
 * <theme>.png next to widget.html, plus what went wrong (script errors, nothing
 * drawn, content larger than the window).
 */
export async function shoot(dir: string, r: MagicResult, themes: (ThemeLike & { id: string })[]): Promise<RenderCheck | null> {
  if (r.header?.kind !== "widget" || !r.body) return null;
  const { chromium } = await import("playwright");
  const [w, h] = SIZES[r.header.size];
  const data = r.sample?.ok ? r.sample.data : undefined;
  const browser = await chromium.launch();
  const check: RenderCheck = { errors: [], empty: false, overflow: false, shots: [] };
  try {
    for (const theme of themes) {
      const file = path.join(dir, `widget-${theme.id}.html`);
      fs.writeFileSync(file, widgetHtml({ title: r.header.title, body: r.body, tokens: widgetTokens(theme), data }));
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: theme.appearance });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      await page.goto(pathToFileURL(file).href);
      await page.waitForTimeout(600);
      const state = await page.evaluate(() => ({
        text: document.body.innerText.trim().length,
        nodes: document.body.querySelectorAll("*").length,
        scrollH: document.documentElement.scrollHeight,
        scrollW: document.documentElement.scrollWidth,
        errors: ((window as unknown as { __CMD_ERRORS__?: { message: string }[] }).__CMD_ERRORS__ ?? []).map((e) => e.message),
      }));
      const png = path.join(dir, `${theme.id}.png`);
      await page.screenshot({ path: png });
      check.shots.push(png);
      for (const e of [...errors, ...state.errors]) if (!check.errors.includes(e)) check.errors.push(e);
      check.empty ||= state.text === 0 && state.nodes < 3;
      check.overflow ||= state.scrollH > h + 2 || state.scrollW > w + 2;
      await page.close();
      fs.rmSync(file);
    }
    // Once more, small (dark theme).
    const file = path.join(dir, "widget-small.html");
    fs.writeFileSync(file, widgetHtml({ title: r.header.title, body: r.body, tokens: widgetTokens(themes[0]!), data }));
    const page = await browser.newPage({ viewport: { width: SMALL[0], height: SMALL[1] }, deviceScaleFactor: 2, colorScheme: themes[0]!.appearance });
    await page.goto(pathToFileURL(file).href);
    await page.waitForTimeout(600);
    const st = await page.evaluate(() => ({
      text: document.body.innerText.trim().length,
      nodes: document.body.querySelectorAll("*").length,
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
    }));
    await page.screenshot({ path: path.join(dir, "small.png") });
    check.shots.push(path.join(dir, "small.png"));
    check.small = { overflowX: st.w > SMALL[0] + 2, overflowY: st.h > SMALL[1] + 2, empty: st.text === 0 && st.nodes < 3 };
    await page.close();
    fs.rmSync(file);
  } finally {
    await browser.close();
  }
  const m = JSON.parse(fs.readFileSync(path.join(dir, "metrics.json"), "utf8"));
  m.render = { errors: check.errors, empty: check.empty, overflow: check.overflow, small: check.small };
  fs.writeFileSync(path.join(dir, "metrics.json"), JSON.stringify(m, null, 2) + "\n");
  return check;
}

/** `cmd magic view DIR…`: re-render saved runs (after editing kit.css or host.js), no model. */
async function viewCommand(dirs: string[]): Promise<number> {
  const themes = await loadThemes();
  let failed = 0;
  for (const d of dirs) {
    const dir = path.resolve(d);
    const answer = fs.readFileSync(path.join(dir, "answer.txt"), "utf8");
    const parsed = parseAnswer(answer);
    if (!parsed.ok) {
      process.stderr.write(red(`✗ ${d}: ${parsed.error}\n`));
      failed++;
      continue;
    }
    const dataFile = path.join(dir, "data.json");
    const data = fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, "utf8")) : undefined;
    const r = { header: parsed.header, body: parsed.body, sample: data === undefined ? null : { ok: true, data, ms: 0, bytes: 0 } } as unknown as MagicResult;
    fs.writeFileSync(path.join(dir, "widget.html"), widgetHtml({ title: parsed.header.title, body: parsed.body, tokens: widgetTokens(themes.get(systemAppearance())!), data }));
    const check = await shoot(dir, r, [themes.get("dark")!, themes.get("light")!]);
    const bad = check ? [...check.errors, check.empty ? "draws nothing" : "", check.overflow ? "overflows" : "", check.small?.overflowX ? `overflows sideways at ${SMALL.join("×")}` : ""].filter(Boolean) : [];
    process.stderr.write(`${bad.length ? red("✗") : green("✓")} ${parsed.header.title} ${dim(dir)}${bad.length ? "\n  " + red(bad.join("; ")) : ""}\n`);
    if (bad.length) failed++;
  }
  return failed ? 1 : 0;
}

// ── command ─────────────────────────────────────────────

export async function magicCommand(argv: string[]): Promise<number> {
  if (argv[0] === "view") return viewCommand(argv.slice(1));
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
      "no-fast": { type: "boolean" },
      "max-steps": { type: "string" },
      theme: { type: "string" },
      out: { type: "string" },
      open: { type: "boolean" },
      shot: { type: "boolean" },
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
  const unsandboxed = o.unsandboxed || process.env.CMD_MAGIC_UNSANDBOXED === "1";
  if (!unsandboxed && !sandboxAvailable()) {
    process.stderr.write(dim("  note: sandbox-exec is unavailable here, so the agent can't run commands (use --unsandboxed to rely on the policy alone)\n"));
  }
  const themes = await loadThemes();
  const theme = themes.get(o.theme ?? systemAppearance()) ?? themes.get("dark")!;
  if (o.theme && !themes.has(o.theme)) process.stderr.write(dim(`  unknown theme ${o.theme}; using ${theme === themes.get("dark") ? "dark" : "?"} (have: ${[...themes.keys()].join(", ")})\n`));

  let backend: Backend;
  try {
    backend = pickBackend({ provider: o.provider, model: o.model, effort: o.effort });
  } catch (e) {
    process.stderr.write(red(`  ✗ ${(e as Error).message}\n`));
    return 1;
  }
  const events: MagicEvent[] = [];
  const print = o.json ? (e: MagicEvent) => console.log(JSON.stringify(e)) : printer();
  const ac = new AbortController();
  process.once("SIGINT", () => ac.abort());

  if (!o.json) process.stderr.write(`${bold("✦")} ${prompt} ${dim(`· ${backend.name} ${backend.model}`)}\n`);
  const request = {
    prompt,
    provider: backend.name,
    model: backend.model,
    effort: o.effort ?? null,
    system: o.system ?? null,
    explore: !o["no-explore"],
    at: new Date().toISOString(),
    cwd: process.cwd(),
  };
  let r: MagicResult;
  try {
    r = await runMagic({
      prompt,
      backend,
      cwd: process.cwd(),
      explore: !o["no-explore"],
      noFast: o["no-fast"],
      maxSteps: o["max-steps"] ? Number(o["max-steps"]) : undefined,
      sandbox: unsandboxed ? "off" : "required",
      systemFile: o.system ? path.resolve(o.system) : undefined,
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
  const dir = path.resolve(o.out ?? path.join(cmdHome(), "magic", "runs", `${stamp()}-${slug(prompt)}`));
  const files = writeRun(dir, r, request, events, theme);
  const render = o.shot ? await shoot(dir, r, [themes.get("dark")!, themes.get("light")!]) : null;

  if (o.json) {
    console.log(JSON.stringify({ type: "result", dir, widget: files.widget ?? null, ok: r.ok, header: r.header, timings: r.timings, usage: r.usage, render }));
  } else {
    const u = r.usage;
    const cost = u.costUSD ? ` · $${u.costUSD.toFixed(3)}` : "";
    const tokens = u.input || u.output ? ` · ${k(u.input + u.cacheRead + u.cacheWrite)} in (${k(u.cacheRead)} cached) / ${k(u.output)} out` : "";
    const mark = r.ok ? green("✓") : red("✗");
    process.stderr.write(`  ${mark} ${secs(r.timings.done)} · ${r.trace.length} steps${r.repairs.length ? ` · ${r.repairs.length} repair` : ""}${tokens}${cost}\n`);
    for (const e of r.errors) process.stderr.write(red(`    ${e.split("\n")[0]}\n`));
    if (render) {
      const bad = [...render.errors.map((e) => `script error: ${e}`), render.empty ? "draws nothing" : "", render.overflow ? "overflows its window" : "", render.small?.overflowX ? "overflows sideways when small" : ""].filter(Boolean);
      process.stderr.write(bad.length ? red(`  ✗ render: ${bad.join("; ")}\n`) : `  ${green("✓")} renders ${dim(render.shots.map((p) => path.basename(p)).join(", "))}\n`);
    }
    if (r.header?.kind === "terminal") console.log(r.header.command);
    else if (files.widget) console.log(files.widget);
    else console.log(dir);
  }
  if (o.open && files.widget) spawn("open", [files.widget], { stdio: "ignore", detached: true }).unref();
  return r.ok ? 0 : 1;
}

