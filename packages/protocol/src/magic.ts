// Magic (docs/56, "Magic on V3"): a Magic window's state while it makes a widget package (or
// ends with a command to run), the progress the core streams, the edit view's versions, what
// the previewer is asked and answers, and the frame's vocabulary (its kit files, theme tokens
// and CSP) that the app's frame host still uses.

import { DEFAULT_SETTINGS } from "./settings.ts";
import type { MagicPackageBuild, MagicPreviewTree } from "./magic-package.ts";
export type { MagicPackageMethods, MagicPackageInfo } from "./magic-package.ts";

/** One agent step as the window shows it. */
export interface MagicStep {
  id: number;
  tool: string;
  /** The agent's few words: "Looking at network services". */
  why: string;
  /** The command, path or URL, shortened. */
  detail: string;
  ms?: number;
  isError?: boolean;
  /** Output, shortened (for "How this was made"). */
  output?: string;
}

/** A Magic window's state (AppWindow.state of kind "magic"): a request, its build, or the command it ended with. */
export interface MagicState {
  [key: string]: unknown;
  /** The request, as typed; changes are appended to `history`. */
  prompt: string;
  phase: "empty" | "working" | "ready" | "error";
  /** "terminal": the build ended with a command to run (the window offers it). */
  kind?: "terminal";
  /** SF Symbol the build picked (shown instead of sparkles). */
  icon?: string;
  /** The command a "terminal" window offers. */
  command?: string;
  size?: "s" | "m" | "l" | "wide";
  /** A problem with the window itself (the build failed). */
  error?: string;
  steps?: MagicStep[];
  /** Earlier requests of this window (the first request, then changes). */
  history?: string[];
  /** The agent's closing words for the last build. */
  summary?: string;
  /** The build waits for the person: download Deno (magic.installRuntime) or not now (magic.skipRuntime). */
  askRuntime?: boolean;
  /** A build that makes (or changes) a widget package (docs/56, "Magic on V3"). */
  pkg?: MagicPackageBuild;
}

/** A version of a package made with Magic (magic.package): a build, a Restore or a hand edit. */
export interface MagicRevision {
  n: number;
  at: number;
  prompt: string;
  ok: boolean;
  problems?: string[];
  model?: string;
  /** Path of its screenshot, if any. */
  shot?: string;
  /** Files changed outside a build ("Edited by hand"): nothing checked them. */
  hand?: boolean;
}

/** One render the core asks the app to make offscreen and measure. */
export interface MagicPreviewRequest {
  /** A page to load, or */
  page?: string;
  /** a package widget's tree, drawn by the app's kit. */
  tree?: MagicPreviewTree;
  width: number;
  height: number;
  shot?: boolean;
}

export interface MagicPreviewShot {
  errors: string[];
  text: number;
  nodes: number;
  drawn: boolean;
  scrollW: number;
  scrollH: number;
  /** Bounds of the visible content in the viewport (null: nothing visible). */
  box?: { top: number; left: number; bottom: number; right: number } | null;
  png?: string;
}

/** What widget packages run on (magic.runtime). */
export interface MagicRuntime {
  deno: string | null;
  version: string | null;
  /** sandbox-exec works here (else widgets run only with CMD_MAGIC_UNSANDBOXED=1). */
  sandbox: boolean;
  /** Who renders previews: "app", "playwright", or null. */
  previewer: string | null;
}

/** Progress of a run, streamed as `magic.stream` events (not persisted). */
export type MagicProgress =
  | { type: "step"; step: MagicStep }
  | { type: "title"; title: string }
  | { type: "verify" }
  | { type: "repair"; reason: string }
  | { type: "done" }
  | { type: "error"; message: string };

/**
 * The CSS a frame loads by kit version: the app's frame host (main/index.ts, cmd-widget://)
 * still serves frames by these; the frame host of docs/56 phase 2b replaces it.
 */
export const KIT_FILES: Readonly<Record<number, readonly string[]>> = { 1: ["kits/1.css"], 2: ["kits/2.css"], 3: ["tokens.css", "kit.css"] };
/** A known kit version, else 1. */
export const kitVersion = (v: unknown): number => (typeof v === "number" && v in KIT_FILES ? v : 1);

/** A theme as a widget's frame needs it: its appearance and the variables it sets on the app's :root (themeVars, light themes' overrides included). */
export interface ThemeLike {
  appearance: "dark" | "light";
  vars: Readonly<Record<string, string>>;
}

/**
 * What the host sets on a widget's :root: the theme's variables, as the app sets them on
 * its own, and the person's fonts. The frame's tokens.css (generated from the app's
 * tokens, packages/ui/tokens) derives everything else from them, so widgets share the
 * app's vocabulary. `--bg` stays the frame's own: inside a widget it is the window's
 * background (--well), not the board.
 */
export function widgetTokens(t: ThemeLike, fonts: { text?: string; mono?: string } = {}): Record<string, string> {
  const out: Record<string, string> = { "color-scheme": t.appearance };
  for (const [k, v] of Object.entries(t.vars)) if (k !== "--bg") out[k] = v;
  // The app passes the font.text / font.code settings; the defaults are theirs.
  const text = fonts.text || DEFAULT_SETTINGS["font.text"];
  if (text) out["--font-ui"] = text;
  out["--font-mono"] = fonts.mono || DEFAULT_SETTINGS["font.code"];
  return out;
}

/**
 * Evaluated in a rendered widget page (previews) once it settled: visible text,
 * elements, whether something was drawn, its scroll size, script errors host.js
 * caught, and `box`: the bounds of everything visible (text, controls, drawings,
 * filled or bordered boxes), to tell whether the content uses the window or
 * floats in it.
 */
export const WIDGET_MEASURE = `(() => {
  const b = document.body;
  const vw = innerWidth, vh = innerHeight;
  const drawn = [...b.querySelectorAll("canvas,svg,img,video")].some((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; });
  let top = Infinity, left = Infinity, bottom = -Infinity, right = -Infinity;
  const add = (r) => {
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return;
    top = Math.min(top, Math.max(0, r.top)); left = Math.min(left, Math.max(0, r.left));
    bottom = Math.max(bottom, Math.min(vh, r.bottom)); right = Math.max(right, Math.min(vw, r.right));
  };
  const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    for (const r of range.getClientRects()) add(r);
  }
  for (const e of b.querySelectorAll("*")) {
    const cs = getComputedStyle(e);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
    const solid = /^(CANVAS|SVG|IMG|VIDEO|INPUT|BUTTON|SELECT|TEXTAREA|PROGRESS|METER)$/i.test(e.tagName) ||
      (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") || parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0 || cs.boxShadow !== "none" || cs.maskImage !== "none" || cs.webkitMaskImage !== "none";
    if (solid) add(e.getBoundingClientRect());
  }
  const box = top === Infinity ? null : { top: Math.round(top), left: Math.round(left), bottom: Math.round(bottom), right: Math.round(right) };
  return { text: b.innerText.trim().length, nodes: b.querySelectorAll("*").length, drawn, scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight, box, errors: (window.__CMD_ERRORS__ || []).map((e) => e.message) };
})()`;

/** Widget size hints → the viewport the model is told about. */
export const MAGIC_SIZES = { s: [320, 200], m: [480, 320], l: [720, 480], wide: [960, 280] } as const;

/** The frame's CSP: no network, no navigation, no plugins; only its own inline code, plus media from allowed origins. */
export function widgetCsp(media: string[] = []): string {
  const extra = media.map(mediaOrigin).filter((o): o is string => !!o).map((o) => " " + o).join("");
  return `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:${extra}; media-src data:${extra}; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`;
}
export const WIDGET_CSP = widgetCsp();

/** An https URL or origin → its origin ("https://host[:port]"); null for anything else. */
export function mediaOrigin(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try {
    const url = new URL(u.includes("://") ? u : `https://${u}`);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}
