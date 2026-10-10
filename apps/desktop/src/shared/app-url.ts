// The app's own pages: renderer/<page>.html as files (built and packaged apps)
// or on the dev server (pnpm dev, ELECTRON_RENDERER_URL). Main keeps app and
// utility windows on them (web-session.ts) and the preload gives window.cmd only
// to them, since window.cmd reaches a shell; anything else (a link, a dropped
// URL, a form in a rendered Markdown file) must never load in such a window.

import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AppPages {
  /** The folder of the built pages, out/renderer. */
  rendererDir: string;
  /** The dev server's URL, in pnpm dev. */
  devUrl?: string;
}

export function allowedAppUrl(url: string, pages: AppPages): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (pages.devUrl && (u.protocol === "http:" || u.protocol === "https:")) {
    try {
      return u.origin === new URL(pages.devUrl).origin;
    } catch {
      return false;
    }
  }
  if (u.protocol !== "file:" || u.host) return false;
  try {
    const file = fileURLToPath(u);
    return path.dirname(file) === path.resolve(pages.rendererDir) && file.endsWith(".html");
  } catch {
    return false; // an encoded "/" in the path
  }
}
