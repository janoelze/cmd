// Where the phone's web client (apps/web's Vite build) is, for the direct
// listener to serve. The packaged runtime mirrors the repo (stage-runtime.mjs
// copies the build to apps/web/dist next to packages/core), so one relative
// path works in both; `pnpm dev` builds it when missing. CMD_WEB_DIR overrides.

import fs from "node:fs";
import path from "node:path";

/** The folder holding the client's index.html, or null when there's no build. */
export function webClientDir(): string | null {
  const dir = path.resolve(process.env.CMD_WEB_DIR || path.join(import.meta.dirname, "../../../../apps/web/dist"));
  return fs.existsSync(path.join(dir, "index.html")) ? dir : null;
}
