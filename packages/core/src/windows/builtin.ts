// Built-in window types. They use the same registry API a plugin would.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { WindowType, WindowTypes } from "./types.ts";

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
    extensions: ["html", "htm", "xhtml", "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "pdf"],
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
 * sets `path` and drops the draft.
 */
export const textType: WindowType<{ path: string; dir?: string; draft?: string }> = {
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
    return { state: { path: file }, title: path.basename(file) };
  },
  update(state, patch) {
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
 * Magic widgets (docs/12-magic-widgets.md): a request in, a widget or terminal
 * command out. Created empty or with a request; the MagicService fills the state.
 */
export const magicType: WindowType<{ prompt: string; phase: string }> = {
  kind: "magic",
  title: "Magic Widget",
  icon: "sparkles",
  create(input) {
    return { state: { prompt: str(input.prompt) ?? "", phase: "empty" }, title: "Magic Widget" };
  },
};

export function registerBuiltins(types: WindowTypes): void {
  types.register(terminalType);
  types.register(browserType);
  types.register(filesType);
  types.register(textType);
  types.register(markdownType);
  types.register(magicType);
}
