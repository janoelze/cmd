// runMagic: one Magic request from prompt to answer (docs/12-magic-windows.md).
// No dependency on the Core: `cmd magic` runs it in-process (the prompt lab),
// and the core will wrap the same function for Magic windows.
//
// 1. Fast paths, no model: pasted JSON, an obvious shell command.
// 2. The agent: a tool loop on the chosen backend, read-only tools, a step budget.
// 3. Checks: the answer follows the contract, and a widget's source works.
//    One repair turn when either fails.

import os from "node:os";
import { spawnSync } from "node:child_process";
import type { Backend, Usage } from "./backends.ts";
import { AnswerStream, parseAnswer, type MagicHeader } from "./contract.ts";
import { DEFAULT_DENY_PATHS } from "./policy.ts";
import { buildRequest, buildSystem } from "./prompt.ts";
import { commandsSupported, type SandboxMode } from "./sandbox.ts";
import { redact } from "./policy.ts";
import { preview, runSource, sourceKey, type SourceResult } from "./sources.ts";
import { runTool, toolsFor, type ToolContext } from "./tools.ts";

export interface MagicOptions {
  prompt: string;
  backend: Backend;
  cwd?: string;
  /** Let the agent look around this Mac (run, read, list). */
  explore?: boolean;
  /** Tool calls before the agent must answer. */
  maxSteps?: number;
  sandbox?: SandboxMode;
  deny?: string[];
  /** Replace prompt/prompt.md (prompt variants). */
  systemFile?: string;
  /** Skip the no-model fast paths. */
  noFast?: boolean;
  signal?: AbortSignal;
  onEvent?: (e: MagicEvent) => void;
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

export type MagicEvent =
  | { type: "route"; route: MagicRoute; at: number }
  | { type: "step-start"; id: number; tool: string; why: string; input: Record<string, unknown>; at: number }
  | { type: "step-end"; id: number; ms: number; output: string; isError: boolean; at: number }
  | { type: "turn"; at: number }
  | { type: "text"; delta: string; at: number }
  | { type: "header"; header: MagicHeader; at: number }
  | { type: "body"; body: string; at: number }
  | { type: "repair"; reason: string; at: number };

export type MagicRoute = "json" | "terminal" | "agent";

export interface MagicResult {
  route: MagicRoute;
  ok: boolean;
  header: MagicHeader | null;
  body: string;
  /** The source's data, when the widget has one and it ran. */
  sample: SourceResult | null;
  /** Problems left after repair (empty when ok). */
  errors: string[];
  repairs: string[];
  trace: TraceStep[];
  answer: string;
  usage: Usage;
  model: string;
  backend: string;
  /** ms from the start: first tool step, header, done. */
  timings: { firstStep?: number; header?: number; done: number };
  /** For json: the pasted data. */
  data?: unknown;
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

export async function runMagic(o: MagicOptions): Promise<MagicResult> {
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const emit = (e: MagicEvent) => o.onEvent?.(e);
  const cwd = o.cwd ?? process.cwd();
  const explore = o.explore ?? true;
  const base = { usage: EMPTY_USAGE, model: o.backend.model, backend: o.backend.name, trace: [], repairs: [], answer: "", sample: null };

  if (!o.noFast) {
    const fast = fastRoute(o.prompt);
    if (fast?.route === "json") {
      emit({ type: "route", route: "json", at: at() });
      return { ...base, route: "json", ok: true, header: null, body: "", errors: [], data: fast.data, timings: { done: at() } };
    }
    if (fast?.route === "terminal") {
      emit({ type: "route", route: "terminal", at: at() });
      const header: MagicHeader = { kind: "terminal", title: fast.command.split(/\s+/)[0]!, loading: [], source: null, refresh: 0, size: "m", command: fast.command };
      return { ...base, route: "terminal", ok: true, header, body: "", errors: [], timings: { done: at() } };
    }
  }
  emit({ type: "route", route: "agent", at: at() });

  const ctx: ToolContext = {
    cwd,
    home: os.homedir(),
    deny: o.deny ?? DEFAULT_DENY_PATHS,
    sandbox: o.sandbox ?? "required",
    signal: o.signal,
    tested: new Map(),
  };
  const trace: TraceStep[] = [];
  const timings: MagicResult["timings"] = { done: 0 };
  let stepId = 0;
  const exec = async (name: string, input: Record<string, unknown>) => {
    const id = ++stepId;
    const why = typeof input.why === "string" ? input.why : name;
    timings.firstStep ??= at();
    emit({ type: "step-start", id, tool: name, why, input, at: at() });
    const start = Date.now();
    const out = await runTool(name, input, ctx).catch((e: Error) => ({ output: e.message, isError: true }));
    const ms = Date.now() - start;
    trace.push({ id, tool: name, why, input, output: out.output.slice(0, 20_000), isError: out.isError, ms });
    emit({ type: "step-end", id, ms, output: out.output, isError: out.isError, at: at() });
    return out;
  };

  const system = buildSystem(o.systemFile);
  const canRun = commandsSupported(ctx.sandbox);
  const tools = toolsFor(explore).filter((t) => canRun || t.name !== "run");
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: buildRequest(o.prompt, { cwd, explore, canRun }) }];
  const usage = { ...EMPTY_USAGE, costUSD: 0 };
  const repairs: string[] = [];
  let model = o.backend.model;

  const turn = async (maxSteps: number): Promise<string> => {
    const stream = new AnswerStream();
    const r = await o.backend.run({
      system,
      messages,
      tools,
      exec,
      maxSteps,
      signal: o.signal,
      onTurn: () => {
        stream.reset();
        emit({ type: "turn", at: at() });
      },
      onText: (delta) => {
        emit({ type: "text", delta, at: at() });
        const p = stream.push(delta);
        if (p.header) {
          timings.header ??= at();
          emit({ type: "header", header: p.header, at: at() });
        }
        if (p.body !== undefined) emit({ type: "body", body: p.body, at: at() });
      },
    });
    usage.input += r.usage.input;
    usage.output += r.usage.output;
    usage.cacheRead += r.usage.cacheRead;
    usage.cacheWrite += r.usage.cacheWrite;
    if (r.usage.costUSD !== undefined) usage.costUSD += r.usage.costUSD;
    model = r.model;
    return r.text;
  };

  let answer = await turn(o.maxSteps ?? 12);
  let parsed = parseAnswer(answer);
  let sample: SourceResult | null = null;

  /** What is wrong with the answer, or null. Runs an untested source. */
  const check = async (): Promise<string | null> => {
    if (!parsed.ok) return `Your answer doesn't follow the format: ${parsed.error}. Reply again with only the header line, ---, and the body.`;
    const src = parsed.header.source;
    if (parsed.header.kind !== "widget" || !src) return null;
    sample = ctx.tested.get(sourceKey(src)) ?? (await runSource(src, ctx));
    if (!sample.ok) return `Your widget's source failed when cmd ran it: ${sample.error}. Fix the source (test it with test_source) and answer again.`;
    if (!ctx.tested.has(sourceKey(src))) {
      // Ran fine, but the view was written blind: show the agent the data once.
      return `You didn't test the source. cmd ran it; the view's cmd.onData gets:\n${redact(preview(sample.data))}\nIf your view handles this data, repeat your answer unchanged; otherwise fix the view.`;
    }
    return null;
  };

  let problem = await check();
  if (problem) {
    repairs.push(problem);
    emit({ type: "repair", reason: problem, at: at() });
    messages.push({ role: "assistant", content: answer }, { role: "user", content: problem });
    // The source result is now known to it; mark it tested so an unchanged answer passes.
    if (parsed.ok && parsed.header.source && sample && (sample as SourceResult).ok) ctx.tested.set(sourceKey(parsed.header.source), sample);
    answer = await turn(4);
    parsed = parseAnswer(answer);
    sample = null;
    problem = await check();
  }
  timings.done = at();
  return {
    route: "agent",
    ok: !problem,
    header: parsed.ok ? parsed.header : (parsed.header ?? null),
    body: parsed.ok ? parsed.body : (parsed.body ?? ""),
    sample,
    errors: problem ? [problem] : [],
    repairs,
    trace,
    answer,
    usage,
    model,
    backend: o.backend.name,
    timings,
  };
}
