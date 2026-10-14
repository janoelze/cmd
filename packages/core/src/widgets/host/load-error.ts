// What a widget whose code didn't load shows (docs/56, "Hot reload"): the error's first line and
// where, the package's own path cut off. The host (host.ts) keeps it from the process's `error`
// before hello, and shows it when the process then exits.

import fs from "node:fs";

/**
 * What a load failure shows: the error's first line, then where (the first "at" line of the
 * message or the stack, the package's own path cut to what's in it): "SyntaxError: Expression
 * expected · src/main.tsx:15:1". Deno's code frame under the message is left out.
 */
export function loadError(message: unknown, stack: unknown, dir?: string): string {
  const lines = [String(message ?? ""), typeof stack === "string" ? stack : ""].join("\n").split("\n").map((l) => l.trim());
  const first = lines[0] ?? "";
  let at = lines.find((l) => l.startsWith("at "))?.replace(/^at (async )?/, "").replace(/^file:\/\//, "");
  if (at && dir) {
    const real = dir.endsWith("/") ? dir : dir + "/";
    if (at.startsWith(real)) at = at.slice(real.length);
  }
  return [first, at && !first.includes(at) ? at : null].filter(Boolean).join(" · ").slice(0, 1000);
}

export const realDir = (dir: string): string => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
};
