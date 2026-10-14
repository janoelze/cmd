// cmd-env.d.ts (docs/56, "Writing the UI": typed config): the types of a widget package's
// config, written from package.json by `cmd widget check` and `dev` into the package (for
// the person's editor) and by the toolchain into its copy (so check's TypeScript sees the
// fields as they are now). It augments @cmd/widget-api's `WidgetConfig`, so `useConfig()`
// is `{ repo: string }` and a renamed field fails check with its file and line, as
// Raycast's raycast-env.d.ts does for preferences. Secret fields are left out: a widget
// never gets them.

import fs from "node:fs";
import path from "node:path";
import type { WidgetConfigField } from "@cmd/protocol";
import type { WidgetPackage } from "./package.ts";

export const ENV_TYPES_FILE = "cmd-env.d.ts";

const typeOf = (f: WidgetConfigField): string =>
  f.type === "enum" && f.options?.length ? f.options.map((o) => JSON.stringify(o)).join(" | ") : f.type === "enum" ? "string" : f.type;

const ident = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
const comment = (s: string) => s.replace(/\*\//g, "* /").replace(/\s+/g, " ").trim();

/**
 * The file's text. One widget: its fields, those without a default optional. Several: a field
 * every widget has (with the same type and a default) is required, the rest optional.
 */
export function envTypes(pkg: Pick<WidgetPackage, "name" | "widgets">): string {
  const per = pkg.widgets.map((w) => (w.config ?? []).filter((f) => !f.secret));
  const keys = [...new Set(per.flat().map((f) => f.key))];
  const lines: string[] = [];
  for (const key of keys) {
    const fields = per.map((list) => list.find((f) => f.key === key));
    const present = fields.filter((f): f is WidgetConfigField => !!f);
    const types = [...new Set(present.map(typeOf))];
    const required = fields.every((f) => f && f.default !== undefined) && types.length === 1;
    const f = present[0]!;
    const doc = [f.title, f.description].filter(Boolean).map((s) => comment(String(s))).join(": ");
    if (doc) lines.push(`    /** ${doc}${f.default !== undefined ? ` (default ${JSON.stringify(f.default)})` : ""} */`);
    lines.push(`    ${ident(key)}${required ? "" : "?"}: ${types.join(" | ")};`);
  }
  return [
    `// The types of ${pkg.name}'s config, from package.json's "config" fields.`,
    "// Written by cmd widget check and cmd widget dev: edit package.json, not this file.",
    "",
    'import "@cmd/widget-api";',
    "",
    'declare module "@cmd/widget-api" {',
    "  interface WidgetConfig {",
    ...lines,
    "  }",
    "}",
    "",
  ].join("\n");
}

/** Writes cmd-env.d.ts into `dir` when its text changed; returns whether it wrote. */
export function writeEnvTypes(dir: string, pkg: Pick<WidgetPackage, "name" | "widgets">): boolean {
  const file = path.join(dir, ENV_TYPES_FILE);
  const text = envTypes(pkg);
  try {
    if (fs.readFileSync(file, "utf8") === text) return false;
  } catch {}
  fs.writeFileSync(file, text);
  return true;
}
