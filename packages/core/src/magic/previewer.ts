// Who draws a widget package's trees (docs/56, "Magic on V3"): the app, in an offscreen window
// (main/preview.ts, through the core: previews.ts), or Playwright's Chromium loading the built
// renderer's preview page over 127.0.0.1 (the CLI, evals, a core without an app). Both run the
// same page and script (protocol's previewScript); each draw reports errors, whether anything was
// drawn, its scroll size, and a screenshot when asked. What is drawn and how it is judged:
// package/preview.ts's drawTrees.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { previewScript, type MagicPreviewRequest, type MagicPreviewShot } from "@cmd/protocol";
import { REPO } from "./package/toolchain.ts";

export interface Previewer {
  name: string;
  render(requests: MagicPreviewRequest[]): Promise<MagicPreviewShot[]>;
  /** Every theme the preview page has (`--themes all`); a previewer without the list draws dark and light. */
  themes?(): Promise<string[]>;
}

/** The preview page of the built renderer (for Playwright; the app loads its own). */
export const PREVIEW_PAGE = path.join(REPO, "apps/desktop/out/renderer/preview.html");
export const previewPageBuilt = (): boolean => fs.existsSync(PREVIEW_PAGE);

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

/**
 * The built preview page over HTTP on 127.0.0.1 (Chromium won't load module scripts from
 * file://): the renderer's build folder only, read-only, for one batch of draws.
 */
async function servePreviewPage(): Promise<{ url: string; origin: string; close(): void }> {
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

/** Headless Chromium through Playwright, when it is installed (dev checkouts, the CLI): one page per batch, resized and redrawn per request. */
export async function playwrightPreviewer(): Promise<Previewer | null> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return null;
  }
  /** The preview page loaded in a fresh Chromium, for one batch; it may load its own files, nothing else. */
  const session = async <T>(fn: (page: import("playwright").Page, errors: string[]) => Promise<T>): Promise<T> => {
    const served = await servePreviewPage();
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 560, height: 460 }, deviceScaleFactor: 2 });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && !/Content Security Policy/.test(m.text()) && errors.push(m.text()));
      await page.route("**/*", (route) => (route.request().url().startsWith(served.origin + "/") ? route.continue() : route.abort()));
      await page.goto(served.url, { waitUntil: "load" });
      return await fn(page, errors);
    } finally {
      served.close();
      await browser.close();
    }
  };
  return {
    name: "playwright",
    render: (requests) =>
      session(async (page, errors) => {
        const out: MagicPreviewShot[] = [];
        for (const r of requests) {
          errors.length = 0;
          await page.setViewportSize({ width: Math.round(r.width), height: Math.round(r.height) });
          const m = (await page.evaluate(previewScript(r.tree))) as MagicPreviewShot;
          const png = r.shot ? (await page.screenshot()).toString("base64") : undefined;
          out.push({ ...m, errors: [...m.errors, ...errors], png });
        }
        return out;
      }),
    themes: () =>
      session(async (page) => {
        await page.waitForFunction(() => typeof (window as unknown as { __cmdPreviewThemes?: unknown }).__cmdPreviewThemes === "function");
        return page.evaluate(() => (window as unknown as { __cmdPreviewThemes(): string[] }).__cmdPreviewThemes());
      }),
  };
}
