// Experiment 2: a few seconds of ScreenCaptureKit streaming of cmd's window at
// 60 fps while a native menu opens and closes and a terminal types. No pointer
// movement. usage: node experiments/record.mjs <out-dir>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright";
import { Helper } from "../src/helper.ts";

const out = path.resolve(process.argv[2]);
const root = path.resolve(import.meta.dirname, "../../..");
const home = path.join(root, ".cmd-dev", "tour-exp");
fs.rmSync(home, { recursive: true, force: true });
for (const d of ["ui", "home", "transcripts"]) fs.mkdirSync(path.join(home, d), { recursive: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(home, "ui", "onboarding.json"), JSON.stringify({ seen: ["welcome", "ai"] }));

const helper = Helper.start();
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const app = await electron.launch({
  executablePath: require("electron"),
  args: [path.join(root, "apps/desktop")],
  env: { ...process.env, HOME: path.join(home, "home"), CMD_HOME: home, CMD_TRANSCRIPTS_HOME: path.join(home, "transcripts"), CMD_USAGE_URL: "off", CMD_NO_SANDBOX: "1", CMD_BACKGROUND: "" },
});
const marks = [];
const mark = async (name) => marks.push({ name, t: await helper.now() });
try {
  const win = await app.firstWindow();
  await win.waitForSelector(".statusbar .core-status");
  const bounds = await app.evaluate(({ BrowserWindow, app }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setBounds({ x: 160, y: 120, width: 1280, height: 800 });
    app.focus({ steal: true });
    w.focus();
    return w.getBounds();
  });
  await win.waitForTimeout(500);
  const start = await helper.call("record-start", { pid: app.process().pid, out: path.join(out, "raw.mov"), rect: [bounds.x, bounds.y, bounds.width, bounds.height] });
  console.log("recording", start);
  await win.waitForTimeout(600);
  await mark("new terminal");
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("file.newTerminal")?.click());
  await win.waitForTimeout(1200);
  await mark("menu open");
  await app.evaluate(({ Menu, BrowserWindow }) => {
    globalThis.__menu = Menu.buildFromTemplate([{ label: "Copy" }, { label: "Paste" }, { type: "separator" }, { label: "Split Right" }, { label: "Close" }]);
    globalThis.__menu.popup({ window: BrowserWindow.getAllWindows()[0], x: 400, y: 300 });
  });
  await win.waitForTimeout(1200);
  await mark("menu closed");
  await app.evaluate(() => globalThis.__menu.closePopup());
  await win.waitForTimeout(300);
  await mark("typing");
  await win.locator(".xterm:visible textarea").first().focus();
  await win.keyboard.type("echo hello from a tour", { delay: 60 });
  await win.keyboard.press("Enter");
  await win.waitForTimeout(1000);
  const stop = await helper.call("record-stop");
  console.log("stopped", stop);
  const t0 = stop.t0;
  for (const m of marks) console.log(`mark ${m.name}: ${((m.t - t0) / 1e9).toFixed(3)} s`);
  fs.writeFileSync(path.join(out, "marks.json"), JSON.stringify({ t0, marks }, null, 1));
} finally {
  helper.close();
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]);
  try { execFileSync(process.execPath, [path.join(root, "scripts/stop-core.mjs")], { env: { ...process.env, CMD_HOME: home }, stdio: "ignore" }); } catch {}
}
process.exit(0);
