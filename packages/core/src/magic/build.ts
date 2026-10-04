// buildWidget: one Magic request, from prompt to a working widget folder
// (docs/14-magic-v2.md). No dependency on the Core: `cmd magic` runs it
// in-process (the prompt lab) and MagicService runs it for windows.
//
// 1. Fast paths, no model: pasted JSON (a static JSON view), an obvious shell
//    command (a terminal widget).
// 2. The agent: looks around if it needs to (read-only), writes the widget's
//    files, and checks, runs and renders them with the same tools cmd uses.
// 3. cmd verifies the result itself: manifest, types, a data run, renders with
//    live data and fixtures. Problems go back to the agent (twice at most); a
//    build is accepted only when it passes, or kept as "usable with problems"
//    when it at least renders.

import os from "node:os";
import { spawnSync } from "node:child_process";
import type { Backend, Usage } from "./backends.ts";
import { DEFAULT_DENY_PATHS } from "./policy.ts";
import { buildRequest, buildSystem, type Workspace } from "./prompt.ts";
import { commandsSupported, type SandboxMode } from "./sandbox.ts";
import { runTool, toolsFor, type ToolContext, type ToolOutput } from "./tools.ts";
import { runWidgetTool, WIDGET_TOOL_SPECS, type WidgetToolState } from "./widget-tools.ts";
import { verdictText, verifyWidget, type Verdict, type VerifyContext } from "../widgets/verify.ts";
import { JSON_VIEW_HTML, JSON_VIEW_TS } from "../widgets/templates.ts";

export interface BuildOptions {
  /** The request (for a refinement: built by refineRequest, with the earlier requests). */
  prompt: string;
  backend: Backend;
  /** The widget folder and how to check it. */
  widget: VerifyContext;
  /** The window's Space (not Home), named in the request so "this project" resolves. */
  workspace?: Workspace | null;
  /** Let the agent look around this Mac (run, read, list). */
  explore?: boolean;
  /** Tool calls in the first turn before it must finish. */
  maxSteps?: number;
  /** Turns cmd gives the agent to fix what its own check finds. */
  maxRepairs?: number;
  sandbox?: SandboxMode;
  deny?: string[];
  /** Replace prompt/prompt.md (prompt variants). */
  systemFile?: string;
  /** Skip the no-model fast paths (refinements). */
  noFast?: boolean;
  signal?: AbortSignal;
  onEvent?: (e: BuildEvent) => void;
}

export interface TraceStep {
  id: number;
  tool: string;
  why: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
  ms: number;
}

export type BuildEvent =
  | { type: "route"; route: BuildRoute; at: number }
  | { type: "step-start"; id: number; tool: string; why: string; input: Record<string, unknown>; at: number }
  | { type: "step-end"; id: number; ms: number; output: string; isError: boolean; at: number }
  | { type: "turn"; at: number }
  | { type: "text"; delta: string; at: number }
  | { type: "title"; title: string; at: number }
  | { type: "verify"; at: number }
  | { type: "repair"; reason: string; at: number };

export type BuildRoute = "json" | "terminal" | "agent";

export interface BuildResult {
  route: BuildRoute;
  /** Passed every check. */
  ok: boolean;
  verdict: Verdict;
  /** The agent's closing words. */
  summary: string;
  repairs: string[];
  trace: TraceStep[];
  usage: Usage;
  model: string;
  backend: string;
  /** ms from the start: first tool step, done. */
  timings: { firstStep?: number; done: number };
}

const EMPTY_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Pasted JSON → the data; an obvious command → the command; else null. */
export function fastRoute(prompt: string): { route: "json"; data: unknown } | { route: "terminal"; command: string } | null {
  const t = prompt.trim();
  if (/^[[{]/.test(t)) {
    try {
      return { route: "json", data: JSON.parse(t) };
    } catch {}
  }
  const first = /^[A-Za-z0-9_./-]+/.exec(t)?.[0];
  // The "is it a command?" check asks /bin/sh; on Windows the agent decides.
  if (!first || process.platform === "win32") return null;
  // Shell syntax (flags, pipes, quotes, redirects) or a single word; never something that reads like a sentence.
  const shellish = /\s-{1,2}[A-Za-z]|[|><;$`'"]|^\S+$/.test(t);
  const english = /\b(of|every|all|my|the|show|me|what|which|how|is|are|in|for|with|and|live|please)\b/i.test(t.replace(/(["'])[^"']*\1/g, ""));
  if (!shellish || english) return null;
  const found = first.includes("/") ? false : spawnSync("/bin/sh", ["-c", `command -v ${first}`], { stdio: "ignore" }).status === 0;
  return found ? { route: "terminal", command: t } : null;
}

export async function buildWidget(o: BuildOptions): Promise<BuildResult> {
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const emit = (e: BuildEvent) => o.onEvent?.(e);
  const w = o.widget;
  const base = { usage: { ...EMPTY_USAGE }, model: o.backend.model, backend: o.backend.name, trace: [] as TraceStep[], repairs: [] as string[], summary: "" };
  w.store.ensure(w.id);

  if (!o.noFast) {
    const fast = fastRoute(o.prompt);
    if (fast) {
      emit({ type: "route", route: fast.route, at: at() });
      if (fast.route === "json") {
        w.store.write(w.id, "manifest.json", JSON.stringify({ cmd: 2, kind: "widget", title: "JSON", size: "m", refresh: 0 }, null, 2) + "\n");
        w.store.write(w.id, "static.json", JSON.stringify(fast.data, null, 1) + "\n");
        w.store.write(w.id, "view.html", JSON_VIEW_HTML);
        w.store.write(w.id, "view.ts", JSON_VIEW_TS);
      } else {
        w.store.write(w.id, "manifest.json", JSON.stringify({ cmd: 2, kind: "terminal", title: fast.command.split(/\s+/)[0], size: "m", refresh: 0, command: fast.command }, null, 2) + "\n");
      }
      const verdict = await verifyWidget({ ...w, deno: fast.route === "json" ? null : w.deno, previewer: fast.route === "json" ? null : w.previewer });
      return { ...base, route: fast.route, ok: verdict.usable, verdict: { ...verdict, ok: verdict.usable }, timings: { done: at() } };
    }
  }
  emit({ type: "route", route: "agent", at: at() });

  const explore = o.explore ?? true;
  const ctx: ToolContext = { cwd: w.cwd, home: os.homedir(), deny: o.deny ?? DEFAULT_DENY_PATHS, sandbox: o.sandbox ?? "required", signal: o.signal };
  const trace: TraceStep[] = [];
  const timings: BuildResult["timings"] = { done: 0 };
  const state: WidgetToolState = { dirty: false, onManifest: (title) => emit({ type: "title", title, at: at() }) };
  let stepId = 0;
  const exec = async (name: string, input: Record<string, unknown>): Promise<ToolOutput> => {
    const id = ++stepId;
    const why = typeof input.why === "string" ? input.why : name;
    timings.firstStep ??= at();
    emit({ type: "step-start", id, tool: name, why, input, at: at() });
    const start = Date.now();
    const out = await (async () => (await runWidgetTool(name, input, w, state)) ?? (await runTool(name, input, ctx)))().catch((e: Error) => ({ output: e.message, isError: true }) as ToolOutput);
    const ms = Date.now() - start;
    const logged = name === "write_file" ? { ...input, content: `(${String(input.content ?? "").length} characters)` } : input;
    trace.push({ id, tool: name, why, input: logged, output: out.output.slice(0, 20_000), isError: out.isError, ms });
    emit({ type: "step-end", id, ms, output: out.output, isError: out.isError, at: at() });
    return out;
  };

  const system = buildSystem(o.systemFile);
  const canRun = commandsSupported(ctx.sandbox);
  const tools = [...toolsFor(explore).filter((t) => canRun || t.name !== "run"), ...WIDGET_TOOL_SPECS];
  const existing = w.store.snapshotFiles(w.id);
  delete existing["fixtures/live.json"];
  const request = buildRequest(o.prompt, { cwd: w.cwd, workspace: o.workspace, explore, canRun, widgetDir: w.store.dir(w.id), files: existing });
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: request }];
  const usage = { ...EMPTY_USAGE, costUSD: 0 };
  let model = o.backend.model;

  const turn = async (maxSteps: number): Promise<string> => {
    const r = await o.backend.run({
      system,
      messages,
      tools,
      exec,
      maxSteps,
      signal: o.signal,
      onTurn: () => emit({ type: "turn", at: at() }),
      onText: (delta) => emit({ type: "text", delta, at: at() }),
    });
    usage.input += r.usage.input;
    usage.output += r.usage.output;
    usage.cacheRead += r.usage.cacheRead;
    usage.cacheWrite += r.usage.cacheWrite;
    if (r.usage.costUSD !== undefined) usage.costUSD += r.usage.costUSD;
    model = r.model;
    return r.text;
  };

  let summary = await turn(o.maxSteps ?? 40);
  emit({ type: "verify", at: at() });
  let verdict = await verifyWidget(w);
  const repairs: string[] = [];
  for (let i = 0; !verdict.ok && i < (o.maxRepairs ?? 2) && !o.signal?.aborted; i++) {
    const reason = `cmd checked the widget and found problems. Fix them in the files, run the checks again, then finish with one short sentence.\n\n${verdictText(verdict)}`;
    repairs.push(reason);
    emit({ type: "repair", reason: verdict.problems[0] ?? "problems", at: at() });
    messages.push({ role: "assistant", content: summary || "(done)" }, { role: "user", content: reason });
    summary = await turn(15);
    emit({ type: "verify", at: at() });
    verdict = await verifyWidget(w);
  }
  timings.done = at();
  return { route: "agent", ok: verdict.ok, verdict, summary: summary.trim().slice(0, 600), repairs, trace, usage, model, backend: o.backend.name, timings };
}
