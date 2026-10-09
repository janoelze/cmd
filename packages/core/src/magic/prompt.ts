// The Magic system prompt: prompt/prompt.md, then the example widgets in
// prompt/examples/<name>/ (request.md and the widget's files). Read from disk on
// every call, so editing them applies on the next `cmd magic` run. The system
// prompt stays byte-stable between requests (it is cached); everything per
// request goes into the user message.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompt");

/** The order an example's files are shown in. */
const EXAMPLE_ORDER = ["manifest.json", "data.ts", "view.html", "view.ts"];

/** The system prompt; `file` replaces prompt.md (prompt variants for evals). */
export function buildSystem(file?: string): string {
  const main = fs.readFileSync(file ?? path.join(PROMPT_DIR, "prompt.md"), "utf8").trim();
  const dir = path.join(PROMPT_DIR, "examples");
  const examples = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((name) => {
      const ex = path.join(dir, name);
      const request = fs.readFileSync(path.join(ex, "request.md"), "utf8").trim();
      const files = fs
        .readdirSync(ex)
        .filter((f) => f !== "request.md" && !f.startsWith(".") && f !== "deno.json" && fs.statSync(path.join(ex, f)).isFile())
        .sort((a, b) => (EXAMPLE_ORDER.indexOf(a) + 1 || 99) - (EXAMPLE_ORDER.indexOf(b) + 1 || 99));
      const body = files.map((f) => `--- ${f} ---\n${fs.readFileSync(path.join(ex, f), "utf8").trim()}`).join("\n\n");
      return `<example>\n${request}\n\n${body}\n</example>`;
    });
  return `${main}\n\n# Examples\n\nFinished widgets (the checks passed for each).\n\n${examples.join("\n\n")}\n`;
}

/** The workspace a window belongs to (not Home): what "this project" or a relative path means. */
export interface Workspace {
  name: string;
  root: string;
}

/** Files that say what kind of folder a workspace is, checked cheaply (no reads). */
const MARKERS = [".git", "package.json", "pnpm-workspace.yaml", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "Gemfile", "Package.swift", "pom.xml", "build.gradle", "composer.json", "Makefile", "docker-compose.yml", "compose.yaml"];

function describeFolder(root: string): string {
  const has = MARKERS.filter((m) => fs.existsSync(path.join(root, m)));
  const git = has.includes(".git");
  const files = has.filter((m) => m !== ".git");
  return [git ? "a git repository" : "", files.length ? `with ${files.join(", ")}` : ""].filter(Boolean).join(" ") || "a folder";
}

export interface RequestContext {
  cwd: string;
  /** The window's workspace, when it has one besides Home. */
  workspace?: Workspace | null;
  home?: string;
  now?: Date;
  explore: boolean;
  /** Shell commands can run (false on Windows for now: no sandbox). */
  canRun?: boolean;
  /** The widget's folder. */
  widgetDir?: string;
  /** The widget's files as they are now (a refinement), by path. */
  files?: Record<string, string>;
}

/** The user message: the request plus where (machine, folder, the window's workspace) and when it was made. */
export function buildRequest(prompt: string, c: RequestContext): string {
  const now = c.now ?? new Date();
  const home = c.home ?? os.homedir();
  const short = (p: string) => (p === home ? "~" : p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lines = [
    `Request: ${prompt}`,
    "",
    `Context: macOS ${os.release()} (Darwin), user ${os.userInfo().username}, home ${home}, current folder ${short(c.cwd)}, ${now.toLocaleString("en-GB", { timeZone: tz })} ${tz}.`,
  ];
  if (c.workspace) {
    lines.push(
      `Workspace: this window belongs to the workspace "${c.workspace.name}" at ${short(c.workspace.root)} (${describeFolder(c.workspace.root)}). ` +
        `The person is working there: "this project", "the repo", "my code", "the tests", a branch or a relative path mean this folder unless the request names another place, and the tools start there.`,
    );
  }
  if (!c.explore) lines.push("Looking around this Mac is off for this request: answer without the run, read and list tools.");
  else if (c.canRun === false) lines.push(`Shell commands can't run here (${process.platform === "win32" ? "Windows" : "no sandbox"}): there is no run tool. Use read and list.`);
  if (c.widgetDir) lines.push(`Widget folder: ${short(c.widgetDir)}.`);
  const files = Object.entries(c.files ?? {});
  if (files.length) {
    lines.push("", "The widget's files now (change what the request asks for, keep the rest working):");
    for (const [f, text] of files) lines.push("", `--- ${f} ---`, text.trim());
  } else if (c.widgetDir) lines.push("The widget has no files yet.");
  return lines.join("\n");
}
