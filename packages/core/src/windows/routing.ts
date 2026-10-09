// Turning what someone wants to open (a path or URL) into an OpenTarget that the
// window type registry resolves (types.ts). The zsh `open` function gets the
// same rules from the registry via environment variables (see shellOpenEnv).

import fs from "node:fs";
import path from "node:path";
import type { OpenTarget, WindowTypes } from "./types.ts";
import { expandHome } from "./builtin.ts";

/** Text windows open files up to this size; larger files go to the default app. */
export const TEXT_MAX_BYTES = 10 * 1024 * 1024;

/** Small enough and no NUL bytes in the first 8 KB: treat as text. */
export function looksLikeText(file: string, size: number): boolean {
  if (size > TEXT_MAX_BYTES) return false;
  if (size === 0) return true;
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

/** Extension used for matching: lowercase, no dot; bare names (Makefile) match themselves. */
export function extOf(p: string): string {
  const base = path.basename(p).toLowerCase();
  return base.includes(".") ? base.split(".").pop()! : base;
}

/**
 * Folders macOS shows as one item (apps, bundles, documents): `open` hands them to
 * the system (launches the app) instead of browsing them in a files window.
 */
export const PACKAGE_EXTENSIONS = ["app", "appex", "bundle", "kext", "plugin", "prefpane", "qlgenerator", "saver", "xpc", "pkg", "mpkg", "rtfd", "pages", "numbers", "key", "photoslibrary", "xcarchive", "xcodeproj", "xcworkspace", "playground", "scptd", "workflow"];

/** A folder macOS treats as a single item. */
export function isPackage(p: string): boolean {
  return PACKAGE_EXTENSIONS.includes(extOf(p));
}

/** null when the path doesn't exist, isn't a file/folder, or is a package (the default app's). */
export function targetFor(input: string): OpenTarget | null {
  const m = /^([a-z][\w+.-]*):/i.exec(input);
  if (m && !/^[a-z]:[\\/]/i.test(input) && m[1]!.length > 1) {
    return { type: "url", url: input, scheme: m[1]!.toLowerCase() };
  }
  const abs = path.resolve(expandHome(input));
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isDirectory() && !st.isFile()) return null;
  if (st.isDirectory() && isPackage(abs)) return null;
  return {
    type: "path",
    path: abs,
    isDir: st.isDirectory(),
    ext: extOf(abs),
    looksText: () => looksLikeText(abs, st.size),
  };
}

/** The open rules as environment variables for the zsh integration. */
export function shellOpenEnv(types: WindowTypes, overrides: Record<string, string>): Record<string, string> {
  const exts = new Set<string>(Object.keys(overrides));
  let folders = false;
  let text = false;
  for (const t of types.all()) {
    for (const e of t.opens?.extensions ?? []) exts.add(e);
    folders ||= !!t.opens?.folders;
    text ||= !!t.opens?.text;
  }
  return {
    CMD_OPEN_EXTS: [...exts].sort().join(" "),
    CMD_OPEN_HANDLES_FOLDERS: folders ? "1" : "0",
    CMD_OPEN_HANDLES_TEXT: text ? "1" : "0",
    CMD_OPEN_PACKAGES: PACKAGE_EXTENSIONS.join(" "),
  };
}
