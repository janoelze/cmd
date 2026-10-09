// Builds cmd's design tokens (DTCG 2025.10 files in this folder, tied together by
// cmd.resolver.json) into what the kit uses:
//   ../src/tokens.css      the base set on :root (and .ui-theme), reduced motion as a media query
//   ../src/tokens.gen.ts   the scales as types (the kit's props take only these names),
//                          LIGHT_VARS for light themes, and TOKENS: every token with its
//                          description, for the gallery, docs and agents
// Run `pnpm tokens` after editing a token; `pnpm tokens --check` (and a test) fails
// when the generated files are stale.
//
// Beyond the format: tokens with `org.cmd.theme` are set by the active theme at runtime
// (themes/registry.ts) and only documented here; `org.cmd.mix` derives a colour from
// another (CSS color-mix, so it follows any theme, a person's own included); `org.cmd.css`
// is a value the format can't express (a shadow built with calc, a linear() curve).

import fs from "node:fs";
import path from "node:path";

const DIR = import.meta.dirname;
const OUT_CSS = path.join(DIR, "../src/tokens.css");
const OUT_TS = path.join(DIR, "../src/tokens.gen.ts");

type Json = Record<string, unknown>;
interface Token {
  name: string;
  path: string[];
  type?: string;
  value: unknown;
  description?: string;
  extensions?: Json;
  file: string;
}

const read = (file: string): Json => JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")) as Json;
const isToken = (n: unknown): n is Json => typeof n === "object" && n !== null && "$value" in n;

/** A file's tokens in order, with group $type inherited and $root named after its group. */
function flatten(file: string): Token[] {
  const out: Token[] = [];
  const walk = (node: Json, at: string[], type: string | undefined) => {
    const t = (node.$type as string | undefined) ?? type;
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("$") && k !== "$root") continue;
      if (typeof v !== "object" || v === null) continue;
      const p = k === "$root" ? at : [...at, k];
      if (isToken(v)) out.push({ name: `--${p.join("-")}`, path: k === "$root" ? [...at, "$root"] : p, type: (v.$type as string | undefined) ?? t, value: v.$value, description: v.$description as string | undefined, extensions: v.$extensions as Json | undefined, file });
      else walk(v as Json, p, t);
    }
  };
  walk(read(file), [], undefined);
  return out;
}

const ref = (s: string) => `var(--${s.slice(1, -1).split(".").filter((k) => k !== "$root").join("-")})`;
const isRef = (v: unknown): v is string => typeof v === "string" && /^\{[^}]+\}$/.test(v);
const num = (n: number) => String(Math.round(n * 10000) / 10000);
const FAMILY_KEYWORDS = new Set(["-apple-system", "BlinkMacSystemFont", "system-ui", "sans-serif", "serif", "monospace", "ui-monospace"]);

/** A token's CSS value. */
export function css(t: Token): string {
  const v = t.value;
  const mix = t.extensions?.["org.cmd.mix"] as { space: string; amount: number; with: string } | undefined;
  if (t.extensions?.["org.cmd.css"]) return String(v);
  if (mix) return `color-mix(in ${mix.space}, ${ref(String(v))} ${num(mix.amount * 100)}%, ${isRef(mix.with) ? ref(mix.with) : mix.with})`;
  if (isRef(v)) return ref(v);
  switch (t.type) {
    case "dimension":
    case "duration": {
      const d = v as { value: number; unit: string };
      return `${num(d.value)}${d.unit}`;
    }
    case "number":
      return num(v as number);
    case "cubicBezier":
      return `cubic-bezier(${(v as number[]).map(num).join(", ")})`;
    case "fontFamily":
      return (Array.isArray(v) ? v : [v]).map((f: string) => (FAMILY_KEYWORDS.has(f) ? f : `"${f}"`)).join(", ");
    case "color": {
      const c = v as { components: number[]; alpha?: number; hex?: string };
      if (c.alpha === undefined && c.hex) return c.hex;
      const [r, g, b] = c.components.map((x) => Math.round(x * 255));
      return c.alpha === undefined ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${num(c.alpha)})`;
    }
  }
  throw new Error(`${t.name} (${t.file}): can't write a ${t.type} as CSS`);
}

interface Resolver {
  description: string;
  sets: Record<string, { sources: { $ref: string }[] }>;
  modifiers: Record<string, { contexts: Record<string, { $ref: string }[]> }>;
}

/** Everything the build writes, as text. */
export function build(): { css: string; ts: string; tokens: Token[] } {
  const r = read("cmd.resolver.json") as unknown as Resolver;
  const base = r.sets.base!.sources.flatMap((s) => flatten(s.$ref));
  const seen = new Map<string, Token>();
  for (const t of base) {
    if (seen.has(t.name)) throw new Error(`${t.name} is in ${seen.get(t.name)!.file} and ${t.file}`);
    seen.set(t.name, t);
  }
  const overrides = (mod: string, ctx: string) =>
    r.modifiers[mod]!.contexts[ctx]!.flatMap((s) => flatten(s.$ref)).map((t) => {
      if (!seen.has(t.name)) throw new Error(`${t.name} (${t.file}) overrides nothing in the base set`);
      return t;
    });
  const light = overrides("appearance", "light");
  const reduced = overrides("motion", "reduced");
  const theme = (t: Token) => t.extensions?.["org.cmd.theme"] !== undefined;

  // ── tokens.css
  const lines = [
    "/* Generated by `pnpm tokens` from packages/ui/tokens (DTCG 2025.10): edit those, not this.",
    `   ${r.description}`,
    "   The active theme sets its colours on :root at runtime (theme.tokens.json); everything",
    "   here derives from them. .ui-theme re-derives them in a subtree that sets a theme's",
    "   colours on itself (a theme preview inside a page of another). */",
    "",
    ":root, .ui-theme {",
  ];
  let file = "";
  for (const t of base) {
    if (theme(t)) continue;
    if (t.file !== file) {
      if (file) lines.push("");
      lines.push(`  /* ── ${t.file.replace(".tokens.json", "")} ── */`);
      file = t.file;
    }
    if (t.description) lines.push(`  /* ${t.description} */`);
    lines.push(`  ${t.name}: ${css(t)};`);
  }
  lines.push("}", "", "@media (prefers-reduced-motion: reduce) {", "  :root {");
  for (const t of reduced) lines.push(`    ${t.name}: ${css(t)};`);
  lines.push("  }", "}", "");

  // ── tokens.gen.ts
  const names = (prefix: string) => base.filter((t) => t.name.startsWith(`--${prefix}-`) && !theme(t)).map((t) => t.name.slice(prefix.length + 3));
  const list = (xs: string[]) => xs.map((x) => JSON.stringify(x)).join(", ");
  const info = base.map((t) => ({
    name: t.name,
    ...(t.type ? { type: t.type } : {}),
    value: theme(t) ? `theme: ${String(t.extensions!["org.cmd.theme"])}` : css(t),
    ...(t.description ? { description: t.description } : {}),
    ...(light.some((l) => l.name === t.name) ? { light: css(light.find((l) => l.name === t.name)!) } : {}),
  }));
  const ts = [
    "// Generated by `pnpm tokens` from packages/ui/tokens (DTCG 2025.10): edit those, not this.",
    "",
    "/** The spacing scale (--space-*): Stack, Inline and Tiles take these names. */",
    `export const SPACE = [${list(names("space"))}] as const;`,
    "export type SpaceName = (typeof SPACE)[number];",
    "/** The type scale (--text-*). */",
    `export const TEXT_SIZES = [${list(names("text").filter((n) => !["dim", "faint"].includes(n)))}] as const;`,
    "export type TextSize = (typeof TEXT_SIZES)[number];",
    "/** Corner radii (--radius-*; --radius itself for controls and rows). */",
    `export const RADII = [${list(names("radius"))}] as const;`,
    "export type RadiusName = (typeof RADII)[number];",
    "",
    "/** What light themes override (appearance-light.tokens.json), by name without the dashes. */",
    `export const LIGHT_VARS: Readonly<Record<string, string>> = ${JSON.stringify(Object.fromEntries(light.map((t) => [t.name.slice(2), css(t)])), null, 2)};`,
    "",
    "export interface TokenInfo {",
    "  name: string;",
    "  type?: string;",
    "  /** Its CSS value, or `theme: <source>` for what the active theme sets. */",
    "  value: string;",
    "  description?: string;",
    "  /** Its value in light themes, where they override it. */",
    "  light?: string;",
    "}",
    "",
    "/** Every token, in the order of its files: for the gallery, docs and agents. */",
    `export const TOKENS: readonly TokenInfo[] = ${JSON.stringify(info, null, 2)};`,
    "",
  ].join("\n");
  return { css: lines.join("\n"), ts, tokens: base };
}

if (import.meta.main) {
  const out = build();
  const check = process.argv.includes("--check");
  const stale: string[] = [];
  for (const [file, text] of [
    [OUT_CSS, out.css],
    [OUT_TS, out.ts],
  ] as const) {
    const now = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (now === text) continue;
    if (check) stale.push(path.relative(process.cwd(), file));
    else fs.writeFileSync(file, text);
  }
  if (stale.length) {
    console.error(`Stale: ${stale.join(", ")}. Run pnpm tokens.`);
    process.exit(1);
  }
  console.log(check ? "Tokens are up to date." : `${out.tokens.length} tokens → ${path.relative(process.cwd(), OUT_CSS)}, ${path.relative(process.cwd(), OUT_TS)}`);
}
