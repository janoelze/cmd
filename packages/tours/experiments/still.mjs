// Experiment: a still of cmd's window with its real shadow and alpha
// (helper/still.swift), to see what compositing has to work with.
// usage: node experiments/still.mjs <still-binary> <out.png>
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright";
import { fixtureEnv, makeFixture } from "../src/fixture.ts";

const [still, out] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "../../..");
const f = makeFixture(path.join(root, ".cmd-dev/tours/still"));
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const app = await electron.launch({ executablePath: require("electron"), args: [path.join(root, "apps/desktop")], env: fixtureEnv(f) });
try {
  const win = await app.firstWindow();
  await win.waitForSelector(".statusbar .core-status");
  await app.evaluate(({ BrowserWindow, app }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1280, 800);
    w.center();
    app.focus({ steal: true });
    w.focus();
  });
  await win.waitForTimeout(800);
  console.log(execFileSync(still, [String(app.process().pid), out], { encoding: "utf8" }));
} finally {
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 4000))]);
  try { execFileSync(process.execPath, [path.join(root, "scripts/stop-core.mjs"), "--terminals"], { env: { ...process.env, CMD_HOME: f.cmdHome }, stdio: "ignore" }); } catch {}
}
process.exit(0);
