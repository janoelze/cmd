// A package widget's trees, drawn for the Magic agent to look at (docs/56, "Magic on V3"):
// each state the toolchain rendered (its story's, else its fixtures') goes to the previewer
// as data, the app draws it with its own kit in a window of the reference sizes
// (renderer/preview.html; Playwright loads the same page from the build), and the
// screenshots come back with what each render reported. No widget code runs in the page:
// the tree is data, drawn through the renderer's allow-list.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { PREVIEW_SIZES, type PreviewSize } from "@cmd/protocol";
import type { PreviewRequest, Previewer, PreviewShot } from "../previewer.ts";
import { STRIP, WIDE } from "../previewer.ts";
import type { TreeVariant } from "./toolchain.ts";
import { REPO } from "./toolchain.ts";

/** The preview page of the built renderer (for Playwright; the app loads its own). */
export const PREVIEW_PAGE = path.join(REPO, "apps/desktop/out/renderer/preview.html");
export const previewPageBuilt = (): boolean => fs.existsSync(PREVIEW_PAGE);

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

/**
 * The built preview page over HTTP on 127.0.0.1, for Playwright (Chromium won't load module
 * scripts from file://): the renderer's build folder only, read-only, for one batch of renders.
 */
export async function servePreviewPage(): Promise<{ url: string; origin: string; close(): void }> {
  if (!previewPageBuilt()) throw new Error("the app isn't built (pnpm build), so trees can't be drawn here");
  const root = path.dirname(PREVIEW_PAGE);
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    const file = path.join(root, path.normalize(rel));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(fs.readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: `${origin}/${path.basename(PREVIEW_PAGE)}`, origin, close: () => server.close() };
}

/** Evaluated in the preview page: once it has loaded its drawing (a module after load), draws the tree, waits for it to settle and measures it. */
export const drawTree = (tree: PreviewRequest["tree"]): string =>
  `(async () => { for (let i = 0; i < 200 && !window.__cmdPreview; i++) await new Promise((r) => setTimeout(r, 25)); return window.__cmdPreview(${JSON.stringify(tree)}); })()`;

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

// ── every theme and size (cmd widget preview) ───────────────

export interface MatrixOptions {
  /** Theme ids, or "all" (every theme the preview page has). */
  themes: string[] | "all";
  /** Reference sizes; null: each state at its story's size, else regular. */
  sizes: PreviewSize[] | null;
  /** Where the shots go (created); none: no files. */
  out?: string;
}

export interface MatrixShot {
  variant: string;
  widget: string;
  theme: string;
  size: PreviewSize;
  /** The PNG's path, when written. */
  file?: string;
  /** What's wrong with this render: overflow, an empty state where the state has data, console errors. */
  problems: string[];
}

const fileSafe = (s: string) => s.replace(/[^\w.-]+/g, "-");

/**
 * Each state × theme × size drawn by the built preview page in Playwright's Chromium (one page per
 * size, redrawn per theme), each checked: content wider than the window, an empty state where the
 * story gives data, and errors in the console, the page or the widget's own render.
 */
export async function previewMatrix(variants: TreeVariant[], widgets: Map<string, { title: string; icon: string }>, o: MatrixOptions): Promise<MatrixShot[]> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("Playwright isn't installed here, so nothing can be drawn (a checkout's pnpm install has it)");
  }
  const served = await servePreviewPage();
  const browser = await chromium.launch();
  const out: MatrixShot[] = [];
  try {
    if (o.out) fs.mkdirSync(o.out, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 560, height: 460 }, deviceScaleFactor: 2 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !/Content Security Policy/.test(m.text()) && errors.push(m.text()));
    await page.route("**/*", (route) => (route.request().url().startsWith(served.origin + "/") ? route.continue() : route.abort()));
    await page.goto(served.url, { waitUntil: "load" });
    await page.waitForFunction(() => typeof (window as unknown as { __cmdPreview?: unknown }).__cmdPreview === "function");
    const themes = o.themes === "all" ? await page.evaluate(() => (window as unknown as { __cmdPreviewThemes(): string[] }).__cmdPreviewThemes()) : o.themes;
    for (const v of variants) {
      const w = widgets.get(v.widget) ?? { title: v.widget, icon: "puzzlepiece.extension" };
      const own = v.size && v.size in PREVIEW_SIZES ? (v.size as PreviewSize) : "regular";
      for (const size of o.sizes ?? [own]) {
        const [width, height] = PREVIEW_SIZES[size];
        await page.setViewportSize({ width, height });
        for (const theme of themes) {
          errors.length = 0;
          const m = (await page.evaluate(drawTree({ messages: v.messages, title: w.title, icon: w.icon, theme }))) as Omit<PreviewShot, "png">;
          const problems = [...new Set([...v.errors, ...m.errors, ...errors])];
          if (m.scrollW > width + 2) problems.push(`content is ${m.scrollW}px wide in a ${width}px window`);
          if (v.empty && v.data && !/empty|none|nothing|blank/i.test(v.name)) problems.push("shows its empty state, though this state gives it data");
          if (m.text === 0 && m.nodes < 3) problems.push("draws nothing");
          let file: string | undefined;
          if (o.out) {
            file = path.join(o.out, `${fileSafe(variants.some((x) => x.widget !== v.widget) ? `${v.widget}-${v.name}` : v.name)}-${size}-${fileSafe(theme)}.png`);
            await page.screenshot({ path: file });
          }
          out.push({ variant: v.name, widget: v.widget, theme, size, file, problems });
        }
      }
    }
  } finally {
    served.close();
    await browser.close();
  }
  return out;
}
