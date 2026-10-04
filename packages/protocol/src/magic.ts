// Magic widgets (docs/12-magic-widgets.md): the window state the core stores,
// the progress events it streams, and the widget token vocabulary shared by the
// core (standalone pages, the prompt lab) and the renderer (live frames).

import { DEFAULT_SETTINGS } from "./settings.ts";
import type { Attention } from "./model.ts";

/** The model providers Magic widgets can use; each has its own API key (secrets.ts) and model setting. */
export const MAGIC_PROVIDERS = {
  anthropic: { title: "Anthropic", keySecret: "magic.anthropic.apiKey", modelSetting: "magic.anthropic.model" },
  openai: { title: "OpenAI", keySecret: "magic.openai.apiKey", modelSetting: "magic.openai.model" },
} as const;
export type MagicProvider = keyof typeof MAGIC_PROVIDERS;

/** A model a provider offers to the user's key (magic.models). */
export interface MagicModel {
  id: string;
  /** Display name, where the provider gives one. */
  name: string;
  /** Release time, ms (newest first in lists). */
  created?: number;
}

export type MagicSource = { type: "fetch"; url: string; headers?: Record<string, string> } | { type: "command"; command: string; cwd?: string };

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

/** How a widget's data has been doing (MagicState.health). */
export interface MagicHealth {
  /** The last run succeeded. */
  ok: boolean;
  /** When data last came in. */
  lastOk?: number;
  /** The last failure, for people (no secrets). */
  error?: string;
  errorAt?: number;
  /** Failures in a row. */
  failures: number;
  /** When the next run is due after failures (a server asked to wait, or backoff). */
  retryAt?: number;
  /** data.ts lacks a permission (manifest.json). */
  permission?: boolean;
}

/** A widget's status line (data.ts status()): the window's light and a few words. */
export interface MagicStatus {
  text: string;
  tone?: "good" | "warn" | "bad" | "dim";
}

/** A notification a widget's data.ts reported (notify()); shown once per key while it lasts. */
export interface MagicNotify {
  key: string;
  title?: string;
  body: string;
  urgent?: boolean;
}

/** A widget in the library (docs/16-widgets.md): built at least once, kept until deleted. */
export interface MagicLibraryEntry {
  id: string;
  title: string;
  description?: string;
  /** The first request, then each change. */
  history: string[];
  summary?: string;
  createdAt: number;
  usedAt: number;
  /** The latest revision, and its screenshot (a file path) if it has one. */
  revision: number;
  shot?: string;
  /** Windows showing it now. */
  windows: string[];
}

/** A Magic widget's state (AppWindow.state of kind "magic"). */
export interface MagicState {
  [key: string]: unknown;
  /** The request, as typed; refinements are appended to `history`. */
  prompt: string;
  phase: "empty" | "working" | "ready" | "error";
  kind?: "widget" | "terminal";
  /** The widget this window shows ($CMD_HOME/widgets/<id>), v2 windows. Its own id: widgets outlive windows, and several windows can show one. */
  widgetId?: string;
  /** The revision shown. */
  revision?: number;
  /** The frame's body (view.html + view.ts). */
  html?: string;
  /** v1 windows only: their data source. */
  source?: MagicSource | null;
  /** v2: the widget has data.ts (the window refreshes and shows freshness). */
  hasData?: boolean;
  refresh?: number;
  /** The person chose `refresh` (Refresh Every): refinements keep it. */
  refreshByUser?: boolean;
  size?: "s" | "m" | "l" | "wide";
  command?: string;
  /** The last data, so the widget draws at once after a restart. */
  lastData?: { data: unknown; at: number } | null;
  health?: MagicHealth;
  /** The status line the last data run reported. */
  status?: MagicStatus | null;
  /** Notification keys the last data run reported; absent until the first run (which notifies nothing). */
  notified?: string[];
  /** A notification not yet seen (cleared by looking at the window: window.clearAttention). */
  attention?: Attention | null;
  /** Notifications from this widget are shown only as its attention marker. */
  muted?: boolean;
  /** A problem with the window itself (the build failed). */
  error?: string;
  /** Problems the last build's checks left (the widget still renders). */
  problems?: string[];
  steps?: MagicStep[];
  /** Earlier requests of this window (the first request, then refinements). */
  history?: string[];
  /** v1: the model's last full answer (context for refinements). */
  answer?: string;
  /** The agent's closing words for the last build. */
  summary?: string;
  /** Values for the manifest's config fields (secrets are kept elsewhere). */
  config?: Record<string, unknown>;
  /** The widget's cmd.state values. */
  kv?: Record<string, unknown>;
  /** Origins the view plays audio/video or shows images from (manifest media). */
  media?: string[];
  /** Media origins the person allowed for this window; the frame's CSP opens only these. */
  mediaAllowed?: string[];
  /** Media origins the person declined (not asked again). */
  mediaDenied?: string[];
}

/** A config field of a widget (its manifest), as the settings pane shows it. */
export interface MagicConfigField {
  key: string;
  title: string;
  type: "string" | "number" | "boolean" | "enum";
  default?: string | number | boolean;
  options?: string[];
  secret?: boolean;
  description?: string;
}

/** A widget's revision (magic.widget). */
export interface MagicRevision {
  n: number;
  at: number;
  prompt: string;
  ok: boolean;
  problems?: string[];
  model?: string;
  /** Path of its screenshot, if any. */
  shot?: string;
}

/** Everything the edit view shows about a widget (magic.widget). */
export interface MagicWidgetInfo {
  dir: string;
  files: string[];
  revisions: MagicRevision[];
  manifest: {
    title: string;
    description?: string;
    refresh: number;
    permissions: { net: string[]; run: string[]; env: string[]; read: string[] };
    config: MagicConfigField[];
  } | null;
  /** Which secret config fields have a value. */
  secrets: Record<string, boolean>;
  /** The working files differ from the latest revision (edited by hand). */
  edited: boolean;
}

/** One render the core asks the app to make offscreen and measure. */
export interface MagicPreviewRequest {
  page: string;
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

/** What widgets' data.ts runs on (magic.runtime). */
export interface MagicRuntime {
  deno: string | null;
  version: string | null;
  /** sandbox-exec works here (else data.ts runs only with CMD_MAGIC_UNSANDBOXED=1). */
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

/** The part of an app theme the widget tokens come from (structurally the renderer's Theme). */
export interface ThemeLike {
  appearance: "dark" | "light";
  colors: { well: string; bgElevated: string; text: string; textDim: string; accent: string; ink: string };
  terminal: { red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string };
}

/** The widget token vocabulary (the Magic system prompt names exactly these). */
export function widgetTokens(t: ThemeLike, fonts: { text?: string; mono?: string } = {}): Record<string, string> {
  const ink = (pct: number) => `color-mix(in srgb, ${t.colors.ink} ${pct}%, transparent)`;
  return {
    "color-scheme": t.appearance,
    "--bg": t.colors.well,
    "--surface": t.colors.bgElevated,
    "--text": t.colors.text,
    "--text-dim": t.colors.textDim,
    "--accent": t.colors.accent,
    "--on-accent": "#fff",
    "--line": ink(t.appearance === "dark" ? 12 : 10),
    "--fill": ink(t.appearance === "dark" ? 7 : 5),
    "--good": t.terminal.green,
    "--warn": t.terminal.yellow,
    "--bad": t.terminal.red,
    "--c1": t.terminal.blue,
    "--c2": t.terminal.green,
    "--c3": t.terminal.yellow,
    "--c4": t.terminal.magenta,
    "--c5": t.terminal.cyan,
    "--c6": t.terminal.red,
    // The app passes the font.text / font.code settings; the defaults are theirs.
    "--font": fonts.text || DEFAULT_SETTINGS["font.text"] || `-apple-system, BlinkMacSystemFont, sans-serif`,
    "--mono": fonts.mono || DEFAULT_SETTINGS["font.code"],
    "--radius": "8px",
  };
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

/**
 * The media origins a widget wants. The header declares them; answers from
 * before the header had `media` are read from the body when it plays audio or
 * video (every https URL in it).
 */
export function requestedMedia(s: Pick<MagicState, "media" | "html">): string[] {
  const list = s.media ?? (s.html && /<audio|<video|new Audio\b/.test(s.html) ? [...s.html.matchAll(/https:\/\/[^\s"'`<>)\\]+/g)].map((m) => m[0]) : []);
  return [...new Set(list.map(mediaOrigin).filter((o): o is string => !!o))].slice(0, 12);
}
