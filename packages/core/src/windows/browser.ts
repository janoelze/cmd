// Browser windows and their inspectors (docs/59): what a browser window opens and keeps (its
// address, device size, whether its DevTools show inside), and the Inspector window type.

import { pathToFileURL } from "node:url";
import os from "node:os";
import type { WindowType } from "./types.ts";
import { expandHome } from "./builtin.ts";

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

/**
 * `device`: the emulated device size the page is shown at (an id from the renderer's devices.ts), else the window's size.
 * `inspector`: "inside" while the page's DevTools show in the window beside it (docs/59; in a window of their own: inspectorType).
 */
export const browserType: WindowType<{ url: string; device?: string; inspector?: "inside" }> = {
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
    if ("inspector" in patch) {
      if (patch.inspector === "inside") next.inspector = "inside";
      else delete next.inspector;
    }
    return { state: next };
  },
};

/**
 * A browser window's DevTools in a window of their own (docs/59), beside it on the board. `for`: the browser
 * window; the app connects the two (main/inspector.ts). Opened from a browser window only: no `open` routing.
 */
export const inspectorType: WindowType<{ for: string }> = {
  kind: "inspector",
  title: "Inspector",
  icon: "code",
  create(input) {
    const of = str(input.for);
    if (!of) throw new Error("an inspector needs the browser window it inspects");
    return { state: { for: of }, title: "Inspector" };
  },
};
