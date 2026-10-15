// The Magic agent's tools for building a widget package (docs/56, "Magic on V3"): write and
// edit the package's own files, check it (package.json and the types against the API), test
// it with the fake host, and preview its trees drawn by the app. Two more end the build
// without a package: `terminal` (an existing program shows it best) and `needs_program`
// (it needs a program a widget can't run: cmd.run runs read-only commands only). They work on
// one package folder; nothing else is reachable, grants.json least of all.

import type { WidgetPermissions } from "@cmd/protocol";
import { redact } from "../../lib/policy.ts";
import type { ToolOutput, ToolSpec } from "../tools.ts";
import type { Previewer } from "../previewer.ts";
import { readPackage, type WidgetPackage } from "../../widgets/package.ts";
import { WRITABLE, listFiles, readFile, writeFile } from "./files.ts";
import { previewTrees } from "./preview.ts";
import type { RunOptions, Toolchain } from "./toolchain.ts";

const why = { type: "string", description: 'A few words for the person saying what this step does, e.g. "Writing the widget".' };
const obj = (props: Record<string, unknown>, required: string[]) => ({ type: "object", properties: { why, ...props }, required: ["why", ...required], additionalProperties: false });

export const PACKAGE_TOOL_SPECS: ToolSpec[] = [
  {
    name: "write_file",
    explores: false,
    description: `Write a whole file of the package (${WRITABLE}). Use it for new files and to rewrite small ones.`,
    schema: obj({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  },
  {
    name: "edit_file",
    explores: false,
    description: "Replace one exact, unique piece of text in a package file with another (for small changes to a larger file).",
    schema: obj({ path: { type: "string" }, old: { type: "string", description: "Text that occurs exactly once in the file." }, new: { type: "string" } }, ["path", "old", "new"]),
  },
  {
    name: "read_file",
    explores: false,
    description: "Read one of the package's files.",
    schema: obj({ path: { type: "string" } }, ["path"]),
  },
  {
    name: "check",
    explores: false,
    description: "Validate package.json and type-check src/ against @cmd/widget-api, as `cmd widget check` does. The first time package.json asks for permissions, the person is asked to allow them: the answer comes back here. Fast; run it after writing files.",
    schema: obj({}, []),
  },
  {
    name: "test",
    explores: false,
    description: "Run the package's tests (src/*.test.tsx) with @cmd/widget-api/testing: the fake host serves the fixtures, never the real network.",
    schema: obj({}, []),
  },
  {
    name: "preview",
    explores: false,
    description: "Render each state of the widget (its story's exports, else each fixture) with the fake host and draw the tree with cmd's kit: narrow (dark), wide (light), and the other states at their own size. Returns the trees as text and screenshots: look at them.",
    schema: obj({}, []),
  },
  {
    name: "terminal",
    explores: false,
    description: "Finish with a terminal instead of a widget: cmd types `command` into a new terminal for the person to run. Only when an existing program already shows this well and interactively (btop, `log stream`, `tail -f`), or the request is plainly a command to run.",
    schema: obj({ command: { type: "string" }, title: { type: "string" }, icon: { type: "string", description: "An SF Symbol name." } }, ["command", "title"]),
  },
  {
    name: "needs_program",
    explores: false,
    description: "Stop without a widget because the request needs a program in a way a widget can't run it: one that changes something, runs until stopped, or isn't read-only (cmd.run runs read-only commands only: `gh run list` yes, `gh run rerun` no). Name the programs; cmd tells the person.",
    schema: obj({ programs: { type: "array", items: { type: "string" } }, reason: { type: "string", description: "One sentence for the person: what it would need to run, and why." } }, ["programs", "reason"]),
  },
];

/** What a tool call ended the build with, besides a package. */
export type PackageEnding = { kind: "terminal"; command: string; title: string; icon?: string } | { kind: "needs-program"; programs: string[]; reason: string };

export interface PackageToolContext {
  dir: string;
  toolchain: Toolchain | null;
  run: RunOptions;
  previewer: () => Promise<Previewer | null>;
  /**
   * The permission step: the package asks for what its grant lacks; resolves once the person
   * answered (allow) or declined, with why (the agent gets it). Without one, nothing is asked.
   */
  ask?: (pkg: WidgetPackage) => Promise<{ allow: boolean; reason?: string }>;
  /** The grant the package has (null: none), to tell whether to ask. */
  granted?: () => WidgetPermissions | null;
}

export interface PackageToolState {
  /** A file changed since the last passing check. */
  dirty: boolean;
  ending: PackageEnding | null;
  /** The person declined what the package asked for, with the permissions asked then. */
  declined: string | null;
  /** package.json parsed after a write (the window's title and icon). */
  onPackage?: (title: string, icon?: string) => void;
}

const err = (output: string): ToolOutput => ({ output, isError: true });
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Whether `declared` asks for anything `granted` doesn't have. */
function wantsMore(declared: WidgetPermissions, granted: WidgetPermissions | null): boolean {
  return (Object.keys(declared) as (keyof WidgetPermissions)[]).some((k) => declared[k].some((x) => !granted?.[k]?.includes(x)));
}

/** The permission step, if the package asks for more than its grant: the person's answer as the tool's words. */
export async function permissionStep(pkg: WidgetPackage, c: PackageToolContext, state: PackageToolState): Promise<string | null> {
  if (!c.ask) return null;
  if (!wantsMore(pkg.permissions, c.granted?.() ?? null)) {
    state.declined = null; // it asks for no more than it has now
    return null;
  }
  const asked = JSON.stringify(pkg.permissions);
  if (state.declined === asked) return `The person declined these permissions: ask for less, or say what the widget can't do without them.`;
  const a = await c.ask(pkg);
  if (a.allow) {
    state.declined = null;
    return "The person allowed what package.json asks for.";
  }
  state.declined = asked;
  return `The person declined what package.json asks for${a.reason ? ` (${a.reason})` : ""}. Ask for less (change cmd.permissions and the code that needs it), or finish saying what the widget can't do without it.`;
}

export async function runPackageTool(name: string, input: Record<string, unknown>, c: PackageToolContext, state: PackageToolState): Promise<ToolOutput | null> {
  switch (name) {
    case "write_file": {
      const p = str(input.path);
      const content = str(input.content);
      if (!p || content === undefined) return err("path and content are required");
      try {
        const rel = writeFile(c.dir, p, content);
        state.dirty = true;
        return { output: `Wrote ${rel} (${content.length} characters).${afterWrite(c, rel, state)}`, isError: false };
      } catch (e) {
        return err((e as Error).message);
      }
    }
    case "edit_file": {
      const p = str(input.path);
      const old = str(input.old);
      const nu = str(input.new);
      if (!p || old === undefined || nu === undefined) return err("path, old and new are required");
      try {
        const text = readFile(c.dir, p);
        if (text === null) return err(`${p} doesn't exist; use write_file`);
        const n = text.split(old).length - 1;
        if (n !== 1) return err(n === 0 ? `the text to replace isn't in ${p} (read_file it first)` : `the text to replace occurs ${n} times in ${p}; include more around it`);
        const rel = writeFile(c.dir, p, text.replace(old, () => nu));
        state.dirty = true;
        return { output: `Edited ${rel}.${afterWrite(c, rel, state)}`, isError: false };
      } catch (e) {
        return err((e as Error).message);
      }
    }
    case "read_file": {
      const p = str(input.path);
      if (!p) return err("path is required");
      try {
        const t = readFile(c.dir, p);
        return t === null ? err(`${p} doesn't exist (the package has: ${listFiles(c.dir).join(", ") || "no files yet"})`) : { output: t, isError: false };
      } catch (e) {
        return err((e as Error).message);
      }
    }
    case "check": {
      if (!c.toolchain) return err("cmd can't check packages here (its TypeScript isn't installed).");
      const r = await c.toolchain.check(c.dir, c.run);
      const asked = r.pkg ? await permissionStep(r.pkg, c, state) : null;
      const note = asked ? `\n${asked}` : "";
      if (!r.ok) return err(`${r.problems.join("\n")}${note}`);
      return { output: `OK: package.json is valid${r.types === "checked" ? " and the types check" : " (types not checked: this cmd has no TypeScript)"}.${note}`, isError: !!state.declined };
    }
    case "test": {
      if (!c.toolchain) return err("cmd can't run tests here (its Vitest isn't installed).");
      const r = await c.toolchain.test(c.dir, c.run);
      if (r.skipped) return { output: `Not run: ${r.skipped}. cmd checked package.json only.`, isError: false };
      if (r.ok) return { output: `OK: ${r.passed} test${r.passed === 1 ? "" : "s"} passed.`, isError: false };
      const lines = [...r.problems, ...r.failed.map((f) => `✗ ${f.name}\n${f.message}`)];
      return err(redact(`${r.passed} passed, ${r.failed.length} failed.\n${lines.join("\n\n")}`));
    }
    case "preview": {
      if (!c.toolchain) return err("cmd can't render packages here (its Vitest isn't installed).");
      const t = await c.toolchain.trees(c.dir, c.run);
      if (t.skipped) return { output: `Not rendered: ${t.skipped}.`, isError: false };
      if (!t.variants.length) return err(t.problems.join("\n") || "nothing rendered");
      const drawn = await previewTrees(await c.previewer().catch(() => null), t.variants, widgetsOf(c.dir));
      const problems = [...t.problems, ...drawn.problems];
      if (!problems.length) state.dirty = false;
      const outlines = t.variants.map((v) => `--- ${v.widget} · ${v.name} ---\n${v.outline.split("\n").slice(0, 60).join("\n") || "(nothing)"}`).join("\n\n");
      const head = problems.length ? `Problems:\n- ${problems.join("\n- ")}` : "Renders cleanly in every state.";
      const warn = drawn.warnings.length ? `\nWarnings:\n- ${drawn.warnings.join("\n- ")}` : "";
      const pics = drawn.skipped ? `\n(Not drawn: ${drawn.skipped}.)` : `\nScreenshots: ${t.variants[0]!.name} narrow (dark) and wide (light)${t.variants.length > 1 ? ", then the other states" : ""}.`;
      return { output: redact(`${head}${warn}${pics}\n\nThe trees:\n${outlines}`), isError: problems.length > 0, images: drawn.shots.slice(0, 4) };
    }
    case "terminal": {
      const command = str(input.command)?.trim();
      const title = str(input.title)?.trim();
      if (!command || !title) return err("command and title are required");
      state.ending = { kind: "terminal", command, title: title.slice(0, 80), ...(str(input.icon) ? { icon: str(input.icon) } : {}) };
      return { output: "OK: cmd opens this as a terminal. Finish with one short sentence.", isError: false };
    }
    case "needs_program": {
      const programs = Array.isArray(input.programs) ? input.programs.filter((p): p is string => typeof p === "string" && !!p.trim()).map((p) => p.trim()).slice(0, 8) : [];
      const reason = str(input.reason)?.trim();
      if (!programs.length || !reason) return err("name the programs and the reason");
      state.ending = { kind: "needs-program", programs, reason: reason.slice(0, 400) };
      return { output: "OK: cmd tells the person. Finish with one short sentence.", isError: false };
    }
  }
  return null;
}

/** After a write of package.json: report its title and icon, or say at once that it isn't JSON. */
function afterWrite(c: PackageToolContext, rel: string, state: PackageToolState): string {
  if (rel !== "package.json") return "";
  try {
    const j = JSON.parse(readFile(c.dir, "package.json") ?? "") as { cmd?: { widgets?: { title?: unknown; icon?: unknown }[] } };
    const w = j.cmd?.widgets?.[0];
    if (typeof w?.title === "string") state.onPackage?.(w.title, typeof w.icon === "string" ? w.icon : undefined);
    return "";
  } catch (e) {
    return ` But it isn't valid JSON: ${(e as Error).message}`;
  }
}

/** The package's widgets' titles and icons, as package.json says now (the previews' title bars). */
function widgetsOf(dir: string): Map<string, { title: string; icon: string }> {
  const r = readPackage(dir);
  return new Map(r.ok ? r.pkg.widgets.map((w) => [w.id, { title: w.title, icon: w.icon }]) : []);
}
