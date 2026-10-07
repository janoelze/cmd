// Experiment: what the helper sees of an open native context menu (popped
// from code, the pointer isn't moved). usage: node experiments/axdump.mjs
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright";
import { fixtureEnv, makeFixture } from "../src/fixture.ts";
import { Helper } from "../src/helper.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const f = makeFixture(path.join(root, ".cmd-dev/tours/axdump"));
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const app = await electron.launch({ executablePath: require("electron"), args: [path.join(root, "apps/desktop")], env: fixtureEnv(f) });
const helper = Helper.start();
try {
  const win = await app.firstWindow();
  await win.waitForSelector(".statusbar .core-status");
  await app.evaluate(({ Menu, BrowserWindow }) => {
    globalThis.m = Menu.buildFromTemplate([{ label: "Open" }, { label: "Copy Path" }, { type: "separator" }, { label: "Rename… (F2)", enabled: false }]);
    globalThis.m.popup({ window: BrowserWindow.getAllWindows()[0], x: 300, y: 300 });
  });
  await new Promise((r) => setTimeout(r, 800));
  console.log((await helper.call("menu-items", { pid: app.process().pid })).items);
  await app.evaluate(() => globalThis.m.closePopup());
} finally {
  helper.close();
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 4000))]);
  try { execFileSync(process.execPath, [path.join(root, "scripts/stop-core.mjs"), "--terminals"], { env: { ...process.env, CMD_HOME: f.cmdHome }, stdio: "ignore" }); } catch {}
}
process.exit(0);
