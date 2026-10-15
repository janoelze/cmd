// Frame widgets' pages (docs/56, "The frame surface, for pixels"): cmd-widget://package/<token>/,
// one token per frame the app shows (registerPackageFrame, from the renderer's frame host,
// lib/frames.ts), each naming a package folder and its page: a frame widget's view.html, or a
// Frame element's .html file (API 1.2; a Workbench story's page may come inline instead). The
// page is served after a prelude: the
// theme's variables, the window's state and config, a Frame's data, the API's verbs and topics (from the
// protocol's registry, so the page's `cmd` has each under its name), and the page's `cmd`
// (package-frame/frame.js);
// every other path is a file inside the package folder, never outside it (`..`, encoded or not,
// a dot-file, a link out of the folder: 404). The page is sandboxed in an opaque origin by its
// iframe; the CSP here gives it no network: scripts, styles and fonts from its package, and
// media and images also from the hosts its grant reaches. It never navigates (main/index.ts).

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IpcMain } from "electron";
import { API_TOPICS, API_VERBS, WIDGET_API, WIDGET_API_MINOR } from "@cmd/protocol";
import runtime from "../package-frame/frame.js?raw";
import type { PackageFrameRequest } from "../shared/ipc.ts";

export const PACKAGE_FRAME_BASE = "cmd-widget://package/";

interface Served {
  /** The package folder (a real path); null for an inline page (a story's), which loads nothing else. */
  root: string | null;
  /** The page's path under the token, as its URL says it ("view.html", "pages/meter.html"). */
  page: string;
  /** The page's file, or its markup when inline. */
  file: string | null;
  html: string | null;
  origins: string[];
  init: PackageFrameRequest["init"];
}

const served = new Map<string, Served>();
/** cmd's version, as a page's cmd.env says it (installPackageFrames). */
let version = "0.0.0";
/** Tokens kept at most (a frame that never says it's gone doesn't keep its folder served forever). */
const MAX_SERVED = 200;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  json: "application/json", txt: "text/plain; charset=utf-8", glsl: "text/plain; charset=utf-8", frag: "text/plain; charset=utf-8", vert: "text/plain; charset=utf-8", wasm: "application/wasm",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", mp4: "video/mp4", webm: "video/webm",
};

/** The origins a grant's `net` hosts give the page's media and images: https, plain http only for localhost. */
export function mediaOrigins(net: readonly string[]): string[] {
  const out = new Set<string>();
  for (const h of net) {
    if (h === "*") out.add("https:");
    else if (/^(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/i.test(h)) {
      out.add(`https://${h}`);
      if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(h)) out.add(`http://${h}`);
    }
  }
  return [...out].sort();
}

export function packageCsp(origins: readonly string[]): string {
  const hosts = origins.length ? " " + origins.join(" ") : "";
  return [
    "default-src 'none'",
    "script-src cmd-widget: blob: 'unsafe-inline' 'unsafe-eval'",
    "style-src cmd-widget: 'unsafe-inline'",
    "font-src cmd-widget: data:",
    "connect-src cmd-widget:",
    `img-src cmd-widget: data: blob:${hosts}`,
    `media-src cmd-widget: data: blob:${hosts}`,
    "worker-src blob:",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * The file a path under a token names, inside `root` (a real path): null for anything outside
 * it, a dot-file or dot-folder, or a link that leads out. `rel` is the URL's path after the token.
 */
export function resolveInPackage(root: string, rel: string): string | null {
  const segs: string[] = [];
  for (const raw of rel.split("/")) {
    if (raw === "") continue;
    let s: string;
    try {
      s = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (s.startsWith(".") || /[\\/\0]/.test(s)) return null;
    segs.push(s);
  }
  if (!segs.length) segs.push("view.html");
  const abs = path.join(root, ...segs);
  let real: string;
  try {
    real = fs.realpathSync(abs);
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real.startsWith(root + path.sep) ? real : null;
}

/** A page's first values, as a script can read them (no `</script>` can end it early). */
const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** The theme's variables as a :root rule (names and values that could leave the rule are dropped). */
function rootRule(s: Served): string {
  const vars = Object.entries(s.init.vars ?? {}).filter(([k, v]) => /^--[\w-]+$/.test(k) && typeof v === "string" && !/[;{}<>]/.test(v));
  return `:root{color-scheme:${s.init.appearance};${vars.map(([k, v]) => `${k}:${v}`).join(";")}}`;
}

const BASE = "html,body{margin:0;height:100%}body{font-family:var(--font-ui);font-size:var(--text-base);line-height:1.4;color:var(--text);background:transparent;-webkit-font-smoothing:antialiased}";

function prelude(s: Served): string {
  const api = { verbs: API_VERBS, topics: API_TOPICS, major: WIDGET_API, minor: WIDGET_API_MINOR, version };
  const first = { appearance: s.init.appearance, state: s.init.state ?? {}, config: s.init.config ?? {}, data: s.init.data ?? null, placement: s.init.placement === "sidebar" ? "sidebar" : "board", api };
  return `<!doctype html><html data-appearance="${s.init.appearance}"><head><meta charset="utf-8"><style>${rootRule(s)}${BASE}</style><script>window.__CMD_FRAME__=${json(first)};\n${runtime}</script></head><body>\n`;
}

/** Serve a frame for this package folder and page (view.html unless `page` names another .html file in it), or an inline page: its URL under a new token. */
export function registerPackageFrame(req: PackageFrameRequest): string {
  if (!req || typeof req !== "object") throw new Error("a frame needs a package folder and a page");
  let root: string | null = null;
  let page = "view.html";
  let file: string | null = null;
  let html: string | null = null;
  if (typeof req.html === "string" && req.dir === undefined) {
    html = req.html;
    page = "page.html";
  } else {
    if (typeof req.dir !== "string" || !path.isAbsolute(req.dir)) throw new Error("a frame widget's folder should be an absolute path");
    root = fs.realpathSync(req.dir);
    if (!fs.existsSync(path.join(root, "package.json"))) throw new Error("not a widget package");
    if (req.page !== undefined) {
      if (typeof req.page !== "string" || !/\.html$/i.test(req.page)) throw new Error("a frame's page is an .html file of its package");
      page = req.page.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    }
    file = resolveInPackage(root, page);
    if (!file) throw new Error(`no page ${String(req.page ?? "view.html").slice(0, 120)} in the package`);
  }
  const appearance = req.init?.appearance === "light" ? "light" : "dark";
  const init = { appearance, vars: req.init?.vars ?? {}, state: req.init?.state ?? {}, config: req.init?.config ?? {}, data: req.init?.data ?? null, placement: req.init?.placement === "sidebar" ? ("sidebar" as const) : ("board" as const) } as const;
  while (served.size >= MAX_SERVED) served.delete(served.keys().next().value!);
  const token = randomUUID();
  served.set(token, { root, page, file, html, origins: mediaOrigins(Array.isArray(req.media) ? req.media.filter((h) => typeof h === "string") : []), init });
  return `${PACKAGE_FRAME_BASE}${token}/${page}`;
}

const tokenOf = (url: string): string | null => (url.startsWith(PACKAGE_FRAME_BASE) ? (url.slice(PACKAGE_FRAME_BASE.length).split(/[/?#]/)[0] ?? null) : null);

/** The frame's page itself (a reload), the only place it may navigate. */
export const isPackageFramePage = (url: string): boolean => {
  const t = tokenOf(url);
  const s = t ? served.get(t) : undefined;
  return !!s && url === `${PACKAGE_FRAME_BASE}${t}/${s.page}`;
};

export async function packageFrameResponse(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const [, token = "", ...rest] = url.pathname.split("/");
  const s = served.get(token);
  if (!s) return new Response("not found", { status: 404 });
  const headers = { "content-security-policy": packageCsp(s.origins), "cache-control": "no-store", "x-content-type-options": "nosniff" };
  const rel = rest.join("/");
  if (s.html !== null) return rel === s.page ? new Response(prelude(s) + s.html, { headers: { ...headers, "content-type": TYPES.html! } }) : new Response("not found", { status: 404 });
  const file = s.root ? resolveInPackage(s.root, rel) : null;
  if (!file) return new Response("not found", { status: 404 });
  const ext = path.extname(file).slice(1).toLowerCase();
  const body = await fs.promises.readFile(file);
  if (file === s.file) return new Response(prelude(s) + body.toString("utf8"), { headers: { ...headers, "content-type": TYPES.html! } });
  return new Response(new Uint8Array(body), { headers: { ...headers, "content-type": TYPES[ext] ?? "application/octet-stream" } });
}

/** The renderer's calls: a frame to serve (its URL), and one no view shows any more. `appVersion`: cmd's, for the pages' cmd.env. */
export function installPackageFrames(ipc: IpcMain, appVersion: string): void {
  version = appVersion;
  ipc.handle("package-frame", (_e, req: PackageFrameRequest) => registerPackageFrame(req));
  ipc.on("package-frame-release", (_e, url: unknown) => {
    const t = typeof url === "string" ? tokenOf(url) : null;
    if (t) served.delete(t);
  });
}
