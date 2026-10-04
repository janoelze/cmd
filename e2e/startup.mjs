// Startup timing (docs/14-performance.md): launches the built app repeatedly against
// six terminals with some output, and reads every boot:* mark of main and the
// renderer on one clock (epoch ms), relative to the launch call. Three cases:
//   warm: the core is running (closing the app keeps it)
//   core: the core stopped, its terminals kept by the PTY host (an app update)
//   cold: core and PTY host stopped (a reboot: terminals resurrected)
// usage: pnpm build && node e2e/startup.mjs [--runs N] [--only warm|core|cold] [--label NAME] [--keep]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { _electron as electron } from "playwright";
import { corePid, stopCore } from "../scripts/stop-core.mjs";

const root = path.resolve(import.meta.dirname, "..");
const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const runs = Number(arg("runs", "3"));
const label = arg("label", "");
const home = path.join(root, ".cmd-dev", "startup-e2e");
await stopCore(home, { terminals: true });
process.on("exit", () => {
  if (process.argv.includes("--keep")) return;
  for (const pid of [corePid(home), corePid(home, "ptyhost")]) {
    try {
      if (pid) process.kill(pid, "SIGTERM");
    } catch {}
  }
});
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(path.join(home, "transcripts-home"), { recursive: true });
fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ "search.enabled": false }));
const require = createRequire(path.join(root, "apps/desktop/package.json"));

async function launch() {
  const t0 = Date.now();
  const app = await electron.launch({
    executablePath: require("electron"),
    args: [path.join(root, "apps/desktop")],
    env: { ...process.env, CMD_HOME: home, CMD_NO_SANDBOX: "1", CMD_BACKGROUND: process.env.E2E_VISIBLE ? "" : "1", CMD_TRANSCRIPTS_HOME: path.join(home, "transcripts-home") },
  });
  const win = await app.firstWindow();
  await win.waitForSelector(".sidebar-status");
  return { app, win, t0 };
}

async function close(app) {
  const proc = app.process();
  const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once("exit", r));
  app.close().catch(() => {});
  await exited;
}

const marks = (page) =>
  page.evaluate(() => Object.fromEntries(performance.getEntriesByType("mark").filter((m) => m.name.startsWith("boot:")).map((m) => [m.name, performance.timeOrigin + m.startTime])));

/** One launch: every mark in ms since the launch call. */
async function timed() {
  const { app, win, t0 } = await launch();
  // Done when the terminals are written and the tiles painted.
  await win.waitForFunction(() => performance.getEntriesByName("boot:terminals").length && performance.getEntriesByName("boot:tiles-painted").length, null, { timeout: 30_000 });
  const main = await app.evaluate(() => {
    const p = globalThis.performance;
    return Object.fromEntries(p.getEntriesByType("mark").filter((m) => m.name.startsWith("boot:")).map((m) => [m.name, p.timeOrigin + m.startTime]));
  });
  const r = { ...main, ...(await marks(win)) };
  await close(app);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k.slice(5), Math.round(v - t0)]).sort((a, b) => a[1] - b[1]));
}

// Setup: six terminals with a screenful each.
{
  const { app, win } = await launch();
  for (let i = 0; i < 6; i++)
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("file.newTerminal")?.click());
  await win.waitForTimeout(2000);
  for (const p of await win.evaluate(() => window.cmd.call("pane.list", {})))
    await win.evaluate((id) => window.cmd.call("pane.write", { paneId: id, data: "for i in {1..3000}; do echo line $i of some output; done\r" }), p.id);
  await win.waitForTimeout(12_000); // screens saved (every 10 s) for the cold case
  await close(app);
}

const out = path.join(root, ".cmd-dev/perf/results.jsonl");
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const only = arg("only", null);
for (const kind of ["warm", "core", "cold"].filter((k) => !only || k === only)) {
  const all = [];
  for (let i = 0; i < runs; i++) {
    if (kind === "core") await stopCore(home);
    if (kind === "cold") await stopCore(home, { terminals: true });
    all.push(await timed());
  }
  // Median per mark.
  const names = Object.keys(all[0]);
  const med = Object.fromEntries(names.map((n) => [n, all.map((r) => r[n]).sort((a, b) => a - b)[Math.floor(all.length / 2)]]));
  console.log(`\n${kind}${label ? ` (${label})` : ""}: median of ${runs}, ms since launch`);
  console.table(med);
  fs.appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), commit, label, scenario: `startup:${kind}`, ...med }) + "\n");
}
// --keep: leave the core and state running (for e2e/startup-profile.mjs).
if (!process.argv.includes("--keep")) await stopCore(home, { terminals: true });
process.exit(0);
