// Does a widget work? (docs/14-magic-v2.md) The same steps for the agent's
// check / run_data / preview tools, for cmd's own check before it accepts a
// build, and for `cmd widget check`: the manifest and view compose, data.ts and
// view.ts type-check against the schema, data.ts runs and returns data of that
// shape (kept as fixtures/live.json), and the view renders it, and every other
// fixture, without errors.

import { preview, previewCases, type Previewer, type PreviewReport } from "./preview.ts";
import { checkTypes, describeDataError, runData, type DataResult, type DenoEnv } from "./deno.ts";
import { configValues, type WidgetManifest } from "./manifest.ts";
import type { WidgetStore } from "./store.ts";

export interface VerifyContext {
  store: WidgetStore;
  id: string;
  /** null: Deno is missing, so data.ts can't be checked or run. */
  deno: DenoEnv | null;
  previewer: Previewer | null;
  cwd: string;
  /** The window's config values (manifest defaults fill the rest). */
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
  signal?: AbortSignal;
}

export interface StaticCheck {
  ok: boolean;
  manifest?: WidgetManifest;
  html: string;
  problems: string[];
  warnings: string[];
}

const NO_DENO = "Deno isn't installed, so data.ts can't run (cmd can install it: Settings → Magic Windows)";

/** Manifest, composing the view, and type-checking (no code runs). */
export async function checkWidget(c: VerifyContext): Promise<StaticCheck> {
  const composed = c.store.compose(c.id);
  const problems = [...composed.errors];
  const hasCode = c.store.read(c.id, "data.ts") !== null || c.store.read(c.id, "view.ts") !== null;
  if (composed.manifest?.kind === "widget" && hasCode) {
    if (!c.deno) problems.push(NO_DENO);
    else {
      const t = await checkTypes(c.store.dir(c.id), c.deno);
      problems.push(...t.errors.map((e) => `type error: ${e}`));
    }
  }
  const warnings = composed.manifest?.kind === "widget" && composed.manifest.refresh && c.store.read(c.id, "data.ts") === null ? ["manifest.refresh is set but there is no data.ts (it has no effect)"] : [];
  return { ok: !problems.length, manifest: composed.manifest, html: composed.html, problems, warnings };
}

export interface DataRun {
  ok: boolean;
  data?: unknown;
  /** No data.ts (and no static.json): nothing to run. */
  none?: boolean;
  result?: DataResult;
  problem?: string;
}

/** Run data.ts (or read static.json); on success keep the data as fixtures/live.json. */
export async function runWidgetData(c: VerifyContext, m: WidgetManifest): Promise<DataRun> {
  if (c.store.read(c.id, "data.ts") === null) {
    const st = c.store.staticData(c.id);
    return st === undefined ? { ok: true, none: true } : { ok: true, data: st };
  }
  if (!c.deno) return { ok: false, problem: NO_DENO };
  const config = { ...configValues(m, c.config), ...c.secrets };
  const r = await runData(c.store.dir(c.id), m, { ...c.deno, cwd: c.cwd, config, signal: c.signal });
  if (!r.ok) return { ok: false, result: r, problem: `data.ts: ${describeDataError(r, Object.values(c.secrets ?? {}))}` };
  c.store.write(c.id, "fixtures/live.json", JSON.stringify(r.data, null, 1).slice(0, 200_000) + "\n");
  return { ok: true, data: r.data, result: r };
}

export async function previewWidget(c: VerifyContext, m: WidgetManifest, html: string, live: unknown): Promise<PreviewReport> {
  return preview(c.previewer, html, m, previewCases(m, live, c.store.fixtures(c.id)));
}

export interface Verdict {
  ok: boolean;
  /** Good enough to show (renders without script errors), even with problems left. */
  usable: boolean;
  manifest?: WidgetManifest;
  html: string;
  data?: unknown;
  problems: string[];
  warnings: string[];
  shot?: string;
  dataResult?: DataResult;
}

/** All of it, in order; later steps run as far as they can. */
export async function verifyWidget(c: VerifyContext): Promise<Verdict> {
  const st = await checkWidget(c);
  const problems = [...st.problems];
  const warnings = [...st.warnings];
  if (!st.manifest) return { ok: false, usable: false, html: st.html, problems, warnings };
  if (st.manifest.kind === "terminal") return { ok: !problems.length, usable: true, manifest: st.manifest, html: "", problems, warnings };
  const d = await runWidgetData(c, st.manifest);
  if (d.problem) problems.push(d.problem);
  // A failed run still lets the view be checked against the last good data.
  const live = d.ok ? d.data : c.store.fixtures(c.id).find((f) => f.name === "live")?.data;
  const pr = await previewWidget(c, st.manifest, st.html, live);
  problems.push(...pr.problems);
  warnings.push(...pr.warnings);
  const scriptErrors = pr.problems.some((p) => /script error|draws nothing/.test(p));
  const usable = !!st.html.trim() && !scriptErrors && st.problems.every((p) => !/^(the widget has no view|view\.ts|manifest)/.test(p));
  return { ok: !problems.length, usable, manifest: st.manifest, html: st.html, data: d.ok ? d.data : undefined, problems, warnings, shot: pr.shot, dataResult: d.result };
}

/** A report for the agent: what passed and what to fix. */
export function verdictText(v: Verdict): string {
  if (v.ok) return `All checks passed${v.warnings.length ? `, with warnings:\n- ${v.warnings.join("\n- ")}` : "."}`;
  return `Problems:\n- ${v.problems.join("\n- ")}${v.warnings.length ? `\nWarnings:\n- ${v.warnings.join("\n- ")}` : ""}`;
}
