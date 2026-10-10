// The stylesheets draw from the design tokens (packages/ui/tokens, docs/40-window-design.md):
// colours, font sizes, radii and spacing come from var(--…), not literal values. What
// isn't there yet is counted per file in design-debt.json, and the counts only go down:
// a new literal fails here (use the token, or add the token the view needs), and a file
// that lost some fails too, until `pnpm design-debt` writes the lower count, so the
// improvement can't quietly come back. Hairlines (1px) and 0 are fine everywhere.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const BASELINE = path.join(import.meta.dirname, "design-debt.json");
const dirs = ["packages/ui/src", "apps/desktop/src/renderer"];
const files = dirs
  .flatMap((d) => (fs.readdirSync(path.join(root, d), { recursive: true }) as string[]).filter((f) => f.endsWith(".css")).map((f) => path.join(d, f)))
  .filter((f) => !f.endsWith("ui/src/tokens.css"))
  .sort();

type Kind = "color" | "fontSize" | "radius" | "spacing";
const KINDS: Kind[] = ["color", "fontSize", "radius", "spacing"];

/** Every declaration of a file, comments left out. */
function declarations(file: string): { prop: string; value: string }[] {
  const css = fs.readFileSync(path.join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { prop: string; value: string }[] = [];
  for (const m of css.matchAll(/(?:^|[{;\s])([\w-]+)\s*:\s*([^;{}]+)(?=[;}])/g)) out.push({ prop: m[1]!, value: m[2]!.trim() });
  return out;
}

const px = (v: string) => [...v.matchAll(/(?<![\w.-])(\d*\.?\d+)px\b/g)].map((m) => parseFloat(m[1]!));
const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g;

/** The literals of each kind in a file, as "prop: value" lines. */
function literals(file: string): Record<Kind, string[]> {
  const found: Record<Kind, string[]> = { color: [], fontSize: [], radius: [], spacing: [] };
  for (const { prop, value } of declarations(file)) {
    const line = `${prop}: ${value}`;
    if (value.match(COLOR)) found.color.push(line);
    if (prop === "font-size" || prop === "font") {
      if (px(value).length) found.fontSize.push(line);
    } else if (/^border(-[a-z]+)*-radius$/.test(prop)) {
      if (px(value).some((n) => n > 0)) found.radius.push(line);
    } else if (/^(padding|margin|gap|row-gap|column-gap)(-[a-z-]+)?$/.test(prop)) {
      if (px(value).some((n) => n > 1)) found.spacing.push(line);
    }
  }
  return found;
}

const now = Object.fromEntries(files.map((f) => [f, literals(f)]));
const counts = Object.fromEntries(
  Object.entries(now)
    .map(([f, l]) => [f, Object.fromEntries(KINDS.filter((k) => l[k].length).map((k) => [k, l[k].length]))] as const)
    .filter(([, c]) => Object.keys(c).length),
);

describe("design tokens in the stylesheets", () => {
  it("found the stylesheets", () => {
    expect(files.length).toBeGreaterThan(5); // the glob works (fewer as windows move onto the kit)
  });

  if (process.env.UPDATE_DESIGN_DEBT) {
    it("writes design-debt.json", () => {
      fs.writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + "\n");
    });
    return;
  }

  const base = JSON.parse(fs.readFileSync(BASELINE, "utf8")) as Record<string, Partial<Record<Kind, number>>>;

  it("no stylesheet has more literal values than design-debt.json allows", () => {
    const over: string[] = [];
    for (const f of files)
      for (const k of KINDS) {
        const n = now[f]![k].length;
        const allowed = base[f]?.[k] ?? 0;
        if (n > allowed) over.push(`${f}: ${n} literal ${k} values, ${allowed} allowed. Use a token (packages/ui/tokens) instead of:\n    ${now[f]![k].join("\n    ")}`);
      }
    expect(over, over.join("\n")).toEqual([]);
  });

  it("design-debt.json is no higher than the stylesheets (pnpm design-debt locks in what got better)", () => {
    const under: string[] = [];
    for (const [f, c] of Object.entries(base))
      for (const k of KINDS) if ((c[k] ?? 0) > (now[f]?.[k].length ?? 0)) under.push(`${f}: ${k} went from ${c[k]} to ${now[f]?.[k].length ?? 0}`);
    expect(under, `Run pnpm design-debt to lower the baseline:\n${under.join("\n")}`).toEqual([]);
  });
});
