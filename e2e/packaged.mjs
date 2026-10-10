// Launches the packaged app (apps/desktop/dist, from electron-builder), not the
// source the smoke test drives, and checks it works end to end: its window
// opens, its own bundled core starts and answers, and a terminal shows the
// shell's prompt. CI runs it after packaging, on macOS (and on Windows when that job is on).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { stopCore } from "../scripts/stop-core.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "apps/desktop/dist");
const exe =
  process.platform === "win32"
    ? path.join(dist, "win-unpacked", "cmd.exe")
    : fs
        .readdirSync(dist)
        .filter((d) => d.startsWith("mac"))
        // CI's release config makes cmd.app; `pnpm dist` (electron-builder.dev.yml) makes "cmd dev.app".
        .flatMap((d) => [path.join(dist, d, "cmd.app/Contents/MacOS/cmd"), path.join(dist, d, "cmd dev.app/Contents/MacOS/cmd dev")])
        .find((p) => fs.existsSync(p));
if (!exe || !fs.existsSync(exe)) {
  console.error(`no packaged app in ${dist}; run electron-builder (--dir is enough)`);
  process.exit(1);
}
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

const app = await electron.launch({ executablePath: exe, env: { ...process.env, CMD_HOME: home, CMD_USAGE_URL: "off", CMD_DEV_KEYS: "off", CMD_BACKGROUND: process.env.E2E_VISIBLE ? "" : "1" } });
try {
  const win = await app.firstWindow();
  await win.waitForSelector(".statusbar .core-status", { timeout: 30_000 });
  check(true, `the packaged app opens its window (${path.relative(root, exe)})`);
  // The preload gives window.cmd only to the app's own pages (shared/app-url.ts): inside app.asar, the
  // page's file URL and the preload's folder must agree, or the window opens without cmd.
  const page = await win.evaluate(() => ({ url: location.href, cmd: typeof window.cmd?.call }));
  check(page.cmd === "function" && page.url.includes("app.asar/out/renderer/index.html"), `its window gets window.cmd from app.asar (${page.url.replace(/\?.*/, "")})`);
  const hello = await until(() => win.evaluate(() => window.cmd.call("core.hello", {})), 30_000, "the core");
  check(!!hello.version, `its bundled core starts and answers (${hello.version}, pid ${hello.pid})`);
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
} finally {
  // The core outlives the app by design: stop it first, then the app has nothing holding it.
  await stopCore(home).catch(() => {});
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 10_000))]);
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
}
console.log("packaged app works");
process.exit(0);
