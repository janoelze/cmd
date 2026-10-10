// `pnpm build`, unless the app's build (apps/desktop/out) is newer than every file it could
// come from: those git knows or would add under apps/desktop and packages, and the lockfile.
// The e2e scripts start with it, so a rerun with nothing changed skips the build's seconds.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "apps/desktop/out");

const oldestOut = (() => {
  let t = Infinity;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else t = Math.min(t, fs.statSync(p).mtimeMs);
    }
  };
  try {
    walk(out);
  } catch {
    return 0;
  }
  return t === Infinity ? 0 : t;
})();

const sources = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "apps/desktop", "packages", "pnpm-lock.yaml"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 })
  .split("\n")
  .filter((f) => f && !f.startsWith("apps/desktop/out/"));
const newer = sources.find((f) => {
  try {
    return fs.statSync(path.join(root, f)).mtimeMs > oldestOut;
  } catch {
    return false; // deleted, not yet staged
  }
});

if (newer) {
  console.log(`building (${oldestOut ? `${newer} changed` : "no build yet"})`);
  execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
} else console.log("build is up to date");
