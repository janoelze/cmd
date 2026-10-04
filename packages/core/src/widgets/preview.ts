// Rendering a widget before anyone sees it (docs/14-magic-v2.md): the view
// with its live data and with every fixture, at its size and small, dark and
// light. Each render reports script errors, whether anything was drawn, and
// whether it fits; one screenshot goes back to the agent. The app renders in
// an offscreen Electron window (main/preview.ts, through the core); the CLI
// and a core without an app use Playwright's Chromium.

import { MAGIC_SIZES, WIDGET_MEASURE, widgetCsp, widgetTokens, type ThemeLike } from "@cmd/protocol";
import { widgetHtml } from "../magic/host.ts";
import type { WidgetManifest } from "./manifest.ts";

export interface PreviewRequest {
  /** A complete page (widgetHtml with the data inlined and a CSP). */
  page: string;
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
  png?: string;
}

export interface Previewer {
  name: string;
  render(requests: PreviewRequest[]): Promise<PreviewShot[]>;
}

/** Evaluated in the page after it settled. */
export const MEASURE = WIDGET_MEASURE;

/** Two themes to render with (from cmd's default dark and light themes). */
export const PREVIEW_THEMES: Record<"dark" | "light", ThemeLike> = {
  dark: {
    appearance: "dark",
    colors: { well: "#161618", bgElevated: "#2a2a2c", text: "#ececec", textDim: "#8e8e93", accent: "#0a84ff", ink: "#ffffff" },
    terminal: { red: "#ff6b5e", green: "#7bd88f", yellow: "#ffd866", blue: "#8f8fff", magenta: "#e08cff", cyan: "#6fe0e8" },
  },
  light: {
    appearance: "light",
    colors: { well: "#ffffff", bgElevated: "#ffffff", text: "#1d1d1f", textDim: "#6e6e73", accent: "#007aff", ink: "#000000" },
    terminal: { red: "#d1242f", green: "#1a7f37", yellow: "#9a6700", blue: "#3b5bdb", magenta: "#a626a4", cyan: "#0b7d86" },
  },
};

export function previewPage(body: string, data: unknown, theme: ThemeLike, media: string[] = []): string {
  const page = widgetHtml({ title: "preview", body, tokens: widgetTokens(theme), data });
  return page.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${widgetCsp(media)}">`);
}

export const SMALL: [number, number] = [240, 150];

export interface PreviewCase {
  label: string;
  data: unknown;
  theme: "dark" | "light";
  size: [number, number];
  /** Problems here fail the build (else they are warnings). */
  strict: boolean;
  shot?: boolean;
}

export interface PreviewReport {
  ok: boolean;
  problems: string[];
  warnings: string[];
  /** The main screenshot (live data, its size, dark), base64 PNG. */
  shot?: string;
  /** No previewer was available: nothing was rendered. */
  skipped?: boolean;
}

/** The renders a widget gets: live data dark and light at its size, small, and each fixture. */
export function previewCases(m: WidgetManifest, live: unknown, fixtures: { name: string; data: unknown }[]): PreviewCase[] {
  const size = [...MAGIC_SIZES[m.size]] as [number, number];
  const cases: PreviewCase[] = [
    { label: "live data, dark", data: live, theme: "dark", size, strict: true, shot: true },
    { label: "live data, light", data: live, theme: "light", size, strict: true },
    { label: `live data at ${SMALL.join("×")}`, data: live, theme: "dark", size: SMALL, strict: false },
  ];
  for (const f of fixtures) if (f.name !== "live") cases.push({ label: `fixture ${f.name}`, data: f.data, theme: "dark", size, strict: true });
  return cases;
}

export async function preview(previewer: Previewer | null, body: string, m: WidgetManifest, cases: PreviewCase[]): Promise<PreviewReport> {
  if (!previewer) return { ok: true, problems: [], warnings: ["not rendered: no previewer (open the cmd app, or install Playwright for the CLI)"], skipped: true };
  const shots = await previewer.render(cases.map((c) => ({ page: previewPage(body, c.data, PREVIEW_THEMES[c.theme], m.media), width: c.size[0], height: c.size[1], shot: c.shot })));
  const problems: string[] = [];
  const warnings: string[] = [];
  let shot: string | undefined;
  cases.forEach((c, i) => {
    const s = shots[i];
    if (!s) return;
    if (c.shot && s.png) shot = s.png;
    const add = (msg: string, hard = c.strict) => (hard ? problems : warnings).push(`${c.label}: ${msg}`);
    for (const e of new Set(s.errors)) add(`script error: ${e}`, true);
    if (s.text === 0 && !s.drawn && s.nodes < 3) add("draws nothing", true);
    if (s.scrollW > c.size[0] + 2) add(`content is ${s.scrollW}px wide in a ${c.size[0]}px window (it scrolls sideways)`);
    if (s.scrollH > c.size[1] + 2) add(`content is ${s.scrollH}px tall in a ${c.size[1]}px window`, false);
  });
  return { ok: !problems.length, problems, warnings, shot };
}

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
      try {
        const out: PreviewShot[] = [];
        for (const r of requests) {
          const page = await browser.newPage({ viewport: { width: r.width, height: r.height }, deviceScaleFactor: 2 });
          const errors: string[] = [];
          page.on("pageerror", (e) => errors.push(e.message));
          page.on("console", (m) => m.type() === "error" && !/Content Security Policy/.test(m.text()) && errors.push(m.text()));
          await page.route("**/*", (route) => route.abort());
          await page.setContent(r.page, { waitUntil: "load" });
          await page.waitForTimeout(500);
          const m = (await page.evaluate(MEASURE)) as Omit<PreviewShot, "png">;
          const png = r.shot ? (await page.screenshot()).toString("base64") : undefined;
          out.push({ ...m, errors: [...m.errors, ...errors], png });
          await page.close();
        }
        return out;
      } finally {
        await browser.close();
      }
    },
  };
}
