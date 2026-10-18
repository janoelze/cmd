// The packaged app (apps/desktop/dist, from electron-builder) as users run it: a copy in a
// folder of its own, outside the checkout. Run in place, Node finds a package main imports
// but app.asar lacks in the repository's node_modules, a few folders up (resolution walks
// out of the asar), so a broken build passes: 0.32.0 shipped without ws that way. Also
// main's uncaught exceptions, read from an instance's log, for the checks to fail on.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dist = path.resolve(import.meta.dirname, "../apps/desktop/dist");

/** The executable of the packaged app in dist, copied to a temporary folder; `remove` deletes the copy. */
export function packagedApp() {
  if (process.platform === "win32") return { exe: path.join(dist, "win-unpacked", "cmd.exe"), remove() {} };
  // CI's release config makes cmd.app; `pnpm dist` (electron-builder.dev.yml) makes "cmd dev.app".
  const app = fs.existsSync(dist)
    ? fs
        .readdirSync(dist)
        .filter((d) => d.startsWith("mac"))
        .flatMap((d) => [path.join(dist, d, "cmd.app"), path.join(dist, d, "cmd dev.app")])
        .find((p) => fs.existsSync(p))
    : undefined;
  if (!app) throw new Error(`no packaged app in ${dist}; run electron-builder (--dir is enough), or pnpm dist`);
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cmd-app-"));
  // ditto keeps the bundle as it is: symlinks, signatures, the stapled ticket.
  execFileSync("ditto", [app, path.join(dir, path.basename(app))]);
  const name = path.basename(app, ".app");
  return { exe: path.join(dir, path.basename(app), "Contents/MacOS", name), remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** main's uncaught exceptions in an instance's log (installCrashHandlers in protocol log.ts writes them there). */
export function mainCrashes(home) {
  try {
    return fs
      .readFileSync(path.join(home, "logs", "main.log"), "utf8")
      .split("\n")
      .filter((l) => /\[crash\] uncaughtException/.test(l));
  } catch {
    return [];
  }
}
