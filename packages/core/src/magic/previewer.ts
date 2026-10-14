// Who draws a widget package before anyone sees it (docs/56, "Magic on V3"): the app, in an
// offscreen window (main/preview.ts, through the core: previews.ts), or, for the CLI and a core
// without an app, Playwright's Chromium loading the built renderer's preview page. Each render
// reports script errors, whether anything was drawn, its size and where its content is, and
// can return a screenshot. A package's trees come from its sandboxed test run (package/preview.ts).

import { WIDGET_MEASURE, type MagicPreviewTree } from "@cmd/protocol";

export interface PreviewRequest {
  /** A complete page, or */
  page?: string;
  /** a package widget's tree, drawn by the app's kit (renderer/preview.html; magic/package/preview.ts). */
  tree?: MagicPreviewTree;
  width: number;
  height: number;
  /** Return a PNG (base64). */
  shot?: boolean;
}

export interface PreviewShot {
  errors: string[];
  /** Characters of visible text. */
  text: number;
  /** Elements in the body. */
  nodes: number;
  /** Has a canvas, svg, img or video with a size. */
  drawn: boolean;
  scrollW: number;
  scrollH: number;
  /** Bounds of the visible content in the viewport. */
  box?: { top: number; left: number; bottom: number; right: number } | null;
  png?: string;
}

export interface Previewer {
  name: string;
  render(requests: PreviewRequest[]): Promise<PreviewShot[]>;
}

/** Evaluated in the page after it settled. */
export const MEASURE = WIDGET_MEASURE;

/** A window in the strip (cmd's default layout): a column the full height of the screen. */
export const STRIP: [number, number] = [440, 880];
/** A window in focus mode, or a wide grid cell. */
export const WIDE: [number, number] = [1000, 560];

// ── Playwright ───────────────────────────────────────────

/** Headless Chromium through Playwright, when it is installed (dev checkouts, the CLI). */
export async function playwrightPreviewer(): Promise<Previewer | null> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return null;
  }
  return {
    name: "playwright",
    async render(requests) {
      const browser = await chromium.launch();
      let served: { url: string; origin: string; close(): void } | null = null;
      try {
        const out: PreviewShot[] = [];
        for (const r of requests) {
          const page = await browser.newPage({ viewport: { width: r.width, height: r.height }, deviceScaleFactor: 2 });
          const errors: string[] = [];
          page.on("pageerror", (e) => errors.push(e.message));
          page.on("console", (m) => m.type() === "error" && !/Content Security Policy/.test(m.text()) && errors.push(m.text()));
          let m: Omit<PreviewShot, "png">;
          if (r.tree) {
            // The built renderer's preview page draws the tree; it may load its own files, nothing else.
            const { drawTree, servePreviewPage } = await import("./package/preview.ts");
            served ??= await servePreviewPage();
            const origin = served.origin;
            await page.route("**/*", (route) => (route.request().url().startsWith(origin + "/") ? route.continue() : route.abort()));
            await page.goto(served.url, { waitUntil: "load" });
            m = (await page.evaluate(drawTree(r.tree))) as Omit<PreviewShot, "png">;
          } else {
            await page.route("**/*", (route) => route.abort());
            await page.setContent(r.page ?? "", { waitUntil: "load" });
            await page.waitForTimeout(500);
            m = (await page.evaluate(MEASURE)) as Omit<PreviewShot, "png">;
          }
          const png = r.shot ? (await page.screenshot()).toString("base64") : undefined;
          out.push({ ...m, errors: [...m.errors, ...errors], png });
          await page.close();
        }
        return out;
      } finally {
        served?.close();
        await browser.close();
      }
    },
  };
}
