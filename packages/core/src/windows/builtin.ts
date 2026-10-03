// Built-in window types. They use the same registry API a plugin would.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { WindowType, WindowTypes } from "./types.ts";

export const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Accepts "example.com", "localhost:3000", full URLs; rejects anything else. */
export function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return "about:blank";
  if (/^(https?|file|about):/i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(t)) return `https://${t}`;
  throw new Error(`not a URL: ${input}`);
}

export const browserType: WindowType<{ url: string }> = {
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
    return str(patch.url) !== undefined ? { state: { ...state, url: normalizeUrl(str(patch.url)!) } } : { state };
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

export const textType: WindowType<{ path: string }> = {
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
    const file = path.resolve(expandHome(str(input.path) ?? ""));
    if (!fs.statSync(file).isFile()) throw new Error(`not a file: ${file}`);
    return { state: { path: file }, title: path.basename(file) };
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

export function registerBuiltins(types: WindowTypes): void {
  types.register(terminalType);
  types.register(browserType);
  types.register(filesType);
  types.register(textType);
}
