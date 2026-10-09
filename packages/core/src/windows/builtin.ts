// Built-in window types. They use the same registry API a plugin would.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { WindowType, WindowTypes } from "./types.ts";
import { databaseOf, isSqliteFile } from "../sqlite/service.ts";

export const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Accepts "example.com", "localhost:3000", full URLs, file paths (~ expanded); rejects anything else. */
export function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return "about:blank";
  // file://~/x: Chromium would take "~" for a host and abort the load.
  const home = t.match(/^file:(?:\/\/)?~(?=$|\/)/i);
  if (home) return pathToFileURL(os.homedir()).href + t.slice(home[0].length);
  if (/^(~|\/)/.test(t)) return pathToFileURL(expandHome(t)).href;
  if (/^(https?|file|about):/i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(t)) return `https://${t}`;
  throw new Error(`not a URL: ${input}`);
}

/** `device`: the emulated device size the page is shown at (an id from the renderer's devices.ts), else the window's size. */
export const browserType: WindowType<{ url: string; device?: string }> = {
  kind: "browser",
  title: "Browser",
  icon: "globe",
  opens: {
    schemes: ["http", "https", "file"],
    extensions: ["html", "htm", "xhtml", "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"],
  },
  fromTarget: (t) => ({ url: t.type === "url" ? t.url : pathToFileURL(t.path).href }),
  create(input) {
    const url = normalizeUrl(str(input.url) ?? "");
    return { state: { url }, title: url === "about:blank" ? "New Tab" : url };
  },
  update(state, patch) {
    const next = { ...state };
    if (str(patch.url) !== undefined) next.url = normalizeUrl(str(patch.url)!);
    if ("device" in patch) {
      if (str(patch.device)) next.device = str(patch.device);
      else delete next.device; // null or "": back to the window's size
    }
    return { state: next };
  },
};

export const filesType: WindowType<{ path: string }> = {
  kind: "files",
  title: "Files",
  icon: "folder",
  opens: { folders: true },
  fromTarget: (t) => ({ path: t.type === "path" ? t.path : "" }),
  create(input) {
    const dir = path.resolve(expandHome(str(input.path) ?? str(input.cwd) ?? os.homedir()));
    if (!fs.statSync(dir).isDirectory()) throw new Error(`not a folder: ${dir}`);
    return { state: { path: dir }, title: path.basename(dir) || dir };
  },
  update(state, patch) {
    const p = str(patch.path);
    if (p === undefined) return { state };
    const dir = path.resolve(expandHome(p));
    return { state: { ...state, path: dir }, title: path.basename(dir) || dir };
  },
};

/**
 * A text editor for one file, or an untitled buffer (no path): `dir` is where
 * Save asks first, `draft` the unsaved text, kept so it survives reloads. Saving
 * sets `path` and drops the draft. `reveal` asks the editor to show a line (a
 * search result): its line, column and the text to select; `at` makes each ask new.
 */
type Reveal = { line: number; column: number | null; text: string | null; at: number };
const revealOf = (v: unknown): Reveal | undefined => {
  const r = v as Partial<Reveal> | null | undefined;
  return r && typeof r.line === "number" ? { line: r.line, column: typeof r.column === "number" ? r.column : null, text: typeof r.text === "string" ? r.text : null, at: typeof r.at === "number" ? r.at : Date.now() } : undefined;
};
export const textType: WindowType<{ path: string; dir?: string; draft?: string; reveal?: Reveal }> = {
  kind: "text",
  title: "Text",
  icon: "doc.text",
  opens: {
    text: true,
    extensions: [
      "txt", "md", "markdown", "rst", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "conf", "cfg", "env",
      "xml", "plist", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "sh", "zsh", "bash", "fish", "py", "rb", "go", "rs",
      "swift", "zig", "c", "h", "cc", "cpp", "hpp", "m", "mm", "java", "kt", "lua", "sql", "graphql", "proto", "dockerfile",
      "makefile", "gitignore", "editorconfig", "lock", "diff", "patch", "tex", "vue", "svelte",
    ],
  },
  fromTarget: (t) => ({ path: t.type === "path" ? t.path : "" }),
  create(input) {
    const p = str(input.path);
    if (!p) return { state: { path: "", dir: path.resolve(expandHome(str(input.cwd) ?? os.homedir())), draft: str(input.draft) ?? "" }, title: "Untitled" };
    const file = path.resolve(expandHome(p));
    if (!fs.statSync(file).isFile()) throw new Error(`not a file: ${file}`);
    const reveal = revealOf(input.reveal);
    return { state: reveal ? { path: file, reveal } : { path: file }, title: path.basename(file) };
  },
  update(state, patch) {
    const reveal = revealOf(patch.reveal);
    if (reveal && state.path) return { state: { ...state, reveal } };
    const p = str(patch.path);
    if (p) {
      const file = path.resolve(expandHome(p));
      return { state: { path: file }, title: path.basename(file) };
    }
    const draft = str(patch.draft);
    return { state: draft !== undefined && !state.path ? { ...state, draft } : state };
  },
};

/** Rendered Markdown with live reload; ⌘E switches the same window to the text editor. */
export const markdownType: WindowType<{ path: string }> = {
  kind: "markdown",
  title: "Markdown",
  icon: "doc.richtext",
  // Same specificity as text's extension match; priority makes .md open here.
  opens: { extensions: ["md", "markdown", "mdx"], priority: 10 },
  fromTarget: (t) => ({ path: t.type === "path" ? t.path : "" }),
  create(input) {
    const file = path.resolve(expandHome(str(input.path) ?? ""));
    if (!fs.statSync(file).isFile()) throw new Error(`not a file: ${file}`);
    return { state: { path: file }, title: path.basename(file) };
  },
  update(state, patch) {
    const p = str(patch.path);
    if (p === undefined) return { state };
    const file = path.resolve(expandHome(p));
    return { state: { ...state, path: file }, title: path.basename(file) };
  },
};

/**
 * A JSON or JSON Lines file as a tree, live; ⌘E switches the same window to the
 * text editor. `reveal` (from the editor's ⌘E): the line whose value to select.
 */
export const jsonType: WindowType<{ path: string; reveal?: { line: number; at: number } }> = {
  kind: "json",
  title: "JSON",
  icon: "curlybraces",
  // Same specificity as text's extension match; priority makes these open here.
  opens: { extensions: ["json", "jsonc", "jsonl", "ndjson", "geojson", "har", "webmanifest"], priority: 10 },
  fromTarget: (t) => ({ path: t.type === "path" ? t.path : "" }),
  create(input) {
    const file = path.resolve(expandHome(str(input.path) ?? ""));
    if (!fs.statSync(file).isFile()) throw new Error(`not a file: ${file}`);
    return { state: { path: file }, title: path.basename(file) };
  },
  update(state, patch) {
    const r = patch.reveal as { line?: unknown } | null | undefined;
    if (r && typeof r.line === "number") return { state: { ...state, reveal: { line: r.line, at: Date.now() } } };
    const p = str(patch.path);
    if (p === undefined) return { state };
    const file = path.resolve(expandHome(p));
    return { state: { path: file }, title: path.basename(file) };
  },
};

/** How a PDF is zoomed: to the window's width, its whole page, its real size, or a factor (1 = 100%). */
export type PdfScale = "page-width" | "page-fit" | "auto" | number;
const pdfScale = (v: unknown): PdfScale | undefined =>
  v === "page-width" || v === "page-fit" || v === "auto" ? v : typeof v === "number" && v >= 0.1 && v <= 10 ? v : undefined;

/**
 * A PDF (pdf.js in the renderer, components/PdfView.tsx), reloaded when the file
 * changes. `page` (1-based) and `scale` are where you were; `sidebar` shows
 * pages or the outline; `dark` inverts the pages for dark themes.
 */
export interface PdfState extends Record<string, unknown> {
  path: string;
  page?: number;
  scale?: PdfScale;
  sidebar?: "pages" | "outline" | null;
  dark?: boolean;
}

export const pdfType: WindowType<PdfState> = {
  kind: "pdf",
  title: "PDF",
  icon: "doc.richtext",
  // Before the browser, which used to show PDFs.
  opens: { extensions: ["pdf"], priority: 10 },
  fromTarget: (t) => ({ path: t.type === "path" ? t.path : "" }),
  create(input) {
    const file = path.resolve(expandHome(str(input.path) ?? ""));
    if (!fs.statSync(file).isFile()) throw new Error(`not a file: ${file}`);
    const page = typeof input.page === "number" && input.page >= 1 ? Math.floor(input.page) : undefined;
    return { state: { path: file, ...(page ? { page } : {}) }, title: path.basename(file) };
  },
  update(state, patch) {
    const next: PdfState = { ...state };
    const p = str(patch.path);
    if (p !== undefined) next.path = path.resolve(expandHome(p));
    if (typeof patch.page === "number" && patch.page >= 1) next.page = Math.floor(patch.page);
    const scale = pdfScale(patch.scale);
    if (scale !== undefined) next.scale = scale;
    if (patch.sidebar === "pages" || patch.sidebar === "outline" || patch.sidebar === null) next.sidebar = patch.sidebar;
    if (typeof patch.dark === "boolean") next.dark = patch.dark;
    return { state: next, title: path.basename(next.path) };
  },
};

/**
 * Terminals are backed by panes: the window manager creates and closes the pane;
 * this entry only describes the type (state: { paneId }).
 */
export const terminalType: WindowType<{ paneId: string }> = {
  kind: "terminal",
  title: "Terminal",
  icon: "terminal",
  create() {
    throw new Error("terminal windows are created by the pane manager");
  },
};

/**
 * Magic widgets (docs/12-magic-widgets.md, docs/16-widgets.md): a request in, a
 * widget or terminal command out. Created empty, with a request, or showing a
 * widget from the library (`widgetId`); the MagicService fills the state.
 */
export const magicType: WindowType<{ prompt: string; phase: string; widgetId?: string }> = {
  kind: "magic",
  title: "Magic Widget",
  icon: "sparkles",
  role: "widget",
  description: "Describe what you want to see, and watch it being made.",
  create(input) {
    const widgetId = str(input.widgetId);
    if (widgetId !== undefined && !/^[\w-]+$/.test(widgetId)) throw new Error(`bad widget id: ${widgetId}`);
    return { state: { prompt: str(input.prompt) ?? "", phase: "empty", ...(widgetId ? { widgetId } : {}) }, title: "Magic Widget" };
  },
};

/**
 * A SQLite database as its tables (docs/36-sqlite-viewer.md): browse rows, see
 * the schema, run a read-only statement. Opening a `-wal`, `-shm` or `-journal`
 * sidecar opens the database it belongs to. `table`: the one shown; `tab`: what
 * of it (content, structure, query); `sql`: the query tab's draft.
 */
export const sqliteType: WindowType<{ path: string; table?: string; tab?: string; sql?: string }> = {
  kind: "sqlite",
  title: "SQLite",
  icon: "cylinder.split.1x2",
  opens: { extensions: ["sqlite", "sqlite3", "db", "db3", "sqlite-wal", "sqlite-shm", "db-wal", "db-shm"], priority: 10 },
  fromTarget: (t) => ({ path: t.type === "path" ? t.path : "" }),
  create(input) {
    const file = databaseOf(path.resolve(expandHome(str(input.path) ?? "")));
    if (!fs.statSync(file).isFile()) throw new Error(`not a file: ${file}`);
    if (!isSqliteFile(file)) throw new Error(`${path.basename(file)} isn't a SQLite database.`);
    const table = str(input.table);
    return { state: { path: file, ...(table ? { table } : {}) }, title: path.basename(file) };
  },
  update(state, patch) {
    const next = { ...state };
    const p = str(patch.path);
    if (p !== undefined) next.path = path.resolve(expandHome(p));
    if (patch.table === null) delete next.table;
    else if (typeof patch.table === "string") next.table = patch.table;
    if (patch.tab === "content" || patch.tab === "structure" || patch.tab === "query") next.tab = patch.tab;
    if (typeof patch.sql === "string") next.sql = patch.sql.slice(0, 100_000);
    return { state: next, title: path.basename(next.path) };
  },
};

/**
 * Built-in widgets (docs/16-widgets.md): native views over what the core
 * already knows, offered in the Widget Library, not the File menu.
 */
export const agentsType: WindowType<{ scope: "space" | "all" }> = {
  kind: "agents",
  title: "Agent Activity",
  icon: "person.2",
  role: "widget",
  description: "Every agent at a glance: who is working, who waits for you, what just finished.",
  create(input) {
    return { state: { scope: input.scope === "all" ? "all" : "space" }, title: "Agent Activity" };
  },
  update(state, patch) {
    return { state: patch.scope === "all" || patch.scope === "space" ? { ...state, scope: patch.scope } : state };
  },
};

type Scope = "space" | "all";
const scopeOf = (v: unknown, fallback: Scope = "space"): Scope => (v === "all" || v === "space" ? v : fallback);

/** A built-in widget showing its Space's things or every Space's, plus on/off `flags` (e.g. Failed Only). */
function scopedWidget(kind: string, title: string, icon: string, description: string, flags: string[] = []): WindowType<{ scope: Scope } & Record<string, unknown>> {
  return {
    kind,
    title,
    icon,
    role: "widget",
    description,
    create(input) {
      return { state: { scope: scopeOf(input.scope) }, title };
    },
    update(state, patch) {
      const next: { scope: Scope } & Record<string, unknown> = { ...state, scope: scopeOf(patch.scope, state.scope) };
      for (const f of flags) if (typeof patch[f] === "boolean") next[f] = patch[f];
      return { state: next };
    },
  };
}

export const commandsType = scopedWidget("commands", "Commands", "terminal", "Every command your terminals ran: how long it took and whether it worked.", ["failedOnly"]);
export const notificationsType = scopedWidget("notifications", "Notifications", "bell", "The notifications cmd sent, including the ones you missed.");
export const journalType = scopedWidget("journal", "Journal", "book", "What happened, a few lines a day: releases, features, fixes and investigations, from your agents, terminals and git.");
export const resourcesType = scopedWidget("resources", "Resources", "gauge.with.dots.needle.33percent", "What each terminal uses: CPU and memory of everything running in it.");

/**
 * Event Stream, a developer widget: every event cmd records, as it's recorded
 * (docs/28). `hidden`: classes left out (data classes, "transcripts", …);
 * `paused`: new events wait until it goes on.
 */
export const eventsType: WindowType<{ hidden: string[]; paused: boolean }> = {
  kind: "events",
  title: "Event Stream",
  icon: "waveform.path.ecg",
  role: "widget",
  tags: ["developer"],
  description: "Everything cmd records, as it happens: to see what it captures while you work.",
  create(input) {
    return { state: { hidden: strings(input.hidden), paused: false }, title: "Event Stream" };
  },
  update(state, patch) {
    const next = { ...state };
    if (Array.isArray(patch.hidden)) next.hidden = strings(patch.hidden);
    if (typeof patch.paused === "boolean") next.paused = patch.paused;
    return { state: next };
  },
};
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : []);

/** Seconds. 0 h 0 m 1 s to 24 h. */
const clampDuration = (n: unknown, fallback: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(86_400, Math.max(1, Math.round(n))) : fallback);

/** "25 min", "1 h 30 min", "45 s". */
export function durationLabel(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h ? `${h} h` : "", m ? `${m} min` : "", sec && !h ? `${sec} s` : ""].filter(Boolean).join(" ") || "0 s";
}

/**
 * A countdown. `duration` (s) is what it counts from; running, `endsAt` is when
 * it ends; paused, `left` (s) is what is left; `rang` is when it last ended. The
 * core rings it (timers.ts), so it ends on time in any Space, app open or not.
 */
export interface TimerState extends Record<string, unknown> {
  duration: number;
  endsAt: number | null;
  left: number | null;
  rang: number | null;
}

const timerTitle = (s: TimerState) => `Timer · ${durationLabel(s.duration)}`;

export const timerType: WindowType<TimerState> = {
  kind: "timer",
  title: "Timer",
  icon: "timer",
  role: "widget",
  description: "A countdown that tells you when it's done.",
  create(input) {
    const state: TimerState = { duration: clampDuration(input.duration, 25 * 60), endsAt: null, left: null, rang: null };
    return { state, title: timerTitle(state) };
  },
  /** Patches: { duration } sets it and stops; { action: "start" | "pause" | "reset" | "ring" }. */
  update(state, patch, now = Date.now()) {
    let s: TimerState = { ...state };
    if (patch.duration !== undefined) s = { duration: clampDuration(patch.duration, s.duration), endsAt: null, left: null, rang: null };
    switch (patch.action) {
      case "start":
        if (s.endsAt === null) s = { ...s, endsAt: now + (s.left ?? s.duration) * 1000, left: null, rang: null };
        break;
      case "pause":
        if (s.endsAt !== null) s = { ...s, left: Math.max(1, Math.ceil((s.endsAt - now) / 1000)), endsAt: null };
        break;
      case "reset":
        s = { ...s, endsAt: null, left: null, rang: null };
        break;
      case "ring":
        if (s.endsAt !== null && s.endsAt <= now + 1000) s = { ...s, endsAt: null, left: null, rang: now };
        break;
    }
    return { state: s, title: timerTitle(s) };
  },
};

/**
 * MilkDrop presets (butterchurn) moving to sound. `preset` is the one showing
 * (null: a random one), `source` what it listens to ("none", "mic"; Live Code
 * windows later), `cycle` the seconds between presets (0: stay on one).
 */
export interface VisualizerState extends Record<string, unknown> {
  preset: string | null;
  source: string;
  cycle: number;
}

const clampCycle = (n: unknown, fallback: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(3600, Math.max(0, Math.round(n))) : fallback);

export const visualizerType: WindowType<VisualizerState> = {
  kind: "visualizer",
  title: "Visualizer",
  icon: "waveform",
  role: "widget",
  description: "MilkDrop visuals that move to the music.",
  create(input) {
    const state: VisualizerState = {
      preset: typeof input.preset === "string" ? input.preset : null,
      source: typeof input.source === "string" ? input.source : "none",
      cycle: clampCycle(input.cycle, 30),
    };
    return { state, title: "Visualizer" };
  },
  /** Patches: { preset }, { source }, { cycle }. */
  update(state, patch) {
    const s: VisualizerState = { ...state };
    if (patch.preset === null || typeof patch.preset === "string") s.preset = patch.preset;
    if (typeof patch.source === "string") s.source = patch.source;
    if (patch.cycle !== undefined) s.cycle = clampCycle(patch.cycle, s.cycle);
    return { state: s };
  },
};

/** What changed in a repository, under a folder (default: the Space's root), as it changes. */
export const diffType: WindowType<{ path: string }> = {
  kind: "diff",
  title: "Live Diff",
  icon: "plusminus",
  role: "widget",
  description: "The uncommitted changes in a folder's repository, updated as files change.",
  create(input) {
    const dir = path.resolve(expandHome(str(input.path) ?? str(input.cwd) ?? os.homedir()));
    if (!fs.statSync(dir).isDirectory()) throw new Error(`not a folder: ${dir}`);
    return { state: { path: dir }, title: `Changes · ${path.basename(dir) || dir}` };
  },
  update(state, patch) {
    const p = str(patch.path);
    if (p === undefined) return { state };
    const dir = path.resolve(expandHome(p));
    if (!fs.statSync(dir).isDirectory()) throw new Error(`not a folder: ${dir}`);
    return { state: { ...state, path: dir }, title: `Changes · ${path.basename(dir) || dir}` };
  },
};

/** A YouTube video and/or playlist, and where to start (seconds). */
export type YouTubeRef = {
  video?: string;
  list?: string;
  start?: number;
};

const VIDEO_ID = /^[\w-]{11}$/;

/** "90", "90s", "1m30s", "1h2m3s" → seconds. */
function seconds(t: string | null): number | undefined {
  if (!t) return undefined;
  if (/^\d+$/.test(t)) return Number(t) || undefined;
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) || undefined;
}

/** A video id, a youtube.com / youtu.be / youtube-nocookie.com link, or an <iframe> embed code; null if none of those. */
export function parseYouTube(input: string): YouTubeRef | null {
  let t = input.trim();
  const src = t.match(/<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
  if (src) t = src[1]!.replace(/&amp;/g, "&");
  if (VIDEO_ID.test(t)) return { video: t };
  if (t.startsWith("//")) t = `https:${t}`;
  else if (!/^https?:/i.test(t)) t = `https://${t}`;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  let video: string | undefined;
  if (host === "youtu.be") video = parts[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (parts[0] === "watch") video = u.searchParams.get("v") ?? undefined;
    else if (["embed", "shorts", "live", "v", "e"].includes(parts[0] ?? "")) video = parts[1];
    else if (parts[0] !== "playlist") return null;
  } else return null;
  if (video === "videoseries") video = undefined;
  const ref: YouTubeRef = {};
  if (video && VIDEO_ID.test(video)) ref.video = video;
  const list = u.searchParams.get("list");
  if (list && /^[\w-]+$/.test(list)) ref.list = list;
  const start = seconds(u.searchParams.get("t") ?? u.searchParams.get("start"));
  if (start && ref.video) ref.start = start;
  return ref.video || ref.list ? ref : null;
}

/**
 * A YouTube player filling the window. Created empty (the view asks for a link)
 * or with `input`. The video covers the window, cropped (the default), or with `fill: false` is letterboxed.
 */
export const youtubeType: WindowType<YouTubeRef & { fill?: boolean }> = {
  kind: "youtube",
  title: "YouTube",
  icon: "play.rectangle",
  role: "widget",
  description: "Paste a YouTube link, video id or embed code and watch it here.",
  create(input) {
    const raw = str(input.input);
    const fill = input.fill === false ? { fill: false } : {};
    if (!raw) return { state: fill, title: "YouTube" };
    const ref = parseYouTube(raw);
    if (!ref) throw new Error(`not a YouTube link: ${raw}`);
    return { state: { ...ref, ...fill }, title: "YouTube" };
  },
  update(state, patch) {
    const fill = typeof patch.fill === "boolean" ? patch.fill : state.fill;
    const keep = fill === false ? { fill: false } : {};
    if (patch.input === null) return { state: keep, title: "YouTube" };
    const raw = str(patch.input);
    if (raw === undefined) return { state: { video: state.video, list: state.list, start: state.start, ...keep } };
    const ref = parseYouTube(raw);
    if (!ref) throw new Error(`not a YouTube link: ${raw}`);
    return { state: { ...ref, ...keep }, title: "YouTube" };
  },
};

/**
 * The Navigator (docs/21-sidebars.md): what the app's sidebar used to be, as a
 * widget. Search, then the Space's agents, windows and widgets and recent
 * sessions; docked left in every Space by default. Its data is the renderer's.
 */
export const navigatorType: WindowType<Record<string, never>> = {
  kind: "navigator",
  title: "Navigator",
  icon: "sidebar.left",
  role: "widget",
  description: "Search, and everything open in this Space: agents, windows, widgets and recent sessions.",
  create() {
    return { state: {}, title: "Navigator" };
  },
};

export function registerBuiltins(types: WindowTypes): void {
  types.register(terminalType);
  types.register(browserType);
  types.register(filesType);
  types.register(textType);
  types.register(markdownType);
  types.register(jsonType);
  types.register(pdfType);
  types.register(sqliteType);
  types.register(magicType);
  types.register(agentsType);
  types.register(diffType);
  types.register(youtubeType);
  types.register(navigatorType);
  types.register(commandsType);
  types.register(notificationsType);
  types.register(journalType);
  types.register(resourcesType);
  types.register(eventsType);
  types.register(timerType);
  types.register(visualizerType);
}
