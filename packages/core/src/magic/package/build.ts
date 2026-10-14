// buildPackage: one Magic request, from prompt to a widget package (docs/56, "Magic on V3").
// No dependency on the Core: `cmd magic` runs it in-process (the prompt lab, evals) and
// MagicPackages (service.ts) runs it for a Magic window.
//
// 1. The fast paths (pasted JSON, an obvious shell command) aren't packages: the result says
//    which, and the caller makes them as before (MagicService).
// 2. The agent looks around if it needs to (read-only), writes the package's files, and
//    checks, tests and previews them with the same toolchain cmd uses. When package.json asks
//    for permissions, `check` asks the person (o.ask) and returns the answer.
// 3. cmd verifies the result itself: package.json, the types, the tests, the trees drawn.
//    Problems go back to the agent (twice at most); a build is accepted when it passes, and
//    kept as "usable with problems" when the package is valid and its types check.
// It may end without a package instead: a terminal, or "needs a program" with the reason.
// It stops at the token ceiling (o.maxTokens, magic.maxTokens) with a clear message.

import os from "node:os";
import type { WidgetPermissions } from "@cmd/protocol";
import type { Backend, Usage } from "../../ai/backends.ts";
import { magicDenyPaths } from "../../lib/paths-deny.ts";
import type { Previewer } from "../../widgets/preview.ts";
import type { WidgetPackage } from "../../widgets/package.ts";
import { fastRoute, type BuildEvent, type BuildRoute, type TraceStep } from "../build.ts";
import type { Workspace } from "../prompt.ts";
import { commandsSupported, type SandboxMode } from "../sandbox.ts";
import { runTool, toolsFor, type ToolContext, type ToolOutput } from "../tools.ts";
import { snapshotFiles } from "./files.ts";
import { previewTrees } from "./preview.ts";
import { buildPackageRequest, buildPackageSystem, promptHash } from "./prompt.ts";
import { checkoutToolchain, type RunOptions, type Toolchain } from "./toolchain.ts";
import { PACKAGE_TOOL_SPECS, permissionStep, runPackageTool, type PackageEnding, type PackageToolContext, type PackageToolState } from "./tools.ts";

export interface PackageBuildOptions {
  /** The request (for a change: with the earlier requests, as refineRequest makes it). */
  prompt: string;
  backend: Backend;
  /** The package's folder and name (its folder's name). */
  dir: string;
  name: string;
  /** Where the agent's looking around starts (the window's workspace, else home). */
  cwd: string;
  workspace?: Workspace | null;
  explore?: boolean;
  maxSteps?: number;
  maxRepairs?: number;
  /** Tokens (read and written, cached reads too) a build may use; 0 or none: no limit. */
  maxTokens?: number;
  sandbox?: SandboxMode;
  deny?: string[];
  systemFile?: string;
  /** Skip the fast paths (changes). */
  noFast?: boolean;
  /** Default: the checkout's (checkoutToolchain); null: none (package.json is all that's checked). */
  toolchain?: Toolchain | null;
  previewer?: () => Promise<Previewer | null>;
  /** The permission step (see tools.ts); none: nothing is asked, the grant is the caller's. */
  ask?: PackageToolContext["ask"];
  granted?: () => WidgetPermissions | null;
  cmdVersion?: string | null;
  signal?: AbortSignal;
  onEvent?: (e: BuildEvent) => void;
}

export interface PackageVerdict {
  /** Every check passed. */
  ok: boolean;
  /** The package is valid and its types check: it can be shown. */
  usable: boolean;
  problems: string[];
  warnings: string[];
  pkg: WidgetPackage | null;
  tests?: { passed: number; failed: number };
  /** The first state drawn (base64 PNG). */
  shot?: string;
}

export interface PackageBuildResult {
  route: BuildRoute;
  /** A fast path's input (the caller makes it). */
  fast?: { route: "json"; data: unknown } | { route: "terminal"; command: string };
  /** The build ended without a package (a terminal, or a program it would need). */
  ending: PackageEnding | null;
  ok: boolean;
  verdict: PackageVerdict;
  /** Why it stopped early (the token ceiling), if it did. */
  stopped?: string;
  summary: string;
  repairs: string[];
  trace: TraceStep[];
  usage: Usage;
  model: string;
  backend: string;
  /** The system prompt's hash (evals record it). */
  promptHash: string;
  timings: { firstStep?: number; done: number };
}

const EMPTY_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const tokens = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheWrite;
const EMPTY_VERDICT: PackageVerdict = { ok: false, usable: false, problems: [], warnings: [], pkg: null };

/** cmd's own check of what the agent made: package.json and types, the tests, the trees drawn. */
export async function verifyPackage(c: PackageToolContext, state: PackageToolState): Promise<PackageVerdict> {
  if (!c.toolchain) return { ...EMPTY_VERDICT, problems: ["cmd can't check packages here (its TypeScript and Vitest aren't installed)"] };
  const check = await c.toolchain.check(c.dir, c.run);
  // A package that asks for permissions is asked about here too, if the agent never ran check.
  if (check.pkg) await permissionStep(check.pkg, c, state);
  if (!check.ok) return { ...EMPTY_VERDICT, problems: check.problems, pkg: check.pkg };
  const problems: string[] = [];
  const warnings: string[] = [];
  // Declined: it can't run as it is; the agent hears why and may ask for less.
  if (state.declined) return { ...EMPTY_VERDICT, problems: ["The person declined what package.json asks for: ask for less, or say what the widget can't do without it."], pkg: check.pkg };
  const test = await c.toolchain.test(c.dir, c.run);
  if (!test.ok) problems.push(...test.problems.map((p) => `test: ${p}`), ...test.failed.map((f) => `test failed: ${f.name}\n${f.message}`));
  const pkg = check.pkg!;
  const tree = pkg.widgets.filter((w) => w.surface === "tree");
  for (const w of tree) if (!snapshotFiles(c.dir)[w.main.replace(/\.tsx?$/, ".story.tsx")]) warnings.push(`no story for ${w.id}: write ${w.main.replace(/\.tsx?$/, ".story.tsx")} with a state per fixture`);
  let shot: string | undefined;
  if (tree.length) {
    const t = await c.toolchain.trees(c.dir, c.run);
    problems.push(...t.problems);
    const first = tree[0]!;
    const drawn = t.variants.length ? await previewTrees(await c.previewer().catch(() => null), t.variants, first) : null;
    if (drawn) {
      problems.push(...drawn.problems);
      warnings.push(...drawn.warnings, ...(drawn.skipped ? [`not drawn: ${drawn.skipped}`] : []));
      shot = drawn.shots[0];
    }
  }
  return { ok: !problems.length, usable: true, problems, warnings, pkg, tests: { passed: test.passed, failed: test.failed.length }, ...(shot ? { shot } : {}) };
}

export function verdictText(v: PackageVerdict): string {
  return [...v.problems.map((p) => `- ${p}`), ...(v.warnings.length ? ["Warnings (fix if you can):", ...v.warnings.map((w) => `- ${w}`)] : [])].join("\n");
}

export async function buildPackage(o: PackageBuildOptions): Promise<PackageBuildResult> {
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const emit = (e: BuildEvent) => o.onEvent?.(e);
  const system = buildPackageSystem(o.systemFile);
  const base = { usage: { ...EMPTY_USAGE }, model: o.backend.model, backend: o.backend.name, trace: [] as TraceStep[], repairs: [] as string[], summary: "", promptHash: promptHash(system), ending: null };

  if (!o.noFast) {
    const fast = fastRoute(o.prompt);
    if (fast) {
      emit({ type: "route", route: fast.route, at: at() });
      return { ...base, route: fast.route, fast, ok: true, verdict: { ...EMPTY_VERDICT, ok: true, usable: true }, timings: { done: at() } };
    }
  }
  emit({ type: "route", route: "agent", at: at() });

  // The token ceiling: the run's own signal, aborted when the usage passes it.
  const ac = new AbortController();
  const stop = () => ac.abort();
  o.signal?.addEventListener("abort", stop, { once: true });
  let stopped: string | undefined;
  const usage = { ...EMPTY_USAGE, costUSD: 0 };
  let live = 0;
  const count = (u: Usage) => {
    live += tokens(u);
    if (o.maxTokens && tokens(usage) + live > o.maxTokens && !stopped) {
      stopped = `It stopped at ${o.maxTokens.toLocaleString("en")} tokens, the limit for one build (Settings → Magic Widgets).`;
      ac.abort();
    }
  };

  const explore = o.explore ?? true;
  const sandbox = o.sandbox ?? "required";
  const deny = o.deny ?? magicDenyPaths();
  const ctx: ToolContext = { cwd: o.cwd, home: os.homedir(), deny, sandbox, signal: ac.signal };
  const run: RunOptions = { sandbox, deny, signal: ac.signal, cmdVersion: o.cmdVersion ?? null };
  const pc: PackageToolContext = { dir: o.dir, toolchain: o.toolchain === undefined ? checkoutToolchain() : o.toolchain, run, previewer: o.previewer ?? (async () => null), ask: o.ask, granted: o.granted };
  const state: PackageToolState = { dirty: false, ending: null, declined: null, onPackage: (title, icon) => emit({ type: "title", title, icon, at: at() }) };
  const trace: TraceStep[] = [];
  const timings: PackageBuildResult["timings"] = { done: 0 };
  let stepId = 0;
  const exec = async (name: string, input: Record<string, unknown>): Promise<ToolOutput> => {
    const id = ++stepId;
    const why = typeof input.why === "string" ? input.why : name;
    timings.firstStep ??= at();
    emit({ type: "step-start", id, tool: name, why, input, at: at() });
    const start = Date.now();
    // After an ending (terminal, needs_program) the build is over: nothing more runs.
    const out = state.ending
      ? { output: "The build is over: finish with one short sentence.", isError: true }
      : await (async () => (await runPackageTool(name, input, pc, state)) ?? (await runTool(name, input, ctx)))().catch((e: Error) => ({ output: e.message, isError: true }) as ToolOutput);
    const ms = Date.now() - start;
    const logged = name === "write_file" ? { ...input, content: `(${String(input.content ?? "").length} characters)` } : input;
    trace.push({ id, tool: name, why, input: logged, output: out.output.slice(0, 20_000), isError: out.isError, ms });
    emit({ type: "step-end", id, ms, output: out.output, isError: out.isError, at: at() });
    return out;
  };

  const canRun = commandsSupported(sandbox);
  const tools = [...toolsFor(explore).filter((t) => canRun || t.name !== "run"), ...PACKAGE_TOOL_SPECS];
  const files = snapshotFiles(o.dir);
  const request = buildPackageRequest(o.prompt, { cwd: o.cwd, workspace: o.workspace, explore, canRun, dir: o.dir, name: o.name, files });
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: request }];
  let model = o.backend.model;

  const turn = async (maxSteps: number): Promise<string> => {
    live = 0;
    try {
      const r = await o.backend.run({ system, messages, tools, exec, maxSteps, signal: ac.signal, onUsage: count, onTurn: () => emit({ type: "turn", at: at() }), onText: (delta) => emit({ type: "text", delta, at: at() }) });
      usage.input += r.usage.input;
      usage.output += r.usage.output;
      usage.cacheRead += r.usage.cacheRead;
      usage.cacheWrite += r.usage.cacheWrite;
      if (r.usage.costUSD !== undefined) usage.costUSD += r.usage.costUSD;
      live = 0;
      model = r.model;
      if (o.maxTokens && tokens(usage) > o.maxTokens) stopped ??= `It stopped at ${o.maxTokens.toLocaleString("en")} tokens, the limit for one build (Settings → Magic Widgets).`;
      return r.text;
    } catch (e) {
      // The ceiling aborted it: what it used so far is an estimate (the steps reported).
      if (stopped && !o.signal?.aborted) {
        usage.input += live;
        return "";
      }
      throw e;
    }
  };

  const finish = (verdict: PackageVerdict, summary: string, repairs: string[]): PackageBuildResult => {
    o.signal?.removeEventListener("abort", stop);
    timings.done = at();
    return { ...base, route: "agent", ending: state.ending, ok: verdict.ok && !stopped, verdict, ...(stopped ? { stopped } : {}), summary: summary.trim().slice(0, 600), repairs, trace, usage, model, timings };
  };

  // The tools set these while the model runs (TypeScript can't see that through the awaits).
  const ended = (): PackageEnding | null => state.ending;
  const endingVerdict = (e: PackageEnding): PackageVerdict => (e.kind === "terminal" ? { ...EMPTY_VERDICT, ok: true, usable: true } : { ...EMPTY_VERDICT, problems: [e.reason] });

  let summary = await turn(o.maxSteps ?? 40);
  if (stopped) return finish({ ...EMPTY_VERDICT, problems: [stopped] }, summary, []);
  const first = ended();
  if (first) return finish(endingVerdict(first), summary, []);
  emit({ type: "verify", at: at() });
  let verdict = await verifyPackage(pc, state);
  const repairs: string[] = [];
  for (let i = 0; !verdict.ok && i < (o.maxRepairs ?? 2) && !ac.signal.aborted; i++) {
    const reason = `cmd checked the package and found problems. Fix them in the files, run check, test and preview again, then finish with one short sentence.\n\n${verdictText(verdict)}`;
    repairs.push(reason);
    emit({ type: "repair", reason: verdict.problems[0] ?? "problems", at: at() });
    messages.push({ role: "assistant", content: summary || "(done)" }, { role: "user", content: reason });
    summary = await turn(15);
    if (stopped) return finish({ ...verdict, ok: false, problems: [stopped, ...verdict.problems] }, summary, repairs);
    const e = ended();
    if (e) return finish(endingVerdict(e), summary, repairs);
    emit({ type: "verify", at: at() });
    verdict = await verifyPackage(pc, state);
  }
  return finish(verdict, summary, repairs);
}
