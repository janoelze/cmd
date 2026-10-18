// Launches the packaged app (apps/desktop/dist, from electron-builder), copied out of the
// checkout as users run it (e2e/packaged-app.mjs), not the source the smoke test drives,
// and checks it works end to end: its window opens, its own bundled core starts and
// answers, a terminal shows the shell's prompt, and main threw nothing. CI runs it after
// packaging, on macOS (and on Windows when that job is on).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { stopCore } from "../scripts/stop-core.mjs";
import { mainCrashes, packagedApp } from "./packaged-app.mjs";

let packaged;
try {
  packaged = packagedApp();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const exe = packaged.exe;
// Short: a Unix socket path may not exceed ~104 characters.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "cmdpk-"));
const check = (cond, msg) => {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
};
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

const app = await electron
  .launch({ executablePath: exe, env: { ...process.env, CMD_HOME: home, CMD_USAGE_URL: "off", CMD_DEV_KEYS: "off", CMD_BACKGROUND: process.env.E2E_VISIBLE ? "" : "1" } })
  .catch((e) => {
    packaged.remove();
    // Electron shows main's load errors in a dialog, not on stderr.
    console.error(`FAILED: the packaged app's main didn't start. A package it imports may be missing from app.asar (bundle it: electron.vite.config.ts).\n${e.message.split("\n")[0]}`);
    process.exit(1);
  });
// What the app printed, for a failure after launch.
let stderr = "";
app.process().stderr?.on("data", (d) => (stderr += d));
try {
  const win = await app.firstWindow();
  await win.waitForSelector(".statusbar .core-status", { timeout: 30_000 });
  check(true, `the packaged app opens its window (${exe})`);
  // The preload gives window.cmd only to the app's own pages (shared/app-url.ts): inside app.asar, the
  // page's file URL and the preload's folder must agree, or the window opens without cmd.
  const page = await win.evaluate(() => ({ url: location.href, cmd: typeof window.cmd?.call }));
  check(page.cmd === "function" && page.url.includes("app.asar/out/renderer/index.html"), `its window gets window.cmd from app.asar (${page.url.replace(/\?.*/, "")})`);
  const hello = await until(() => win.evaluate(() => window.cmd.call("core.hello", {})), 30_000, "the core");
  // core.hello names the app version the core came with `app` (CoreHello, protocol version.ts); `version` was its old name.
  check(!!hello.pid && !!hello.app, `its bundled core starts and answers (${hello.app}, pid ${hello.pid})`);
  const pane = await win.evaluate(() => window.cmd.call("pane.create", {}));
  const text = await until(
    async () => {
      const t = (await win.evaluate((id) => window.cmd.call("pane.read", { paneId: id, lines: 20 }), pane.id)).text;
      return /[>$%#]\s*$/m.test(t) ? t : null;
    },
    30_000,
    "a shell prompt",
  );
  check(true, `a terminal shows the shell's prompt (${text.trim().split("\n").pop()?.trim()})`);
  const crashes = mainCrashes(home);
  check(crashes.length === 0, `main threw nothing${crashes.length ? `:\n${crashes.join("\n")}` : ""}`);
} catch (e) {
  if (stderr.trim()) console.error(`the app's stderr:\n${stderr.trim().split("\n").slice(-30).join("\n")}`);
  throw e;
} finally {
  // The core outlives the app by design: stop it first, then the app has nothing holding it.
  await stopCore(home).catch(() => {});
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 10_000))]);
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
  packaged.remove();
}
console.log("packaged app works");
process.exit(0);
