// Magic windows (docs/12-magic-windows.md): the window state the core stores,
// the progress events it streams, and the widget token vocabulary shared by the
// core (standalone pages, the prompt lab) and the renderer (live frames).

import { DEFAULT_SETTINGS } from "./settings.ts";

/** The model providers Magic windows can use; each has its own API key (secrets.ts) and model setting. */
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

/** A Magic window's state (AppWindow.state of kind "magic"). */
export interface MagicState {
  [key: string]: unknown;
  /** The request, as typed; refinements are appended to `history`. */
  prompt: string;
  phase: "empty" | "working" | "ready" | "error";
  kind?: "widget" | "terminal";
  html?: string;
  source?: MagicSource | null;
  refresh?: number;
  /** The person chose `refresh` (Refresh Every): refinements keep it. */
  refreshByUser?: boolean;
  size?: "s" | "m" | "l" | "wide";
  command?: string;
  /** The last data the source produced, so the widget draws at once after a restart. */
  lastData?: { data: unknown; at: number } | null;
  error?: string;
  steps?: MagicStep[];
  /** Earlier requests of this window (the first request, then refinements). */
  history?: string[];
  /** The model's last full answer: context for refinements. */
  answer?: string;
  /** Origins the view plays audio/video or shows images from (header.media). */
  media?: string[];
  /** Media origins the person allowed for this window; the frame's CSP opens only these. */
  mediaAllowed?: string[];
  /** Media origins the person declined (not asked again). */
  mediaDenied?: string[];
}

/** Progress of a run, streamed as `magic.stream` events (not persisted). */
export type MagicProgress =
  | { type: "step"; step: MagicStep }
  | { type: "header"; title: string; loading: string[]; kind: "widget" | "terminal"; size: string }
  | { type: "body"; html: string }
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
