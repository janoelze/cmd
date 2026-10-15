// A package widget's trees drawn and judged (docs/56, "Magic on V3", "Developer ergonomics"):
// each state the toolchain rendered (its story's, else its fixtures') goes to a previewer as
// data, drawn by the app's own kit at the reference sizes (PREVIEW_SIZES) in the themes asked
// for, and each draw is judged the same way: errors, drawing nothing, content wider than the
// window, an empty state where the state gives data. Magic's build (previewTrees: what the agent
// sees) and `cmd widget preview` (every theme and size, shots on disk) both draw through drawTrees.

import fs from "node:fs";
import path from "node:path";
import { PREVIEW_SIZES, type MagicPreviewShot, type PreviewSize } from "@cmd/protocol";
import { PREVIEW_STATES } from "../../widgets/limits.ts";
import type { Previewer } from "../previewer.ts";
import type { TreeVariant } from "./toolchain.ts";

/** One draw: a state, in a theme, at a reference size. */
interface Draw {
  variant: TreeVariant;
  theme: string;
  size: PreviewSize;
}

export interface DrawnTree {
  variant: string;
  widget: string;
  theme: string;
  size: PreviewSize;
  /** The PNG's path, when written. */
  file?: string;
  /** Base64, when not written to a file. */
  png?: string;
  /** What makes it wrong: errors, drawing nothing. */
  problems: string[];
  /** What makes it look wrong: overflow, an empty state where the state gives data. */
  warnings: string[];
}

export interface DrawOptions {
  /** Theme ids, or "all" (every theme the preview page has). */
  themes: string[] | "all";
  /** Reference sizes; null: each state at its story's size, else regular. */
  sizes: PreviewSize[] | null;
  /** Where the shots go (created); none: they come back as base64. */
  out?: string;
}

/** The size a state asks for in its story, else regular. */
const ownSize = (v: TreeVariant): PreviewSize => (v.size && v.size in PREVIEW_SIZES ? (v.size as PreviewSize) : "regular");

/** The one judge of a draw. */
export function judge(v: TreeVariant, s: MagicPreviewShot, width: number): { problems: string[]; warnings: string[] } {
  const problems = [...new Set(s.errors)];
  if (s.text === 0 && s.nodes < 3) problems.push("draws nothing");
  const warnings: string[] = [];
  if (s.scrollW > width + 2) warnings.push(`content is ${s.scrollW}px wide in a ${width}px window`);
  if (v.empty && v.data && !/empty|none|nothing|blank/i.test(v.name)) warnings.push("shows its empty state, though this state gives it data");
  return { problems, warnings };
}

const fileSafe = (s: string) => s.replace(/[^\w.-]+/g, "-");

/** Every state × theme × size (or each state at its own size) drawn by the previewer and judged; shots to `out`, else as base64. */
export async function drawTrees(previewer: Previewer, variants: TreeVariant[], widgets: Map<string, { title: string; icon: string }>, o: DrawOptions): Promise<DrawnTree[]> {
  const themes = o.themes === "all" ? ((await previewer.themes?.()) ?? ["dark", "light"]) : o.themes;
  return draw(previewer, variants.flatMap((v) => (o.sizes ?? [ownSize(v)]).flatMap((size) => themes.map((theme) => ({ variant: v, theme, size })))), widgets, o.out);
}

async function draw(previewer: Previewer, draws: Draw[], widgets: Map<string, { title: string; icon: string }>, out?: string): Promise<DrawnTree[]> {
  const several = new Set(draws.map((d) => d.variant.widget)).size > 1;
  const shots = await previewer.render(
    draws.map((d) => {
      const w = widgets.get(d.variant.widget) ?? { title: d.variant.widget, icon: "puzzlepiece.extension" };
      const [width, height] = PREVIEW_SIZES[d.size];
      // The tree it rendered at that size (1.3: its env's size and box), else its one tree.
      return { tree: { messages: d.variant.sized?.[d.size] ?? d.variant.messages, title: w.title, icon: w.icon, theme: d.theme }, width, height, shot: true };
    }),
  );
  if (out) fs.mkdirSync(out, { recursive: true });
  return draws.map((d, i): DrawnTree => {
    const s = shots[i] ?? { errors: ["not drawn"], text: 0, nodes: 0, drawn: false, scrollW: 0, scrollH: 0 };
    const v = d.variant;
    let file: string | undefined;
    if (out && s.png) {
      file = path.join(out, `${fileSafe(several ? `${v.widget}-${v.name}` : v.name)}-${d.size}-${fileSafe(d.theme)}.png`);
      fs.writeFileSync(file, Buffer.from(s.png, "base64"));
    }
    return { variant: v.name, widget: v.widget, theme: d.theme, size: d.size, ...(file ? { file } : s.png ? { png: s.png } : {}), ...judge(v, s, PREVIEW_SIZES[d.size][0]) };
  });
}

export interface TreePreview {
  ok: boolean;
  problems: string[];
  warnings: string[];
  /** Screenshots for the agent (base64 PNG): the first state narrow (dark), wide (light), then the others. */
  shots: string[];
  skipped?: string;
}

/** What Magic's agent looks at: the first state narrow (dark) and wide (light), each other state at its own size (dark). */
export async function previewTrees(previewer: Previewer | null, variants: TreeVariant[], widgets: Map<string, { title: string; icon: string }>): Promise<TreePreview> {
  if (!previewer) return { ok: true, problems: [], warnings: [], shots: [], skipped: "no previewer (open the cmd app, or build it for the CLI: pnpm build)" };
  const [first, ...rest] = variants;
  if (!first) return { ok: true, problems: [], warnings: [], shots: [], skipped: "nothing to draw" };
  const draws: Draw[] = [{ variant: first, theme: "dark", size: "narrow" }, { variant: first, theme: "light", size: "wide" }, ...rest.slice(0, PREVIEW_STATES).map((v): Draw => ({ variant: v, theme: "dark", size: ownSize(v) }))];
  let drawn: DrawnTree[];
  try {
    drawn = await draw(previewer, draws, widgets);
  } catch (e) {
    return { ok: true, problems: [], warnings: [], shots: [], skipped: `the previewer failed: ${(e as Error).message}` };
  }
  const label = (d: DrawnTree) => `${d.variant}, ${d.size} (${PREVIEW_SIZES[d.size].join("×")}), ${d.theme}`;
  const problems = drawn.flatMap((d) => d.problems.map((p) => `${label(d)}: ${p}`));
  const warnings = drawn.flatMap((d) => d.warnings.map((p) => `${label(d)}: ${p}`));
  return { ok: !problems.length, problems, warnings, shots: drawn.flatMap((d) => (d.png ? [d.png] : [])) };
}
