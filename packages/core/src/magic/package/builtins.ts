// cmd's built-in widget packages as Magic's references (docs/56, "Magic on V3"): the system
// prompt lists them (id, title, description, read from each package.json at prompt-build
// time), and the agent's `builtin` tool opens one: its files, package.json and README, or one
// file's text. The folder is the core's own built-in root (widgets/packages.ts: packages/widgets
// in a checkout and in the staged runtime alike), so a built-in that improves teaches Magic with
// no second copy. Only what a package ships is readable (its `files`, widgets/shipped.ts),
// never tests, node_modules or dot-folders; an id or a path that leaves the folder is refused.

import fs from "node:fs";
import path from "node:path";
import { builtinWidgets } from "../../widgets/packages.ts";
import { shippedFiles } from "../../widgets/shipped.ts";

/** One built-in package as the prompt lists it. */
export interface BuiltinRef {
  id: string;
  description: string;
  widgets: { id: string; title: string; description: string }[];
}

const ID = /^[a-z0-9][a-z0-9._-]*$/;
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const MAX = 64 * 1024;

interface Manifest {
  name?: unknown;
  description?: unknown;
  cmd?: { widgets?: { id?: unknown; title?: unknown; description?: unknown }[] };
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The built-in packages under `root` (folders with a package.json), by id. */
export function builtinRefs(root: string | null = builtinWidgets()): BuiltinRef[] {
  if (!root) return [];
  let names: string[];
  try {
    names = fs.readdirSync(root).filter((n) => ID.test(n)).sort();
  } catch {
    return [];
  }
  const out: BuiltinRef[] = [];
  for (const id of names) {
    let j: Manifest;
    try {
      j = JSON.parse(fs.readFileSync(path.join(root, id, "package.json"), "utf8")) as Manifest;
    } catch {
      continue;
    }
    const widgets = (j.cmd?.widgets ?? []).map((w) => ({ id: text(w.id), title: text(w.title), description: text(w.description) })).filter((w) => w.id);
    out.push({ id, description: text(j.description), widgets });
  }
  return out;
}

/** The listing in the system prompt: one line per built-in. */
export function builtinListing(root: string | null = builtinWidgets()): string {
  const refs = builtinRefs(root);
  if (!refs.length) return "(This cmd has no built-in packages to read.)";
  return refs
    .map((r) => {
      const ws = r.widgets.map((w) => `${w.title || w.id}${w.description && w.description !== r.description ? `: ${w.description}` : ""}`).join("; ");
      return `- \`${r.id}\`: ${r.description || "(no description)"}${ws ? ` (${ws})` : ""}`;
    })
    .join("\n");
}

/** What a built-in may show: what it ships, without tests. */
function readable(dir: string): string[] | null {
  const s = shippedFiles(dir);
  return s ? s.files.filter((f) => !TEST.test(f)) : null;
}

/** A file of the package, its real path inside the package's real folder; else null. */
function inside(dir: string, rel: string): string | null {
  try {
    const real = fs.realpathSync(path.join(dir, rel));
    const base = fs.realpathSync(dir);
    return real.startsWith(base + path.sep) && fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function slurp(file: string): string {
  const t = fs.readFileSync(file, "utf8");
  return t.length > MAX ? `${t.slice(0, MAX)}\n… (cut at 64 KB)` : t;
}

/**
 * The `builtin` tool: without `file`, the package's files, package.json and README; with one,
 * that file's text. Throws, saying why, on an unknown id or a file the package doesn't ship.
 */
export function readBuiltin(id: string, file: string | undefined, root: string | null = builtinWidgets()): string {
  const refs = builtinRefs(root);
  const known = refs.map((r) => r.id).join(", ") || "none";
  if (!root || !ID.test(id) || !refs.some((r) => r.id === id)) throw new Error(`no built-in package "${id}" (there are: ${known})`);
  const dir = path.join(root, id);
  const files = readable(dir);
  if (!files) throw new Error(`${id} doesn't say what it ships`);
  if (file === undefined || file === "") {
    const show = (f: string) => {
      const real = files.includes(f) ? inside(dir, f) : null;
      return real ? `--- ${f} ---\n${slurp(real).trim()}` : "";
    };
    return [`${id}'s files: ${files.join(", ")}`, show("package.json"), show("README.md")].filter(Boolean).join("\n\n");
  }
  const rel = path.posix.normalize(file.replace(/\\/g, "/")).replace(/^\.\//, "");
  if (path.isAbsolute(file) || rel.startsWith("..") || !files.includes(rel)) throw new Error(`${id} doesn't ship ${file} (it has: ${files.join(", ")})`);
  const real = inside(dir, rel);
  if (!real) throw new Error(`${file} isn't a file inside ${id}`);
  return slurp(real);
}
