// The Magic system prompt: prompt/prompt.md, then the examples in
// prompt/examples/. Read from disk on every call, so editing them applies on the
// next `cmd magic` run. The system prompt stays byte-stable between requests
// (it is cached); everything per request goes into the user message.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompt");

/** The system prompt; `file` replaces prompt.md (prompt variants for evals). */
export function buildSystem(file?: string): string {
  const main = fs.readFileSync(file ?? path.join(PROMPT_DIR, "prompt.md"), "utf8").trim();
  const dir = path.join(PROMPT_DIR, "examples");
  const examples = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const text = fs.readFileSync(path.join(dir, f), "utf8").trim();
      const lines = text.split("\n");
      const meta = lines.filter((l, i) => i < 3 && /^(Request|Notes):/.test(l));
      const answer = lines.slice(meta.length).join("\n").trim();
      return `<example>\n${meta.join("\n")}\nAnswer:\n${answer}\n</example>`;
    });
  return `${main}\n\n# Examples\n\n${examples.join("\n\n")}\n`;
}

export interface RequestContext {
  cwd: string;
  home?: string;
  now?: Date;
  explore: boolean;
  /** Shell commands can run (false on Windows for now: no sandbox). */
  canRun?: boolean;
}

/** The user message: the request plus where and when it was made. */
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
  if (!c.explore) lines.push("Looking around this Mac is off for this request: answer without the run, read and list tools.");
  else if (c.canRun === false) lines.push(`Shell commands can't run here (${process.platform === "win32" ? "Windows" : "no sandbox"}): there is no run tool, and command sources fail. Use read and list, and fetch sources.`);
  return lines.join("\n");
}
