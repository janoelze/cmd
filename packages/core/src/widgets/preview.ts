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
/** A window in the strip (cmd's default layout): a column the full height of the screen. */
export const STRIP: [number, number] = [440, 880];
/** A window in focus mode, or a wide grid cell. */
export const WIDE: [number, number] = [1000, 560];

export interface PreviewCase {
  label: string;
  data: unknown;
  theme: "dark" | "light";
  size: [number, number];
  /** Problems here fail the build (else they are warnings). */
  strict: boolean;
  /** Check how the content uses the window (it doesn't float in the middle). */
  layout?: boolean;
  shot?: boolean;
}

export interface PreviewReport {
  ok: boolean;
  problems: string[];
  warnings: string[];
  /** The main screenshot (live data, a strip window, dark), base64 PNG. */
  shot?: string;
  /** More screenshots for the agent (light at its size, wide). */
  shots?: string[];
  /** No previewer was available: nothing was rendered. */
  skipped?: boolean;
}

/**
 * The renders a widget gets: live data in a tall strip window (dark) and at its
 * own size (light), wide, small, and each fixture in a strip window.
 */
export function previewCases(m: WidgetManifest, live: unknown, fixtures: { name: string; data: unknown }[]): PreviewCase[] {
  const size = [...MAGIC_SIZES[m.size]] as [number, number];
  const cases: PreviewCase[] = [
    { label: `live data, a strip window (${STRIP.join("×")}), dark`, data: live, theme: "dark", size: STRIP, strict: true, layout: true, shot: true },
    { label: `live data at its size (${size.join("×")}), light`, data: live, theme: "light", size, strict: true, layout: true, shot: true },
    { label: `live data, wide (${WIDE.join("×")})`, data: live, theme: "dark", size: WIDE, strict: false, layout: true, shot: true },
    { label: `live data at ${SMALL.join("×")}`, data: live, theme: "dark", size: SMALL, strict: false },
  ];
  for (const f of fixtures) if (f.name !== "live") cases.push({ label: `fixture ${f.name}, a strip window`, data: f.data, theme: "dark", size: STRIP, strict: true });
  return cases;
}

/**
 * How the content sits in the window (prompt.md → Layout): it starts at the top
 * and, in a tall window, something grows to use the height. Content in a band
 * in the middle (centred, with empty space above and below) is a web page
 * demo, not an app.
 */
export function layoutIssues(box: PreviewShot["box"], w: number, h: number): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!box) return { problems, warnings };
  const above = box.top;
  const below = h - box.bottom;
  const used = (box.bottom - box.top) / h;
  if (above > Math.max(48, h * 0.15) && below > Math.max(48, h * 0.15)) problems.push(`the content floats in the middle of the window (${above}px empty above it, ${below}px below): start at the top, put controls in a footer at the bottom, and let one part grow into the height (see Layout)`);
  else if (above > Math.max(64, h * 0.25)) problems.push(`the content starts ${above}px down the window, leaving the top empty: start at the top (see Layout)`);
  else if (h >= 500 && used < 0.45) warnings.push(`the content uses only the top ${Math.round(used * 100)}% of a ${h}px tall window: in a tall window let a list, chart or visualizer take the rest of the height (k-main / k-grow-v)`);
  const side = Math.min(box.left, w - box.right);
  if (w >= 800 && side > w * 0.2) warnings.push(`the content is a narrow column centred in a ${w}px wide window (${side}px empty at each side): let it span the width, or lay out panes side by side`);
  return { problems, warnings };
}

export async function preview(previewer: Previewer | null, body: string, m: WidgetManifest, cases: PreviewCase[]): Promise<PreviewReport> {
  if (!previewer) return { ok: true, problems: [], warnings: ["not rendered: no previewer (open the cmd app, or install Playwright for the CLI)"], skipped: true };
  const shots = await previewer.render(cases.map((c) => ({ page: previewPage(body, c.data, PREVIEW_THEMES[c.theme], m.media), width: c.size[0], height: c.size[1], shot: c.shot })));
  const problems: string[] = [];
  const warnings: string[] = [];
  const pngs: string[] = [];
  cases.forEach((c, i) => {
    const s = shots[i];
    if (!s) return;
    if (c.shot && s.png) pngs.push(s.png);
    const add = (msg: string, hard = c.strict) => (hard ? problems : warnings).push(`${c.label}: ${msg}`);
    for (const e of new Set(s.errors)) add(`script error: ${e}`, true);
    if (s.text === 0 && !s.drawn && s.nodes < 3) add("draws nothing", true);
    if (s.scrollW > c.size[0] + 2) add(`content is ${s.scrollW}px wide in a ${c.size[0]}px window (it scrolls sideways)`);
    if (s.scrollH > c.size[1] + 2) add(`content is ${s.scrollH}px tall in a ${c.size[1]}px window`, false);
    if (c.layout) {
      const l = layoutIssues(s.box, c.size[0], c.size[1]);
      for (const p of l.problems) add(p);
      for (const w of l.warnings) add(w, false);
    }
  });
  return { ok: !problems.length, problems, warnings, shot: pngs[0], shots: pngs.slice(1) };
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
