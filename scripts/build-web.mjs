// Builds the phone's web client (apps/web) into apps/web/dist, which the core
// serves for direct remote access (packages/core/src/remote/webroot.ts).
// stage-runtime.mjs always builds; `pnpm dev` passes --if-missing so a start
// stays cheap (rebuild by hand, `pnpm --filter @cmd/web build`, after editing it).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
if (process.argv.includes("--if-missing") && fs.existsSync(path.join(root, "apps/web/dist/index.html"))) process.exit(0);
execFileSync("pnpm", ["--filter", "@cmd/web", "build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
