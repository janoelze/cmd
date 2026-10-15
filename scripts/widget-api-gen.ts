// `pnpm widget-api:gen`: packages/widget-api/src/elements.gen.ts, generated from the protocol's
// element spec (packages/protocol/src/widget-elements.ts, API_ELEMENTS and API_ENUMS), so an
// element's props, events and docs are written once. The file keeps each prop's JSDoc for
// authors' editors, and the README reference (`pnpm widget-api:docs`, which runs this first)
// is read from it. And elements-since.gen.ts: the minor each element came in, which
// `cmd.env.has` answers by on a cmd before 1.2 (it doesn't list its elements).
// packages/widget-api/test/docs.test.ts fails when either is stale.
//
//   node scripts/widget-api-gen.ts           write it
//   node scripts/widget-api-gen.ts --check   exit 1 when it is stale

import fs from "node:fs";
import path from "node:path";
import { API_ELEMENTS, API_ENUMS, TOOLBAR_ITEM, isShape, type ApiElementSpec, type ApiEventSpec, type ApiFieldSpec, type ApiPropSpec, type ApiPropType, type ApiShape } from "../packages/protocol/src/widget-elements.ts";

const root = path.resolve(import.meta.dirname, "..");
export const ELEMENTS_FILE = path.join(root, "packages/widget-api/src/elements.gen.ts");
export const SINCE_FILE = path.join(root, "packages/widget-api/src/elements-since.gen.ts");

const lit = (v: string | number) => (typeof v === "string" ? JSON.stringify(v) : String(v));
const named = Object.entries(API_ENUMS) as [string, { values: readonly (string | number)[]; doc: string; exported: boolean; since: string }][];

/** An enum as TypeScript: runs that are a named enum show its name, longest first (`Light | "dim"`). */
function enumType(values: readonly (string | number)[], skip?: string): string {
  const parts: string[] = [];
  const names = named.filter(([n]) => n !== skip).sort((a, b) => b[1].values.length - a[1].values.length);
  for (let i = 0; i < values.length; ) {
    const hit = names.find(([, e]) => e.values.length <= values.length - i && e.values.every((x, j) => values[i + j] === x));
    if (hit) {
      parts.push(hit[0]);
      i += hit[1].values.length;
    } else parts.push(lit(values[i++]!));
  }
  return parts.join(" | ");
}

/** The records named in props (1.2), by name, with the minor they came in: declared once each. */
const shapes = new Map<string, { shape: ApiShape; since: string }>();

/** A prop type as TypeScript, `T` the option type of a generic element. */
function tsType(t: ApiPropType): string {
  if (Array.isArray(t)) return enumType(t);
  if (isShape(t)) return "list" in t ? `${t.name}[]` : t.name;
  switch (t) {
    case "text":
      return "string | number";
    case "numbers":
      return "(number | null)[]";
    case "menu":
      return "MenuEntry[]";
    case "action":
      return "Action";
    case "viewState":
      return "ViewState";
    case "options":
      return "{ value: T; label: string; icon?: string }[]";
    case "option":
      return "T";
    case "strings":
      return "string[]";
    case "matrix":
      return "number[][]";
    case "cells":
      return "(string | number | null)[]";
    case "value":
      return "WireValue";
    default:
      return t as string;
  }
}

/** A JSDoc comment at `indent`: one line when it fits. */
function jsdoc(text: string, indent = ""): string {
  const one = `${indent}/** ${text} */`;
  return one.length <= 120 ? one : `${indent}/**\n${indent} * ${text.replace(/ @since/, `\n${indent} * @since`)}\n${indent} */`;
}

const isItem = (name: string, p: ApiPropSpec) => (TOOLBAR_ITEM as Record<string, ApiPropSpec>)[name] === p;

/** The shapes a spec's props and events name, noted for declaring. */
function noteShapes(spec: ApiElementSpec, since: string): void {
  for (const t of [...Object.values(spec.props).map((p) => p.type), ...Object.values(spec.events).map((e) => e.value)]) if (t && isShape(t) && !shapes.has(t.name)) shapes.set(t.name, { shape: t, since });
}

/** A shape as an interface. */
function shape(name: string, s: ApiShape, since: string): string[] {
  const fields = Object.entries("list" in s ? s.list : s.record) as [string, ApiFieldSpec][];
  const out = [jsdoc(`${s.doc} @since ${since}`), `export interface ${name} {`];
  for (const [k, f] of fields) out.push(jsdoc(f.doc, "  "), `  ${k}${f.required ? "" : "?"}: ${tsType(f.type)}${f.nullable ? " | null" : ""};`);
  out.push("}", "");
  return out;
}

/** An event's value as a parameter: its spec's, a string for change and submit, none else. */
function eventParam(e: ApiEventSpec, generic: boolean): string {
  if (e.value) return `value: ${tsType(e.value)}${e.nullable ? " | null" : ""}`;
  return e.gesture === "change" || e.gesture === "submit" ? `value: ${generic ? "T" : "string"}` : "";
}

function element(name: string, spec: ApiElementSpec): string[] {
  const since = spec.since ?? "1.0";
  const props = Object.entries(spec.props);
  const generic = props.some(([, p]) => p.type === "options");
  const item = props.some(([k, p]) => isItem(k, p));
  const own = props.filter(([k, p]) => !isItem(k, p));
  const out: string[] = [];
  const empty = !props.length && !Object.keys(spec.events).length && spec.children === "none";
  out.push(jsdoc(empty ? `${name} takes no props. @since ${since}` : `${name}'s props. @since ${since}`));
  const head = `export interface ${name}Props${generic ? "<T extends string = string>" : ""}${item ? " extends ToolbarItem" : ""}`;
  if (empty) out.push(`${head} {}`);
  else {
    out.push(`${head} {`);
    for (const [k, p] of own) {
      out.push(jsdoc(p.since ? `${p.doc} @since ${p.since}` : p.doc, "  "));
      out.push(`  ${k}${p.required ? "" : "?"}: ${tsType(p.type)}${p.nullable ? " | null" : ""};`);
    }
    for (const [k, e] of Object.entries(spec.events) as [string, ApiEventSpec][]) {
      out.push(jsdoc(e.doc, "  "));
      out.push(`  ${k}?: (${eventParam(e, generic)}) => void;`);
    }
    if (spec.children !== "none") {
      out.push(jsdoc(spec.childrenDoc ?? "Its children.", "  "));
      out.push("  children?: ReactNode;");
    }
    out.push("}");
  }
  out.push(jsdoc(`${spec.doc ?? name} @since ${since}`));
  out.push(`export const ${name} = el<${name}Props>("${name}");`, "");
  return out;
}

/** elements.gen.ts, as text. */
export function generate(): string {
  const out = [
    "// GENERATED by `pnpm widget-api:gen` (scripts/widget-api-gen.ts) from the protocol's element",
    "// spec, packages/protocol/src/widget-elements.ts: edit that, not this.",
    "//",
    '// The elements of API 1 (docs/56, "The view"): what a widget\'s view is made of. Each is',
    '// the API\'s own tag, not a kit component: the reconciler sends `{ type: "ListRow", props }`',
    "// and the app draws it with whatever kit component the element table maps it to today.",
    "// Props are data (strings, numbers, tones, steps of the spacing scale); handlers are",
    "// functions the reconciler turns into ids. There is no className, style or ref: a look",
    "// is a prop, or a kit change.",
    "",
    "// API 1.2 added the window-content kit's elements (docs/57); each says its @since.",
    "",
    'import type { ReactElement, ReactNode } from "react";',
    'import type { ActionOf, ApiElement, MenuEntryOf, ViewStateOf, WireValue } from "@cmd/protocol/widget-tree";',
    "",
    "/** An element of the API: JSX makes a host element of its tag. */",
    "type El<P> = (props: P & { key?: string | number }) => ReactElement;",
    "const el = <P>(name: ApiElement) => name as unknown as El<P>;",
    "",
  ];
  for (const [name, e] of named) {
    out.push(jsdoc(`${e.doc}${e.exported ? ` @since ${e.since}` : ""}`));
    out.push(`${e.exported ? "export " : ""}type ${name} = ${enumType(e.values, name)};`);
  }
  out.push(
    "",
    "/** A context or title menu's entry: data, with `run` called when chosen. @since 1.0 */",
    "export type MenuEntry = MenuEntryOf<() => void>;",
    "/** A button as data: an empty state's or a view state's one way on. @since 1.0 */",
    "export type Action = ActionOf<() => void>;",
    "/** What replaces a View's body: empty (the default), loading, no results, error; one line and one action. @since 1.0 */",
    "export type ViewState = ViewStateOf<() => void>;",
    "",
    "/** What every toolbar item takes. @since 1.0 */",
    "interface ToolbarItem {",
  );
  for (const [k, p] of Object.entries(TOOLBAR_ITEM) as [string, ApiPropSpec][]) out.push(jsdoc(p.doc, "  "), `  ${k}?: ${tsType(p.type)};`);
  out.push("}", "");
  const elements = Object.entries(API_ELEMENTS) as [string, ApiElementSpec][];
  shapes.clear();
  for (const [, spec] of elements) noteShapes(spec, spec.since ?? "1.0");
  if (shapes.size) out.push("// ── the records props hold (1.2) ──", "");
  for (const [name, { shape: s, since }] of shapes) out.push(...shape(name, s, since));
  for (const [name, spec] of elements) out.push(...element(name, spec));
  out.push("/** Each element's props type, by name (tests hold them to the protocol's allow-list). */", "export interface ElementProps {");
  for (const [name] of elements) out.push(`  ${name}: ${name}Props;`);
  out.push("}", "");
  return out.join("\n");
}

/** elements-since.gen.ts, as text: each element's minor, for `cmd.env.has` on a cmd that doesn't list its elements. */
export function generateSince(): string {
  const rows = (Object.entries(API_ELEMENTS) as [string, ApiElementSpec][]).map(([name, spec]) => `  ${name}: "${spec.since ?? "1.0"}",`);
  return [
    "// GENERATED by `pnpm widget-api:gen` (scripts/widget-api-gen.ts) from the protocol's element",
    "// spec: edit packages/protocol/src/widget-elements.ts, not this.",
    "",
    "/** The minor each element came in: a cmd before 1.2 doesn't list the elements it draws, so `cmd.env.has` reads its minor against these. */",
    "export const ELEMENT_SINCE: Record<string, string> = {",
    ...rows,
    "};",
    "",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let stale = false;
  for (const [file, text] of [[ELEMENTS_FILE, generate()], [SINCE_FILE, generateSince()]] as const) {
    const now = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const rel = path.relative(root, file);
    if (process.argv.includes("--check")) {
      if (now !== text) (console.error(`${rel} is stale: pnpm widget-api:gen`), (stale = true));
    } else if (now === text) console.log(`${rel} is up to date`);
    else (fs.writeFileSync(file, text), console.log(`wrote ${rel}`));
  }
  if (stale) process.exit(1);
}
