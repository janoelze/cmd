// What a widget package ships, by its package.json's `files` (as npm packs it): what
// scripts/stage-widgets.mjs stages of each built-in (a problem fails the staging), and what
// `cmd widget check` warns about for any package that lists `files`. Each listed entry is a file
// or a folder (copied whole, but node_modules and dot-entries at any depth); package.json,
// README.md and LICENSE always ship. Problems: an entry that isn't plain or isn't there, a
// widget's `main` or a frame widget's view.html left out, and a relative import of a shipped
// script that names a file that doesn't ship. Node built-ins only: a plain .mjs script imports it.

import fs from "node:fs";
import path from "node:path";

const ALWAYS = ["package.json", "README.md", "LICENSE"];
const SCRIPT = /\.(ts|tsx|js|jsx|mjs)$/;
/** What a relative specifier may leave off, in the order a resolver tries it. */
const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"];

/** A relative path inside the package with no glob, `..`, dot-segment or node_modules; else null. */
function plain(entry: unknown): string | null {
  if (typeof entry !== "string" || !entry.trim() || path.isAbsolute(entry) || /[*?[\]{}!]/.test(entry)) return null;
  const segs = entry.split("/").filter((s) => s && s !== ".");
  if (!segs.length || segs.some((s) => s === ".." || s.startsWith(".") || s === "node_modules")) return null;
  return segs.join("/");
}

/** The relative specifiers a script imports at run time (`import type` is erased, so it isn't one). */
export function relativeImports(text: string): string[] {
  const out = new Set<string>();
  const pats = [
    /\b(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?["'](\.{1,2}\/[^"'\n]+)["']/g,
    /\bimport\s*\(\s*["'](\.{1,2}\/[^"'\n]+)["']\s*\)/g,
  ];
  for (const re of pats) for (const m of text.matchAll(re)) out.add(m[1]!);
  return [...out];
}

export interface Shipped {
  /** Paths relative to the package, sorted. */
  files: string[];
  problems: string[];
}

/** What the package at `dir` ships, and what's amiss with it; null when its package.json lists no `files`. */
export function shippedFiles(dir: string): Shipped | null {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { files?: unknown; cmd?: { widgets?: { id?: string; main?: unknown; surface?: string }[] } };
  if (!Array.isArray(pkg.files) || !pkg.files.length) return null;
  const problems: string[] = [];
  const out = new Set<string>();
  const walk = (rel: string) => {
    const abs = path.join(dir, rel);
    if (fs.statSync(abs).isFile()) return void out.add(rel);
    for (const e of fs.readdirSync(abs)) if (!e.startsWith(".") && e !== "node_modules") walk(`${rel}/${e}`);
  };
  for (const entry of pkg.files) {
    const rel = plain(entry);
    if (!rel) problems.push(`"files" lists ${JSON.stringify(entry)}: name a file or folder of the package (no glob, "..", dot-file or node_modules)`);
    else if (!fs.existsSync(path.join(dir, rel))) problems.push(`"files" lists ${rel}, which isn't there`);
    else walk(rel);
  }
  for (const f of ALWAYS) if (fs.existsSync(path.join(dir, f))) out.add(f);
  for (const w of pkg.cmd?.widgets ?? []) {
    const main = plain(w.main);
    if (main && !out.has(main)) problems.push(`widget ${w.id}'s main ${main} isn't in "files"`);
    if (w.surface === "frame" && !out.has("view.html")) problems.push(`widget ${w.id} draws in a frame, but view.html isn't in "files"`);
  }
  for (const rel of [...out].filter((f) => SCRIPT.test(f)).sort()) {
    for (const spec of relativeImports(fs.readFileSync(path.join(dir, rel), "utf8"))) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      const found = EXTS.map((e) => base + e).find((p) => !p.startsWith("..") && fs.existsSync(path.join(dir, p)) && fs.statSync(path.join(dir, p)).isFile());
      if (!found) problems.push(`${rel} imports ${spec}, which isn't there`);
      else if (!out.has(found)) problems.push(`${rel} imports ${spec} (${found}), which isn't in "files"`);
    }
  }
  return { files: [...out].sort(), problems };
}
