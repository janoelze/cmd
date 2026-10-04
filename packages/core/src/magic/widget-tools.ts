// The Magic agent's tools for building a widget (docs/14-magic-v2.md): write
// and edit the widget's files, and check, run and render it the way cmd will.
// They work on one widget folder; the agent can't touch anything else.

import { redact } from "./policy.ts";
import { preview as previewData } from "./sources.ts";
import { checkWidget, previewWidget, runWidgetData, type VerifyContext } from "../widgets/verify.ts";
import type { ToolOutput, ToolSpec } from "./tools.ts";
import { lintBody } from "./lint.ts";
import { WIDGET_FILES } from "../widgets/store.ts";

const why = { type: "string", description: 'A few words for the person saying what this step does, e.g. "Writing the view".' };
const obj = (props: Record<string, unknown>, required: string[]) => ({ type: "object", properties: { why, ...props }, required: ["why", ...required], additionalProperties: false });
const FILES = `${WIDGET_FILES.join(", ")} or fixtures/<name>.json`;

export const WIDGET_TOOL_SPECS: ToolSpec[] = [
  {
    name: "write_file",
    explores: false,
    description: `Write a whole file of the widget (${FILES}). Use it for new files and to rewrite small ones.`,
    schema: obj({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  },
  {
    name: "edit_file",
    explores: false,
    description: "Replace one exact, unique piece of text in a widget file with another (for small changes to a larger file).",
    schema: obj({ path: { type: "string" }, old: { type: "string", description: "Text that occurs exactly once in the file." }, new: { type: "string" } }, ["path", "old", "new"]),
  },
  {
    name: "read_file",
    explores: false,
    description: "Read one of the widget's files.",
    schema: obj({ path: { type: "string" } }, ["path"]),
  },
  {
    name: "check",
    explores: false,
    description: "Validate manifest.json and type-check data.ts and view.ts (view.ts against data.ts's schema). Fast; run it after writing files.",
    schema: obj({}, []),
  },
  {
    name: "run_data",
    explores: false,
    description: "Run data.ts exactly as cmd will on every refresh (its permissions, the sandbox, the window's config) and validate the result against its schema. On success the data is saved as fixtures/live.json and shown to you.",
    schema: obj({}, []),
  },
  {
    name: "preview",
    explores: false,
    description: "Render the view with the live data and every fixture: in a tall strip window, at its own size, wide and small, dark and light. Reports script errors, empty renders, overflow and layout problems (content floating in the middle, an empty tall window), and returns screenshots: look at them.",
    schema: obj({}, []),
  },
];

export interface WidgetToolState {
  /** A file changed since the checks last passed. */
  dirty: boolean;
  /** The manifest parsed after the last write (for the window's title). */
  onManifest?: (title: string) => void;
}

const err = (output: string): ToolOutput => ({ output, isError: true });
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export async function runWidgetTool(name: string, input: Record<string, unknown>, c: VerifyContext, state: WidgetToolState): Promise<ToolOutput | null> {
  const secrets = Object.values(c.secrets ?? {});
  const scrub = (s: string) => {
    let out = redact(s);
    for (const v of secrets) if (v.length >= 4) out = out.replaceAll(v, "[secret]");
    return out;
  };
  switch (name) {
    case "write_file": {
      const p = str(input.path);
      const content = str(input.content);
      if (!p || content === undefined) return err("path and content are required");
      try {
        c.store.write(c.id, p, content);
      } catch (e) {
        return err((e as Error).message);
      }
      state.dirty = true;
      return { output: `Wrote ${p} (${content.length} characters).${afterWrite(c, p, state)}`, isError: false };
    }
    case "edit_file": {
      const p = str(input.path);
      const old = str(input.old);
      const nu = str(input.new);
      if (!p || old === undefined || nu === undefined) return err("path, old and new are required");
      let text: string | null;
      try {
        text = c.store.read(c.id, p);
      } catch (e) {
        return err((e as Error).message);
      }
      if (text === null) return err(`${p} doesn't exist; use write_file`);
      const n = text.split(old).length - 1;
      if (n !== 1) return err(n === 0 ? `the text to replace isn't in ${p} (read_file it first)` : `the text to replace occurs ${n} times in ${p}; include more around it`);
      c.store.write(c.id, p, text.replace(old, () => nu));
      state.dirty = true;
      return { output: `Edited ${p}.${afterWrite(c, p, state)}`, isError: false };
    }
    case "read_file": {
      const p = str(input.path);
      if (!p) return err("path is required");
      try {
        const t = c.store.read(c.id, p);
        return t === null ? err(`${p} doesn't exist (the widget has: ${c.store.files(c.id).join(", ") || "no files yet"})`) : { output: t, isError: false };
      } catch (e) {
        return err((e as Error).message);
      }
    }
    case "check": {
      const st = await checkWidget(c);
      const lint = lintBody((c.store.read(c.id, "view.html") ?? "") + (c.store.read(c.id, "view.ts") ?? ""));
      const notes = lint.literalColors.length ? `\nNote: literal colours ${lint.literalColors.join(" ")}: use the theme variables instead.` : "";
      return st.ok ? { output: `OK: manifest valid, types check.${notes}`, isError: false } : err(`${st.problems.join("\n")}${notes}`);
    }
    case "run_data": {
      const st = c.store.manifest(c.id);
      if (!st.ok) return err(`manifest.json: ${st.errors.join("; ")}`);
      const d = await runWidgetData(c, st.manifest);
      if (d.none) return { output: "This widget has no data.ts: its view gets no data (fine for timers, clocks, tools).", isError: false };
      if (!d.ok) {
        const r = d.result;
        const extra = [r?.issues?.length ? `Schema issues:\n${r.issues.map((i) => `- ${i.path || "(root)"}: ${i.message}`).join("\n")}` : "", r?.issues && r.data !== undefined ? `The data it returned:\n${previewData(r.data, 3000)}` : "", r?.stack ? `Stack:\n${r.stack}` : "", r?.stderr ? `stderr:\n${r.stderr.slice(0, 1500)}` : ""].filter(Boolean);
        return err(scrub([d.problem ?? "failed", ...extra].join("\n\n")));
      }
      const ms = d.result?.ms;
      return { output: scrub(`OK${ms !== undefined ? ` in ${ms} ms` : ""}; saved as fixtures/live.json. The view's cmd.onData gets:\n${previewData(d.data, 6000)}${d.result?.stderr ? `\n\nstderr:\n${d.result.stderr.slice(0, 800)}` : ""}`), isError: false };
    }
    case "preview": {
      const st = c.store.compose(c.id);
      if (!st.manifest) return err(`manifest.json: ${st.errors.join("; ")}`);
      if (st.manifest.kind === "terminal") return { output: "A terminal widget has no view to render.", isError: false };
      if (st.errors.length) return err(st.errors.join("\n"));
      const live = c.store.fixtures(c.id).find((f) => f.name === "live")?.data ?? c.store.staticData(c.id);
      const r = await previewWidget(c, st.manifest, st.html, live);
      const pictures = r.skipped ? "" : "\nScreenshots: a strip window (dark), its own size (light), wide.";
      const text = r.skipped ? r.warnings.join("\n") : r.ok ? `Renders cleanly in every case.${r.warnings.length ? `\nWarnings:\n- ${r.warnings.join("\n- ")}` : ""}` : `Problems:\n- ${r.problems.join("\n- ")}${r.warnings.length ? `\nWarnings:\n- ${r.warnings.join("\n- ")}` : ""}`;
      if (r.ok) state.dirty = false;
      return { output: text + pictures + (live === undefined && c.store.read(c.id, "data.ts") !== null ? "\n(No live data yet: run run_data first.)" : ""), isError: !r.ok, images: [r.shot, ...(r.shots ?? [])].filter((x): x is string => !!x) };
    }
  }
  return null;
}

/** After a write: say at once when manifest.json is broken, and report its title. */
function afterWrite(c: VerifyContext, p: string, state: WidgetToolState): string {
  if (p !== "manifest.json") return "";
  const m = c.store.manifest(c.id);
  if (!m.ok) return ` But it isn't valid: ${m.errors.join("; ")}`;
  state.onManifest?.(m.manifest.title);
  return "";
}
