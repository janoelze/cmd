// Renderer performance run (docs/14-performance.md): launches the built app
// against a throwaway core and measures the app window while it idles, while
// terminals change their titles like working agents, during a flood of output and
// while scrolling the scrollback. Main-thread time comes from CDP
// Performance.getMetrics, CPU from app.getAppMetrics(), renders and store events
// from window.__cmdPerf (renderer/src/perf.ts), frame times from a rAF probe.
// usage: pnpm build && node e2e/perf.mjs [--label NAME]
// Results are appended to .cmd-dev/perf/results.jsonl.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { _electron as electron } from "playwright";
import { corePid, stopCore } from "../scripts/stop-core.mjs";

const root = path.resolve(import.meta.dirname, "..");
const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "";
const home = path.join(root, ".cmd-dev", "perf-e2e");
await stopCore(home, { terminals: true });
process.on("exit", () => {
  for (const pid of [corePid(home), corePid(home, "ptyhost")]) {
    try {
      if (pid) process.kill(pid, "SIGTERM");
    } catch {}
  }
});
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(path.join(home, "transcripts-home"), { recursive: true });
fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ "search.enabled": false }));
const flood = path.join(home, "flood.txt");
{
  const lines = [];
  for (let i = 0; i < 200_000; i++) lines.push(`\x1b[32m${String(i).padStart(8)}\x1b[0m \x1b[1mlorem ipsum\x1b[0m dolor sit amet, consectetur adipiscing elit ${"x".repeat(i % 40)}\n`);
  fs.writeFileSync(flood, lines.join(""));
}

const require = createRequire(path.join(root, "apps/desktop/package.json"));
const app = await electron.launch({
  executablePath: require("electron"),
  args: [path.join(root, "apps/desktop")],
  env: { ...process.env, CMD_HOME: home, CMD_NO_SANDBOX: "1", CMD_BACKGROUND: process.env.E2E_VISIBLE ? "" : "1", CMD_TRANSCRIPTS_HOME: path.join(home, "transcripts-home") },
});
const win = await app.firstWindow();
win.on("pageerror", (e) => console.log("pageerror:", e.message));
await win.waitForSelector(".statusbar .core-status");
await win.setViewportSize?.({ width: 1440, height: 900 }).catch(() => {});
const cdp = await win.context().newCDPSession(win);
await cdp.send("Performance.enable");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const menu = (id) =>
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`no menu item ${id}`);
    item.click();
  }, id);
const call = (method, params) => win.evaluate(([m, p]) => window.cmd.call(m, p), [method, params]);
const write = (paneId, data) => call("pane.write", { paneId, data });

// Frame probe: intervals between animation frames while measuring.
await win.evaluate(() => {
  const w = window;
  w.__frames = [];
  let last = performance.now();
  const loop = (t) => {
    if (w.__recording) w.__frames.push(t - last);
    last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});

async function snapshot() {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  const counters = await win.evaluate(() => JSON.parse(JSON.stringify(window.__cmdPerf ?? { renders: {}, events: {}, sets: 0 })));
  return { at: performance.now(), m, counters };
}

/** Run `during` (or wait `seconds`) and report what the app window cost meanwhile. */
async function measure(name, { seconds = 10, during } = {}) {
  await app.evaluate(({ app }) => app.getAppMetrics()); // resets each process's CPU% window
  await win.evaluate(() => ((window.__frames = []), (window.__recording = true)));
  const a = await snapshot();
  if (during) await during();
  else await sleep(seconds * 1000);
  const b = await snapshot();
  const frames = await win.evaluate(() => ((window.__recording = false), window.__frames));
  const procs = await app.evaluate(({ app }) => app.getAppMetrics().map((p) => ({ type: p.type, cpu: p.cpu.percentCPUUsage, mem: p.memory.workingSetSize })));
  const secs = (b.at - a.at) / 1000;
  const d = (k) => (b.m[k] - a.m[k]) * 1000; // ms
  const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);
  const delta = (k) => Object.fromEntries(Object.keys(b.counters[k]).map((n) => [n, (b.counters[k][n] ?? 0) - (a.counters[k][n] ?? 0)]).filter(([, v]) => v > 0));
  const sorted = [...frames].sort((x, y) => x - y);
  const cpuOf = (type) => procs.filter((p) => p.type === type).reduce((x, p) => x + p.cpu, 0);
  const r = {
    seconds: secs,
    "main thread ms/s": d("TaskDuration") / secs,
    "script ms/s": d("ScriptDuration") / secs,
    "layout ms/s": d("LayoutDuration") / secs,
    "style ms/s": d("RecalcStyleDuration") / secs,
    "gpu cpu %": cpuOf("GPU"),
    "renders/s": sum(delta("renders")) / secs,
    "store sets/s": (b.counters.sets - a.counters.sets) / secs,
    fps: frames.length / secs,
    "frames >33ms": frames.filter((f) => f > 33.4).length,
    "p95 frame ms": sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    "renderer MB": procs.filter((p) => p.type === "Tab").reduce((x, p) => x + p.mem, 0) / 1024,
  };
  const rounded = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  console.log(`\n${name}${label ? ` (${label})` : ""}`);
  console.table(rounded);
  console.log("renders:", JSON.stringify(delta("renders")), "events:", JSON.stringify(delta("events")));
  const out = path.join(root, ".cmd-dev/perf/results.jsonl");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  fs.appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), commit, label, scenario: `ui:${name}`, ...rounded, renders: delta("renders"), events: delta("events") }) + "\n");
  return r;
}

// Four terminals, in the default layout.
for (let i = 0; i < 4; i++) await menu("file.newTerminal");
await sleep(2500);
const panes = (await call("pane.list", {})).map((p) => p.id);
const shown = await win.evaluate(() => [...document.querySelectorAll(".tile[data-pane]:not(.hidden-tile)")].map((e) => e.dataset.pane));
const target = shown.find((id) => panes.includes(id)) ?? panes[0];
console.log(`${panes.length} terminals, flooding ${target.slice(0, 8)}`);

await measure("idle", { seconds: 10 });

// Agents rewrite their title with a spinner while they work (Claude Code, Codex): 10 Hz in each terminal.
const spin = `while :; do for c in ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏; do printf '\\033]0;%s Working\\007' $c; sleep 0.1; done; done\r`;
for (const p of panes) await write(p, spin);
await measure("spinners", { seconds: 10 });
// Stop the loops: Ctrl-C until each terminal answers a command again.
for (const p of panes) {
  for (let i = 0; ; i++) {
    if (i === 20) throw new Error(`terminal ${p.slice(0, 8)} didn't stop its spinner`);
    await write(p, "\x03");
    await sleep(200);
    await write(p, `printf '%s\\n' STOP"-"PED${i}\r`);
    await sleep(300);
    if ((await call("pane.read", { paneId: p, lines: 5 })).text.includes(`STOP-PED${i}`)) break;
  }
}

await measure("flood", {
  during: () =>
    win.evaluate(
      ([paneId, file]) =>
        new Promise((resolve) => {
          let tail = "";
          const off = window.cmd.onEvent((e) => {
            if (e.type !== "pane.output" || e.paneId !== paneId) return;
            tail = (tail + e.data).slice(-200);
            if (tail.includes("FLOOD-DONE")) off(), setTimeout(resolve, 300);
          });
          void window.cmd.call("pane.write", { paneId, data: `cat ${file}; printf '%s\\n' FLOOD"-"DONE\r` });
        }),
      [target, flood],
    ),
});

// Scroll up through the scrollback with the wheel, as a trackpad would.
const box = await win.locator(`.tile[data-pane="${target}"] .xterm-screen`).boundingBox();
await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await measure("scroll", {
  during: async () => {
    for (let i = 0; i < 120; i++) {
      await win.mouse.wheel(0, i < 60 ? -120 : 120);
      await sleep(16);
    }
  },
});

// app.close() waits for Electron's output pipes, which the detached core inherits: wait for the exit instead.
const proc = app.process();
const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once("exit", r));
app.close().catch(() => {});
await exited;
await stopCore(home, { terminals: true });
process.exit(0);
