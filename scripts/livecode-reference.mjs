#!/usr/bin/env node
// Writes packages/core/src/livecode/reference.md: Strudel's function reference
// (@strudel/reference, generated from its JSDoc) as compact Markdown, which
// Live Code's AI gets with every request (packages/core/src/livecode/change.ts).
// Only what plays in a Live Code frame (@strudel/web): no MIDI, OSC, Csound,
// drawing, device motion or the supradough engine. One example per function.
//
//   node scripts/livecode-reference.mjs    (after bumping @strudel/web)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "packages/core/package.json"));
const { reference } = await import(require.resolve("@strudel/reference"));
const version = JSON.parse(fs.readFileSync(require.resolve("@strudel/reference/package.json"), "utf8")).version;

const PACKAGES = new Set(["core", "superdough", "tonal", "webaudio", "mini", "transpiler"]);

const text = (html = "") =>
  html
    .replace(/<\/p>\s*<p>/g, " ")
    .replace(/<br\s*\/?>/g, " ")
    .replace(/<code>(.*?)<\/code>/g, "`$1`")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const seen = new Set();
const entries = reference.docs
  .filter((d) => d.name && !d.undocumented && d.kind !== "package" && PACKAGES.has(path.basename(d.meta?.path ?? "")))
  .filter((d) => !d.name.startsWith("_") && !seen.has(d.name) && seen.add(d.name))
  // MIDI and OSC controls documented in core: nothing in the frame sends them.
  .filter((d) => !/^MIDI\b|only supported by osc|superdirt only/i.test(text(d.description)))
  .sort((a, b) => a.name.localeCompare(b.name));

const lines = [
  `# Strudel reference`,
  ``,
  `Every function a pattern can use (@strudel/reference ${version}). \`name(params)\`, aliases in brackets, what it does, an example.`,
  ``,
];
for (const d of entries) {
  const params = (d.params ?? []).map((p) => p.name).filter(Boolean).join(", ");
  const aliases = d.synonyms?.length ? ` [${d.synonyms.join(", ")}]` : "";
  const params2 = (d.params ?? []).filter((p) => p.name && p.description).map((p) => `${p.name}: ${text(p.description)}`);
  lines.push(`## ${d.name}(${params})${aliases}`);
  const desc = text(d.description);
  if (desc) lines.push(desc);
  if (params2.length) lines.push(params2.map((p) => `- ${p}`).join("\n"));
  const ex = d.examples?.[0];
  if (ex) lines.push("```\n" + ex.trim() + "\n```");
  lines.push("");
}

const out = path.join(root, "packages/core/src/livecode/reference.md");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join("\n"));
console.log(`${entries.length} functions, ${Math.round(fs.statSync(out).size / 1024)} KB → ${path.relative(root, out)}`);
