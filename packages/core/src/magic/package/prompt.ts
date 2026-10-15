// The Magic system prompt for widget packages (docs/56, "Magic on V3"): prompt/prompt.md
// (its lists generated from the API's rows by scripts/widget-api-blocks.ts, markers stripped),
// then the API reference as @cmd/widget-api's README has it (generated from the d.ts by
// `pnpm widget-api:docs`, read here at build time so the agent reads the same contract a
// developer does, never a copy), then the list of cmd's built-in packages (builtins.ts: id,
// title, description from each package.json), which the agent opens with its `builtin` tool.
// Read from disk on every call; the system prompt is byte-stable between requests (cached)
// and its hash goes into every eval report. Per request: the user message.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtinListing } from "./builtins.ts";
import { REPO } from "./toolchain.ts";

/** Magic's prompt folder: prompt.md. */
export const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../prompt");

/** The workspace a window belongs to (not Home): what "this project" or a relative path means. */
export interface Workspace {
  name: string;
  root: string;
}

export const API_README = path.join(REPO, "packages/widget-api/README.md");
/** Where the API's data types are declared (protocol's widget-tree.ts; @cmd/widget-api re-exports them). */
export const API_TYPES = path.join(REPO, "packages/protocol/src/widget-tree.ts");
/** The data types a widget handles, as declared: what the reference names but doesn't spell out. */
const DATA_TYPES = new Set(["WidgetEnv", "ApiScopeQuery", "ApiWorkspace", "ApiWindow", "ApiAgentState", "ApiTone", "ApiLight", "ApiAgent", "ApiTerminal", "ApiTerminalScreen", "ApiEventQuery", "ApiEvent", "ApiEventStats", "ApiGitStatus", "ApiGitWorktree", "ApiAction", "ApiFetchInit", "ApiFetchResponse", "ApiCompletionRequest", "ApiCompletion", "ApiNotification", "ApiAgentStart", "ApiStarted", "ApiTerminalOpen", "ApiActionStarted", "ApiRunOptions", "ApiRunResult"]);

/** The README's generated reference (between its reference markers), or a note when this cmd lacks it. */
export function apiReference(file = API_README): string {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return "(The API reference isn't in this cmd: write against what the built-in packages use.)";
  }
  const m = /<!-- reference:start[^>]*-->([\s\S]*?)<!-- reference:end -->/.exec(text);
  return (m?.[1] ?? text).trim();
}

/** The declarations of the API's data types, with their comments (`Agent` in @cmd/widget-api is ApiAgent here). */
export function apiTypes(file = API_TYPES): string {
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return "";
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^export (interface|type) (\w+)/.exec(lines[i]!);
    if (!m || !DATA_TYPES.has(m[2]!)) continue;
    let start = i;
    while (start > 0 && /^(\/\*\*|\s\*|\/\/)/.test(lines[start - 1]!)) start--;
    let end = i;
    if (m[1] === "interface") while (end < lines.length && lines[end] !== "}") end++;
    else while (end < lines.length && !lines[end]!.trimEnd().endsWith(";")) end++;
    out.push(lines.slice(start, end + 1).join("\n"));
    i = end;
  }
  return out.join("\n\n");
}

/** Text without the markers of its generated blocks (scripts/widget-api-blocks.ts): a marker on a line of its own goes with its line. */
export const withoutMarkers = (text: string): string => text.replace(/^[ \t]*<!-- \/?gen:[\w-]+ -->\n/gm, "").replace(/<!-- \/?gen:[\w-]+ -->/g, "");

/** The system prompt; `file` replaces prompt.md (prompt variants for evals), `builtins` the built-in packages' folder (default: the core's). */
export function buildPackageSystem(file?: string, builtins?: string | null): string {
  const main = withoutMarkers(fs.readFileSync(file ?? path.join(PROMPT_DIR, "prompt.md"), "utf8")).trim();
  const types = apiTypes();
  const data = types ? `\n\n## The data\n\nWhat the reads return, as declared. @cmd/widget-api exports them without the \`Api\` prefix (\`Agent\`, \`Terminal\`, \`WindowInfo\` for ApiWindow, \`Workspace\`, \`Event\`, \`GitStatus\`, \`FetchResponse\`, \`Env\` for WidgetEnv); \`Light\` and \`Tone\` are exported as they are.\n\n\`\`\`ts\n${types}\n\`\`\`` : "";
  return `${main}\n\n# The API: @cmd/widget-api\n\nThe whole contract a widget is written against, generated from its types (everything here is in API 1 for good).\n\n${apiReference()}${data}\n\n# Built-in widgets\n\ncmd's own widgets, packages written against the same API (open one with \`builtin\`):\n\n${builtinListing(builtins)}\n`;
}

/** A short hash of a system prompt, for eval reports and the log. */
export const promptHash = (system: string): string => crypto.createHash("sha256").update(system).digest("hex").slice(0, 12);

export interface PackageRequestContext {
  cwd: string;
  /** The window's workspace, when it has one besides Home. */
  workspace?: Workspace | null;
  home?: string;
  now?: Date;
  explore: boolean;
  /** Shell commands can run (false on Windows for now: no sandbox). */
  canRun?: boolean;
  /** The package's files as they are now (a change), by path. */
  files?: Record<string, string>;
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
