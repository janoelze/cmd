// What cmd hands to macOS to open (shell.openExternal, shell.openPath), as pure
// functions over the target and where it came from (main/open.ts applies them;
// no Electron here, so they're unit-tested). Web and mail links open silently.
// Text a program printed or a file contains ("content": OSC 8 links, Markdown
// and PDF links, dropped links) can show one thing and point at another, so any
// other URL scheme, and any file that launches something (an app, a script, an
// installer, a link file), is confirmed first in a sheet naming the real target.
// What the person picked from cmd's own menus and buttons ("user") opens as asked.
// Nothing is remembered: every content-derived target is asked about again.

import fs from "node:fs";
import path from "node:path";

/** Who chose the target: the person (menus, buttons, the palette) or text on screen (links in output and files). */
export type OpenFrom = "user" | "content";
export type OpenVerdict = "allow" | "ask" | "deny";

/** Opened without asking, whoever asks. */
const SAFE_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto"]);
/** Never handed to the system: they run code or carry a whole page, and no app should get them. */
const NEVER_SCHEMES: ReadonlySet<string> = new Set(["javascript", "vbscript", "data", "blob"]);

/** Files macOS runs, installs or follows rather than shows, by extension (lower case, no dot) → what opening them does. */
const LAUNCHERS: Readonly<Record<string, LauncherKind>> = {
  app: "app",
  command: "program",
  tool: "program",
  terminal: "terminal",
  webloc: "link",
  inetloc: "link",
  fileloc: "link",
  pkg: "installer",
  mpkg: "installer",
  dmg: "diskImage",
  scpt: "script",
  scptd: "script",
  applescript: "script",
  workflow: "workflow",
};
export type LauncherKind = "app" | "program" | "terminal" | "link" | "installer" | "diskImage" | "script" | "workflow";

/** What a file is on disk (null: not there, opening it fails on its own). */
export interface FileInfo {
  dir: boolean;
  /** st_mode; the x bits make a plain file a program. */
  mode: number;
  /** Its real path (symlinks resolved): what macOS will open. */
  real: string;
}

export function fileInfo(p: string): FileInfo | null {
  try {
    const st = fs.statSync(p);
    return { dir: st.isDirectory(), mode: st.mode, real: fs.realpathSync(p) };
  } catch {
    return null;
  }
}

/** The target as main sees it: a URL with a scheme, or a file (file: URLs are files). */
export type OpenTarget = { type: "url"; url: string; scheme: string } | { type: "file"; path: string; launcher: LauncherKind | null };

const SCHEME = /^([a-z][\w+.-]+):/i;

export const isUrl = (target: string): boolean => SCHEME.test(target) && !/^file:/i.test(target);

/** A file: URL's path, else the target itself. */
function asPath(target: string): string {
  if (!/^file:/i.test(target)) return target;
  try {
    return decodeURIComponent(new URL(target).pathname);
  } catch {
    return target;
  }
}

const ext = (p: string) => path.extname(p).slice(1).toLowerCase();

/** What opening the file would do, if it launches anything: by extension (its own or its real one), or by the x bits. */
export function launcherOf(p: string, info: FileInfo | null): LauncherKind | null {
  const kind = LAUNCHERS[ext(p.replace(/\/+$/, ""))] ?? (info ? LAUNCHERS[ext(info.real)] : undefined);
  if (kind) return kind;
  if (info && !info.dir && (info.mode & 0o111) !== 0) return "program";
  return null;
}

export function classify(target: string, info?: FileInfo | null): OpenTarget {
  const m = SCHEME.exec(target);
  if (m && !/^file:/i.test(target)) return { type: "url", url: target, scheme: m[1]!.toLowerCase() };
  const p = asPath(target);
  return { type: "file", path: p, launcher: launcherOf(p, info === undefined ? fileInfo(p) : info) };
}

/**
 * Open it, ask first, or refuse. `info` is the file as it is on disk (read when
 * not given; tests pass it). javascript: and friends are refused even when asked
 * for from a menu: no app should get them.
 */
export function openPolicy(target: string, from: OpenFrom, info?: FileInfo | null): OpenVerdict {
  const t = classify(target, info);
  if (t.type === "url") {
    if (SAFE_SCHEMES.has(t.scheme)) return "allow";
    if (NEVER_SCHEMES.has(t.scheme)) return "deny";
    return from === "user" ? "allow" : "ask";
  }
  if (!t.path) return "deny";
  return from === "user" || !t.launcher ? "allow" : "ask";
}

/** Long targets are cut in the middle in the sheet's title (the full one is in the detail). */
const cut = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 41)}…${s.slice(-40)}` : s);

/** A .webloc/.inetloc/.fileloc's link, when it's a text plist (binary ones aren't read). */
export function linkInFile(p: string): string | null {
  try {
    if (fs.statSync(p).size > 64 * 1024) return null;
    const m = /<key>URL<\/key>\s*<string>([^<]+)<\/string>/.exec(fs.readFileSync(p, "utf8"));
    return m ? m[1]!.trim().replace(/&amp;/g, "&") : null;
  } catch {
    return null;
  }
}

export interface OpenConfirm {
  message: string;
  detail: string;
  button: string;
}

const TRUST = "Open it only if you trust where it came from.";

/**
 * The sheet for an "ask": it names the real target (the URL itself, the file's
 * real name), never the text the link showed. `appName` is the app macOS opens
 * the scheme with, when it knows one; `link` a link file's target.
 */
export function confirmText(t: OpenTarget, o: { appName?: string; real?: string; link?: string | null } = {}): OpenConfirm {
  if (t.type === "url") {
    const url = cut(t.url);
    return {
      message: o.appName ? `Open ${url} in ${o.appName}?` : `Open ${url}?`,
      detail: `This link is from text in a terminal or a file, not from cmd. ${TRUST}${t.url.length > 120 ? `\n\n${t.url}` : ""}`,
      button: o.appName ? `Open in ${o.appName}` : "Open",
    };
  }
  const name = path.basename((o.real ?? t.path).replace(/\/+$/, ""));
  const where = o.real && o.real !== t.path ? `\n\n${o.real}` : `\n\n${t.path}`;
  const q = `“${cut(name, 80)}”`;
  switch (t.launcher) {
    case "app":
      return { message: `Open the app “${cut(name.replace(/\.app$/i, ""), 80)}”?`, detail: `It runs with your access to this Mac. ${TRUST}${where}`, button: "Open App" };
    case "terminal":
      return { message: `Open ${q} in Terminal?`, detail: `It can run commands. ${TRUST}${where}`, button: "Open in Terminal" };
    case "link":
      return o.link
        ? { message: `Open ${cut(o.link)}?`, detail: `${q} links there. ${TRUST}${where}`, button: "Open" }
        : { message: `Open the link in ${q}?`, detail: `It can point to any app or place. ${TRUST}${where}`, button: "Open" };
    case "installer":
      return { message: `Open ${q} in Installer?`, detail: `It installs software. ${TRUST}${where}`, button: "Open in Installer" };
    case "diskImage":
      return { message: `Open the disk image ${q}?`, detail: `${TRUST}${where}`, button: "Open" };
    case "script":
      return { message: `Open the script ${q}?`, detail: `${TRUST}${where}`, button: "Open" };
    case "workflow":
      return { message: `Open the workflow ${q}?`, detail: `It can run actions on this Mac. ${TRUST}${where}`, button: "Open" };
    default:
      return { message: `Open ${q} in Terminal?`, detail: `It runs as a program. ${TRUST}${where}`, button: "Open in Terminal" };
  }
}
