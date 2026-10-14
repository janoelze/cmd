// A package widget's trees, drawn for the Magic agent to look at (docs/56, "Magic on V3"):
// each state the toolchain rendered (its story's, else its fixtures') goes to the previewer
// as data, the app draws it with its own kit in a window of the reference sizes
// (renderer/preview.html; Playwright loads the same page from the build), and the
// screenshots come back with what each render reported. No widget code runs in the page:
// the tree is data, drawn through the renderer's allow-list.

import fs from "node:fs";
import path from "node:path";
import type { PreviewRequest, Previewer, PreviewShot } from "../../widgets/preview.ts";
import { STRIP, WIDE } from "../../widgets/preview.ts";
import type { TreeVariant } from "./toolchain.ts";
import { REPO } from "./toolchain.ts";

/** The preview page of the built renderer (for Playwright; the app loads its own). */
export const PREVIEW_PAGE = path.join(REPO, "apps/desktop/out/renderer/preview.html");
export const previewPageBuilt = (): boolean => fs.existsSync(PREVIEW_PAGE);

/** Evaluated in the preview page: draws the tree, waits for it to settle and measures it. */
export const drawTree = (tree: PreviewRequest["tree"]): string => `window.__cmdPreview(${JSON.stringify(tree)})`;

export interface TreePreview {
  ok: boolean;
  problems: string[];
  warnings: string[];
  /** Screenshots for the agent (base64 PNG): the first state in a strip window (dark), wide (light), then the others. */
  shots: string[];
  skipped?: string;
}

interface Case {
  v: TreeVariant;
  label: string;
  theme: "dark" | "light";
  size: [number, number];
}

/** The renders: the first state tall (dark) and wide (light), each other state tall; at most five. */
function cases(variants: TreeVariant[]): Case[] {
  const [first, ...rest] = variants;
  if (!first) return [];
  return [
    { v: first, label: `${first.name}, a strip window (${STRIP.join("×")}), dark`, theme: "dark", size: STRIP },
    { v: first, label: `${first.name}, wide (${WIDE.join("×")}), light`, theme: "light", size: WIDE },
    ...rest.slice(0, 3).map((v): Case => ({ v, label: `${v.name}, a strip window, dark`, theme: "dark", size: STRIP })),
  ];
}

/** Draw the states with the previewer; null previewer: say so (the agent still has the outlines). */
export async function previewTrees(previewer: Previewer | null, variants: TreeVariant[], widget: { title: string; icon: string }): Promise<TreePreview> {
  if (!previewer) return { ok: true, problems: [], warnings: [], shots: [], skipped: "no previewer (open the cmd app, or build it for the CLI: pnpm build)" };
  const list = cases(variants);
  if (!list.length) return { ok: true, problems: [], warnings: [], shots: [], skipped: "nothing to draw" };
  let shots: PreviewShot[];
  try {
    shots = await previewer.render(list.map((c) => ({ tree: { messages: c.v.messages, title: widget.title, icon: widget.icon, theme: c.theme }, width: c.size[0], height: c.size[1], shot: true })));
  } catch (e) {
    return { ok: true, problems: [], warnings: [], shots: [], skipped: `the previewer failed: ${(e as Error).message}` };
  }
  const problems: string[] = [];
  const warnings: string[] = [];
  const pngs: string[] = [];
  list.forEach((c, i) => {
    const s = shots[i];
    if (!s) return;
    if (s.png) pngs.push(s.png);
    for (const e of new Set(s.errors)) problems.push(`${c.label}: ${e}`);
    if (s.text === 0 && s.nodes < 3) problems.push(`${c.label}: draws nothing`);
    if (s.scrollW > c.size[0] + 2) warnings.push(`${c.label}: content is ${s.scrollW}px wide in a ${c.size[0]}px window`);
  });
  return { ok: !problems.length, problems, warnings, shots: pngs };
}
