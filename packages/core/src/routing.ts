// Which window suits a path: folder → file browser, web/image/pdf → browser,
// text → text window, anything else → null (the default app should open it).
// The zsh `open` function (shell/zsh) mirrors these rules.

import fs from "node:fs";
import path from "node:path";

export type Route = "files" | "browser" | "text";

const BROWSER_EXT = new Set(["html", "htm", "xhtml", "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "pdf"]);
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "rst", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "conf", "cfg", "env",
  "xml", "plist", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "sh", "zsh", "bash", "fish", "py", "rb", "go", "rs",
  "swift", "zig", "c", "h", "cc", "cpp", "hpp", "m", "mm", "java", "kt", "lua", "sql", "graphql", "proto", "dockerfile",
  "makefile", "gitignore", "editorconfig", "lock", "diff", "patch", "tex", "vue", "svelte",
]);
/** Text windows open files up to this size; larger files go to the default app. */
export const TEXT_MAX_BYTES = 10 * 1024 * 1024;

/** No NUL bytes in the first 8 KB: treat as text. */
export function looksLikeText(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return !buf.subarray(0, n).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function routeFor(p: string): Route | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return null;
  }
  if (st.isDirectory()) return "files";
  if (!st.isFile()) return null;
  const base = path.basename(p).toLowerCase();
  const ext = base.includes(".") ? base.split(".").pop()! : base; // Makefile, Dockerfile
  if (BROWSER_EXT.has(ext)) return "browser";
  if (st.size > TEXT_MAX_BYTES) return null;
  if (TEXT_EXT.has(ext) || st.size === 0) return "text";
  return looksLikeText(p) ? "text" : null;
}
