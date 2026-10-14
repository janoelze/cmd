// The Magic system prompt for widget packages (docs/56, "Magic on V3"): prompt/prompt.md,
// then the API reference as @cmd/widget-api's README has it (generated from the d.ts by
// `pnpm widget-api:docs`, read here at build time so the agent reads the same contract a
// developer does, never a copy), then the examples in prompt/examples/<n>-<name>/ (request.md,
// and the package's files or, for a build that ends without one, ending.json: the tool call).
// Read from disk on every call; the system prompt is byte-stable between requests (cached)
// and its hash goes into every eval report. Per request: the user message.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROMPT_DIR, type RequestContext } from "../prompt.ts";
import { REPO } from "./toolchain.ts";

export const API_README = path.join(REPO, "packages/widget-api/README.md");
export const EXAMPLES_DIR = path.join(PROMPT_DIR, "examples");

/** The README's generated reference (between its reference markers), or a note when this cmd lacks it. */
export function apiReference(file = API_README): string {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return "(The API reference isn't in this cmd: write against what the examples use.)";
  }
  const m = /<!-- reference:start[^>]*-->([\s\S]*?)<!-- reference:end -->/.exec(text);
  return (m?.[1] ?? text).trim();
}

/** Where an example's file is shown: package.json, the widget, its test and story, other sources, fixtures, the rest. */
function rank(f: string): number {
  if (f === "package.json") return 0;
  if (/^src\/[^/]+\.tsx$/.test(f) && !/\.(test|story)\.tsx$/.test(f)) return 1;
  if (f.endsWith(".test.tsx")) return 3;
  if (f.endsWith(".story.tsx")) return 4;
  if (f.startsWith("src/")) return 2;
  if (f.startsWith("fixtures/")) return 5;
  return 6;
}

/** An example's files (relative), in the order they are shown. */
export function exampleFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      if (e.isDirectory()) walk(r);
      else if (r !== "request.md") out.push(r);
    }
  };
  walk("");
  return out.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** The examples' folders, in order. */
export function examples(dir = EXAMPLES_DIR): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((n) => path.join(dir, n));
}

function example(dir: string): string {
  const request = fs.readFileSync(path.join(dir, "request.md"), "utf8").trim();
  const files = exampleFiles(dir);
  if (files.includes("ending.json")) {
    const e = JSON.parse(fs.readFileSync(path.join(dir, "ending.json"), "utf8")) as { tool: string; input: Record<string, unknown> };
    return `<example>\n${request}\n\nNo package: the build ends with ${e.tool}(${JSON.stringify(e.input)}).\n</example>`;
  }
  const body = files.map((f) => `--- ${f} ---\n${fs.readFileSync(path.join(dir, f), "utf8").trim()}`).join("\n\n");
  return `<example>\n${request}\n\n${body}\n</example>`;
}

/** The system prompt; `file` replaces prompt.md (prompt variants for evals). */
export function buildPackageSystem(file?: string): string {
  const main = fs.readFileSync(file ?? path.join(PROMPT_DIR, "prompt.md"), "utf8").trim();
  return `${main}\n\n# The API: @cmd/widget-api\n\nThe whole contract a widget is written against, generated from its types (everything here is in API 1 for good).\n\n${apiReference()}\n\n# Examples\n\nFinished widgets (check, test and preview passed for each), and two builds that ended without a package.\n\n${examples().map(example).join("\n\n")}\n`;
}

/** A short hash of a system prompt, for eval reports and the log. */
export const promptHash = (system: string): string => crypto.createHash("sha256").update(system).digest("hex").slice(0, 12);

export interface PackageRequestContext extends Omit<RequestContext, "widgetDir"> {
  /** The package's folder and name. */
  dir: string;
  name: string;
}

/** The user message: the request, where and when it was made, the package's folder and, for a change, its files. */
export function buildPackageRequest(prompt: string, c: PackageRequestContext): string {
  const now = c.now ?? new Date();
  const home = c.home ?? os.homedir();
  const short = (p: string) => (p === home ? "~" : p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lines = [`Request: ${prompt}`, "", `Context: macOS ${os.release()} (Darwin), user ${os.userInfo().username}, home ${home}, current folder ${short(c.cwd)}, ${now.toLocaleString("en-GB", { timeZone: tz })} ${tz}.`];
  if (c.workspace)
    lines.push(
      `Workspace: this window belongs to the workspace "${c.workspace.name}" at ${short(c.workspace.root)}. "This project", "the repo", "my agents" or a relative path mean this workspace unless the request names another place; the tools start there, and the widget sees it through the API.`,
    );
  if (!c.explore) lines.push("Looking around this Mac is off for this request: answer without the run, read and list tools.");
  else if (c.canRun === false) lines.push(`Shell commands can't run here: there is no run tool. Use read and list.`);
  lines.push(`Package folder: ${short(c.dir)}; its name: "${c.name}".`);
  const files = Object.entries(c.files ?? {});
  if (files.length) {
    lines.push("", "The package's files now (change what the request asks for, keep the rest working; keep its name and widget ids):");
    for (const [f, text] of files) lines.push("", `--- ${f} ---`, text.trim());
  } else lines.push("The package has no files yet.");
  return lines.join("\n");
}
