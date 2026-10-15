// The package folder a Magic build writes (docs/56, "Magic on V3"): the files the agent
// may write (package.json, README.md, view.html for a frame widget, src/**, fixtures/**),
// never anything else (grants.json lives in the instance's widget-packages folder, out of
// reach), and never through a link out of the folder. cmd's own `cmd.magic` block in
// package.json (MagicMark: the request, when it was made, its revisions) is kept as cmd
// wrote it, whatever the agent writes there.

import fs from "node:fs";
import path from "node:path";
import type { MagicMark } from "@cmd/protocol";
import { markOf } from "../../widgets/package.ts";
import { listFiles } from "../../widgets/revisions.ts";
import { MAX_FILE } from "../../widgets/limits.ts";

export { listFiles };

const SEGMENT = /^[\w][\w.-]*$/;

/** What the agent may write, in words (for tool descriptions and refusals). */
export const WRITABLE = "package.json, README.md, view.html (a frame widget's), src/<file> and fixtures/<name>.json";

/** A path the agent may write, relative to the package, or why not. */
export function writable(rel: string): { ok: true; rel: string } | { ok: false; error: string } {
  const clean = rel.trim().replace(/^\.\//, "");
  const no = (why: string) => ({ ok: false as const, error: `${rel}: ${why}; a widget package's files are ${WRITABLE}` });
  if (!clean || path.isAbsolute(clean) || clean.includes("\\")) return no("not a path inside the package");
  const parts = clean.split("/");
  if (parts.some((p) => !SEGMENT.test(p) || p === "node_modules")) return no("not a file of the package");
  if (parts.length === 1 && ["package.json", "README.md", "view.html"].includes(clean)) return { ok: true, rel: clean };
  if (parts[0] === "src" && parts.length >= 2 && /\.(tsx?|json|md)$/.test(clean)) return { ok: true, rel: clean };
  if (parts[0] === "fixtures" && parts.length === 2 && clean.endsWith(".json")) return { ok: true, rel: clean };
  return no("not one the agent writes");
}

/** `rel` in the package folder, after checking nothing on the way is a link out of it. */
function resolveInside(dir: string, rel: string): string {
  const root = fs.realpathSync(dir);
  let at = root;
  for (const p of rel.split("/").slice(0, -1)) {
    at = path.join(at, p);
    if (fs.existsSync(at) && !fs.realpathSync(at).startsWith(root + path.sep)) throw new Error(`${rel}: leads out of the package`);
  }
  const abs = path.join(root, rel);
  if (fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) throw new Error(`${rel}: is a link; write a file of the package`);
  return abs;
}

export function readFile(dir: string, rel: string): string | null {
  const w = writable(rel);
  if (!w.ok) throw new Error(w.error);
  if (!fs.existsSync(dir)) return null;
  const abs = resolveInside(dir, w.rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

export function writeFile(dir: string, rel: string, content: string): string {
  const w = writable(rel);
  if (!w.ok) throw new Error(w.error);
  if (Buffer.byteLength(content) > MAX_FILE) throw new Error(`${rel}: over ${MAX_FILE / 1024} KB; keep files small`);
  fs.mkdirSync(dir, { recursive: true });
  const abs = resolveInside(dir, w.rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, w.rel === "package.json" ? keepMark(dir, content) : content);
  return w.rel;
}

/** Every file of the package by path (for a change: what the agent starts from). */
export function snapshotFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of listFiles(dir)) {
    const abs = path.join(dir, f);
    if (fs.statSync(abs).size <= MAX_FILE) out[f] = fs.readFileSync(abs, "utf8");
  }
  return out;
}

// ── cmd.magic ────────────────────────────────────────────

export function readMark(dir: string): MagicMark | null {
  try {
    return markOf(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")));
  } catch {
    return null;
  }
}

/** package.json as the agent wrote it, with cmd's mark as it was (or none). Text that isn't JSON stays as written: check says why. */
function keepMark(dir: string, content: string): string {
  let next: { cmd?: Record<string, unknown> };
  try {
    next = JSON.parse(content);
  } catch {
    return content;
  }
  if (!next || typeof next !== "object" || Array.isArray(next)) return content;
  const mark = readMark(dir);
  const had = !!next.cmd && typeof next.cmd === "object" && "magic" in next.cmd;
  if (!mark && !had) return content;
  if (next.cmd && typeof next.cmd === "object") {
    delete next.cmd.magic;
    if (mark) next.cmd.magic = mark;
  }
  return JSON.stringify(next, null, 2) + "\n";
}

/** Write cmd's mark into package.json (after a build), keeping the rest as it is. */
export function writeMark(dir: string, mark: MagicMark): void {
  const file = path.join(dir, "package.json");
  const json = JSON.parse(fs.readFileSync(file, "utf8")) as { cmd?: Record<string, unknown> };
  if (!json.cmd || typeof json.cmd !== "object") return;
  json.cmd.magic = mark;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}
