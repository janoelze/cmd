// CPU profile of the app window's startup (docs/43-performance.md): run after
// e2e/startup.mjs has left its state (6 terminals) in .cmd-dev/startup-e2e, with
// the core running. Prints the functions with the most self time until the
// terminals are written, and the callers of the top three (profile.mjs).  usage: node e2e/startup-profile.mjs
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright";
import { startProfile } from "./profile.mjs";

const root = path.resolve(import.meta.dirname, "..");
const home = path.join(root, ".cmd-dev", "startup-e2e");
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const app = await electron.launch({
  executablePath: require("electron"),
  args: [path.join(root, "apps/desktop")],
  env: { ...process.env, CMD_HOME: home, CMD_NO_SANDBOX: "1", CMD_BACKGROUND: process.env.E2E_VISIBLE ? "" : "1", CMD_TRANSCRIPTS_HOME: path.join(home, "transcripts-home") },
});
const win = await app.firstWindow();
const cdp = await win.context().newCDPSession(win);
const stop = await startProfile(cdp);
await win.waitForFunction(() => performance.getEntriesByName("boot:terminals").length, null, { timeout: 30_000 });
await win.waitForTimeout(300);
await stop("startup", 1, "start");
const proc = app.process();
const exited = new Promise((r) => proc.once("exit", r));
app.close().catch(() => {});
await exited;
process.exit(0);
