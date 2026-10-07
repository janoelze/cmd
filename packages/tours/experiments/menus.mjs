// Experiment 1: does ScreenCaptureKit see cmd's native context menu and its
// traffic lights? Launches the built app (visible), pops a native menu at a
// fixed spot in the window (the pointer isn't moved), then captures stills
// with helper/still. usage: node experiments/menus.mjs <still-binary> <out-dir>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright";

const [still, out] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "../../..");
const home = path.join(root, ".cmd-dev", "tour-exp");
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(path.join(home, "ui"), { recursive: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(home, "ui", "onboarding.json"), JSON.stringify({ seen: ["welcome", "ai"] }));
const fakeHome = path.join(home, "home");
fs.mkdirSync(fakeHome, { recursive: true });

const require = createRequire(path.join(root, "apps/desktop/package.json"));
const app = await electron.launch({
  executablePath: require("electron"),
  args: [path.join(root, "apps/desktop")],
  env: { ...process.env, HOME: fakeHome, CMD_HOME: home, CMD_USAGE_URL: "off", CMD_NO_SANDBOX: "1", CMD_BACKGROUND: "" },
});
try {
  const win = await app.firstWindow();
  await win.waitForSelector(".statusbar .core-status");
  await app.evaluate(({ Menu, BrowserWindow, app }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setBounds({ x: 120, y: 80, width: 1280, height: 800 });
    app.focus({ steal: true });
    w.focus();
    Menu.getApplicationMenu()?.getMenuItemById("file.newTerminal")?.click();
  });
  await win.waitForTimeout(1500);
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const m = Menu.buildFromTemplate([{ label: "Copy" }, { label: "Paste" }, { type: "separator" }, { label: "Split Right" }, { label: "Close" }]);
    globalThis.__menu = m;
    m.popup({ window: BrowserWindow.getAllWindows()[0], x: 400, y: 300 });
  });
  await win.waitForTimeout(700);
  console.log(execFileSync(still, [String(app.process().pid), out], { encoding: "utf8" }));
  await app.evaluate(() => globalThis.__menu.closePopup());
} finally {
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]);
  try { execFileSync(process.execPath, [path.join(root, "scripts/stop-core.mjs")], { env: { ...process.env, CMD_HOME: home }, stdio: "ignore" }); } catch {}
}
process.exit(0);
