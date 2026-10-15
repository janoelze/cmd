// `cmd widget preview [dir]` (docs/56, "Developer ergonomics"; the previewer of docs/14, over
// trees): each state of the package's story (else its fixtures) rendered against the fake host
// by the toolchain Magic previews with (sandboxed Vitest), then drawn by the app's own preview
// page in Playwright, in every theme and reference size asked for, and judged as Magic's build
// judges its previews (magic/package/preview.ts's drawTrees).
// Shots go to <dir>/.cmd-preview; it exits 2 when any render overflows its window, shows its
// empty state though the state gives it data, or logs an error.

import path from "node:path";
import { parseArgs } from "node:util";
import { PREVIEW_SIZES, type PreviewSize } from "@cmd/protocol";
import { checkoutToolchain, drawTrees, playwrightPreviewer, previewPageBuilt, type DrawnTree } from "@cmd/core/magic";
import { dim, green, red } from "./magic.ts";
import { tilde } from "./tilde.ts";
import { loadPackage, NO_SANDBOX, toolSandbox } from "./widget-new.ts";

const SIZES = Object.keys(PREVIEW_SIZES) as PreviewSize[];

export async function previewCommand(argv: string[]): Promise<number> {
  const { values: o, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { themes: { type: "string" }, sizes: { type: "string" }, out: { type: "string" }, json: { type: "boolean" } } });
  const dir = path.resolve(positionals[0] ?? ".");
  const themes = !o.themes ? ["dark"] : o.themes === "all" ? ("all" as const) : o.themes.split(",").map((t) => t.trim()).filter(Boolean);
  let sizes: PreviewSize[] | null = null;
  if (o.sizes) {
    const asked = o.sizes === "all" ? SIZES : o.sizes.split(",").map((s) => s.trim());
    const bad = asked.filter((s) => !SIZES.includes(s as PreviewSize));
    if (bad.length) {
      console.error(red(`--sizes takes all, or ${SIZES.join(", ")}`));
      return 1;
    }
    sizes = asked as PreviewSize[];
  }

  const pkg = loadPackage(dir);
  if (!pkg) return 2;
  const tools = checkoutToolchain();
  if (!tools) {
    console.error(red("this cmd has no Vitest to render widgets with (a checkout's pnpm install has)"));
    return 2;
  }
  if (!previewPageBuilt()) {
    console.error(red("the app isn't built, so there's nothing to draw with: run pnpm build in the cmd checkout"));
    return 2;
  }
  const sandbox = toolSandbox();
  if (!sandbox) {
    console.error(red(NO_SANDBOX));
    return 2;
  }
  const trees = await tools.trees(dir, { sandbox, deny: [] });
  if (trees.skipped) {
    console.log(dim(`nothing to preview: ${trees.skipped}`));
    return 0;
  }
  if (!trees.variants.length) {
    for (const p of trees.problems) console.error(red(`  ${p}`));
    console.error(`${red("✗")} ${pkg.name} ${dim("· couldn't be rendered")}`);
    return 2;
  }
  const out = path.resolve(o.out ?? path.join(dir, ".cmd-preview"));
  const widgets = new Map(pkg.widgets.map((w) => [w.id, { title: w.title, icon: w.icon }]));
  const previewer = await playwrightPreviewer();
  if (!previewer) {
    console.error(red("Playwright isn't installed here, so nothing can be drawn (a checkout's pnpm install has it)"));
    return 2;
  }
  let drawn: DrawnTree[];
  try {
    drawn = await drawTrees(previewer, trees.variants, widgets, { themes, sizes, out });
  } catch (e) {
    console.error(red((e as Error).message));
    return 2;
  }
  // One list per draw for the person: the tree run's own errors, what the judge found.
  const shots = drawn.map(({ warnings, ...d }) => ({ ...d, problems: [...new Set([...(trees.variants.find((v) => v.name === d.variant && v.widget === d.widget)?.errors ?? []), ...d.problems, ...warnings])] }));
  if (o.json) {
    console.log(JSON.stringify({ ok: shots.every((s) => !s.problems.length), out, shots }, null, 2));
    return shots.some((s) => s.problems.length) ? 2 : 0;
  }

  // One line per state and size; a problem once per state with where it happened.
  let failed = 0;
  const several = pkg.widgets.length > 1;
  for (const v of trees.variants) {
    const label = several ? `${v.widget} · ${v.name}` : v.name;
    const mine = shots.filter((s) => s.variant === v.name && s.widget === v.widget);
    const where = new Map<string, string[]>();
    for (const s of mine) for (const p of s.problems) where.set(p, [...(where.get(p) ?? []), `${s.size} ${s.theme}`]);
    const sizesDrawn = [...new Set(mine.map((s) => s.size))].join(", ");
    const themeCount = new Set(mine.map((s) => s.theme)).size;
    const what = dim(`· ${sizesDrawn} · ${themeCount === 1 ? mine[0]?.theme : `${themeCount} themes`}`);
    if (!where.size) {
      console.log(`${green("✓")} ${label} ${what}`);
      continue;
    }
    failed++;
    console.log(`${red("✗")} ${label} ${what}`);
    for (const [p, at] of where) console.log(red(`  ${p}`) + dim(at.length === mine.length ? "" : `  (${at.slice(0, 3).join("; ")}${at.length > 3 ? `; ${at.length - 3} more` : ""})`));
  }
  console.log(dim(`${shots.length} ${shots.length === 1 ? "shot" : "shots"} in ${tilde(out)}`));
  return failed ? 2 : 0;
}
