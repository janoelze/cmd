// Interaction latency run (docs/43-performance.md): launches the built app against a
// throwaway core with a realistic board (terminals with scrollback, a second
// workspace) and times what a person does: commands through the menu bar (the way
// shortcuts arrive), keystrokes into a terminal, window resizes. For each action it
// reports the time until the change is on screen (the first frame after it shows),
// the time until the board stops moving (animations included), frames dropped
// meanwhile, and the long animation frames with the scripts that made them long.
// usage: pnpm build && node e2e/latency.mjs [--label NAME] [--only name,name] [--runs N]
// Results are appended to .cmd-dev/perf/results.jsonl.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { _electron as electron } from "playwright";
import { corePid, stopCore } from "../scripts/stop-core.mjs";
import { startProfile } from "./profile.mjs";

const root = path.resolve(import.meta.dirname, "..");
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const label = arg("--label") ?? "";
const only = arg("--only")?.split(",");
const RUNS = Number(arg("--runs") ?? 8);
// --profile: sample the renderer's CPU over each scenario and list where its time went
// (build with CMD_NO_MINIFY=1 pnpm build for readable names).
const PROFILE = process.argv.includes("--profile");
const home = path.join(root, ".cmd-dev", "latency-e2e");
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
fs.mkdirSync(path.join(home, "ui"), { recursive: true });
fs.writeFileSync(path.join(home, "ui", "onboarding.json"), JSON.stringify({ seen: ["welcome", "ai"] }));
const project = path.join(home, "project");
fs.mkdirSync(path.join(project, "src"), { recursive: true });
for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(project, "src", `file${i}.ts`), `export const x${i} = ${i};\n`.repeat(200));

const require = createRequire(path.join(root, "apps/desktop/package.json"));
const app = await electron.launch({
  executablePath: require("electron"),
  args: [path.join(root, "apps/desktop")],
  env: { ...process.env, CMD_HOME: home, CMD_NO_SANDBOX: "1", CMD_BACKGROUND: process.env.E2E_VISIBLE ? "" : "1", CMD_TRANSCRIPTS_HOME: path.join(home, "transcripts-home") },
});
const win = await app.firstWindow();
win.on("pageerror", (e) => console.log("pageerror:", e.message));
await win.waitForSelector(".statusbar .core-status");
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));

const cdp = await win.context().newCDPSession(win);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const menu = (id) =>
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`no menu item ${id}`);
    item.click();
  }, id);
const call = (method, params) => win.evaluate(([m, p]) => window.cmd.call(m, p), [method, params]);

// The probe: frame intervals, long animation frames, and a signature of what's on
// screen (tile rects, the selection, overlays, the workspace), checked every frame.
await win.evaluate(() => {
  const w = window;
  w.__lat = { frames: [], loafs: [], rec: false };
  let last = performance.now();
  const loop = (t) => {
    if (w.__lat.rec) w.__lat.frames.push([t, t - last]);
    last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  new PerformanceObserver((l) => {
    if (!w.__lat.rec) return;
    for (const e of l.getEntries())
      w.__lat.loafs.push({
        start: e.startTime,
        duration: e.duration,
        blocking: e.blockingDuration,
        render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0,
        style: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
        scripts: e.scripts.map((s) => ({ d: Math.round(s.duration), inv: s.invoker, fn: s.sourceFunctionName, src: `${(s.sourceURL || "").split("/").pop()}:${s.sourceCharPosition}`, layout: Math.round(s.forcedStyleAndLayoutDuration) })),
      });
  }).observe({ type: "long-animation-frame", buffered: false });
  w.__sig = () => {
    const tiles = [...document.querySelectorAll(".tile")].map((t) => {
      const r = t.getBoundingClientRect();
      return `${t.dataset.pane ?? ""}:${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
    });
    return [tiles.join(";"), document.querySelector(".tile.sel .xterm-screen")?.style.width, innerWidth, devicePixelRatio, document.querySelector("main.windows")?.clientWidth, document.querySelector(".tile.sel")?.getAttribute("data-pane"), document.querySelector(".palette:not([data-closing])") ? "P" : "", document.querySelector(".workspace-trigger .workspace-name")?.textContent, document.querySelectorAll("[data-motion]:not([data-closing])").length].join("|");
  };
});

/**
 * Run `act` and watch the screen: `responded` is the first frame whose signature
 * differs (or `ready()` holds), `settled` the first after which it holds still for 12
 * frames. Times are from `t0`, the renderer's clock when the action starts (or the
 * keydown's timeStamp for keystrokes).
 */
async function timed(act, { ready, settleFrames = 12, timeout = 4000 } = {}) {
  await win.evaluate(
    ([ready, settleFrames, timeout]) =>
      new Promise((resolve) => {
        const w = window;
        w.__lat.frames = [];
        w.__lat.loafs = [];
        w.__lat.rec = true;
        const before = w.__sig();
        const t0 = performance.now();
        const check = ready ? new Function(`return (${ready})()`) : null;
        let responded = null;
        let lastSig = before;
        let still = 0;
        let lastChange = null;
        w.__lat.result = null;
        w.__lat.t0 = t0;
        const tick = (t) => {
          const sig = w.__sig();
          const ok = check ? check() : sig !== before;
          if (responded === null && ok) responded = t;
          if (sig !== lastSig) (lastSig = sig), (still = 0), (lastChange = t);
          else still++;
          if ((responded !== null && still >= settleFrames) || t - t0 > timeout) {
            w.__lat.rec = false;
            w.__lat.result = { t0, responded, settled: lastChange ?? responded, timedOut: responded === null };
            return resolve();
          }
          requestAnimationFrame(tick);
        };
        w.__lat.go = () => requestAnimationFrame(tick);
        resolve();
      }),
    [ready?.toString() ?? null, settleFrames, timeout],
  );
  await win.evaluate(() => window.__lat.go());
  await act();
  await win.waitForFunction(() => window.__lat.result, null, { timeout: timeout + 2000 });
  await sleep(60); // LoAF entries arrive after their frame
  return win.evaluate(() => {
    const { result, frames, loafs } = window.__lat;
    const t0 = window.__lat.keyAt ?? result.t0;
    window.__lat.keyAt = null;
    const until = result.settled ?? performance.now();
    const inside = frames.filter(([t]) => t >= t0 && t <= until + 1);
    const budget = 1000 / 120;
    return {
      respond: result.responded === null ? null : result.responded - t0,
      settle: result.settled === null ? null : result.settled - t0,
      timedOut: result.timedOut,
      dropped: inside.reduce((n, [, d]) => n + Math.max(0, Math.round(d / budget) - 1), 0),
      worstFrame: Math.max(0, ...inside.map(([, d]) => d)),
      loafs: loafs.filter((l) => l.start + l.duration >= t0 - 1),
    };
  });
}

const stats = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return { med: null, p95: null, max: null };
  return { med: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] };
};
const rows = [];
const culprits = new Map();
async function scenario(name, run, { runs = RUNS, setup, teardown } = {}) {
  if (only && !only.includes(name)) return;
  const results = [];
  const rendersBefore = await win.evaluate(() => ({ ...window.__cmdPerf.renders }));
  const stopProfile = PROFILE ? await startProfile(cdp) : null;
  for (let i = 0; i < runs; i++) {
    if (setup) await setup(i);
    results.push(await run(i).catch((e) => (console.log(`  ${name}: ${e.message.split("\n")[0]}`), { respond: null, settle: null, timedOut: true, dropped: 0, worstFrame: 0, loafs: [] })));
    if (teardown) await teardown(i);
    await sleep(150);
  }
  if (stopProfile) await stopProfile(name, runs);
  const rendersAfter = await win.evaluate(() => ({ ...window.__cmdPerf.renders }));
  const renders = Object.fromEntries(Object.entries(rendersAfter).map(([k, v]) => [k, Math.round(((v - (rendersBefore[k] ?? 0)) / runs) * 10) / 10]).filter(([, v]) => v > 0));
  const r = stats(results.map((x) => x.respond));
  const s = stats(results.map((x) => x.settle));
  const loafs = results.flatMap((x) => x.loafs);
  for (const l of loafs)
    for (const sc of l.scripts) {
      const key = `${name} ← ${sc.inv} ${sc.fn || "?"} @${sc.src}`;
      const c = culprits.get(key) ?? { ms: 0, n: 0, layout: 0 };
      c.ms += sc.d;
      c.n++;
      c.layout += sc.layout;
      culprits.set(key, c);
    }
  const row = {
    action: name,
    "respond med": r.med,
    "respond p95": r.p95,
    "settle med": s.med,
    dropped: results.reduce((n, x) => n + x.dropped, 0) / runs,
    "worst frame": Math.max(...results.map((x) => x.worstFrame)),
    "loaf ms/run": loafs.reduce((n, l) => n + l.duration, 0) / runs,
    "render ms/loaf": loafs.length ? loafs.reduce((n, l) => n + l.render, 0) / loafs.length : 0,
    timeouts: results.filter((x) => x.timedOut).length,
  };
  for (const k of Object.keys(row)) if (typeof row[k] === "number") row[k] = Math.round(row[k] * 10) / 10;
  rows.push(row);
  console.log(JSON.stringify(row), "renders/run:", JSON.stringify(renders));
}

// The board: 8 terminals with some scrollback, a Files window, a second workspace.
for (let i = 0; i < 8; i++) await menu("file.newTerminal");
await win.waitForFunction(() => document.querySelectorAll(".tile[data-pane]").length >= 8, null, { timeout: 15000 });
await sleep(1500);
const panes = (await call("pane.list", {})).map((p) => p.id);
for (const p of panes) await call("pane.write", { paneId: p, data: `for i in $(seq 1 3000); do echo "line $i $(printf '%.0s─' {1..60})"; done\r` });
await sleep(3000);

const sel = () => win.evaluate(() => document.querySelector(".tile.sel")?.getAttribute("data-pane"));

// Keystrokes into the selected terminal, timed from the keydown event until the echo is on screen.
await win.evaluate(() =>
  window.addEventListener("keydown", (e) => {
    if (window.__lat?.rec) window.__lat.keyAt = e.timeStamp;
  }, true),
);
{
  const target = (await sel()) ?? panes[0];
  await win.locator(`.tile[data-pane="${target}"] .xterm-screen`).click();
  await call("pane.write", { paneId: target, data: "clear\r" });
  await sleep(500);
  const letters = "thequickbrownfoxjumpsoverthelazydog";
  const typing = async (name) => {
    let typed = "";
    await scenario(
      name,
      async (i) => {
        typed += letters[i % letters.length];
        return timed(() => win.keyboard.press(letters[i % letters.length]), {
          ready: new Function(`return () => window.__cmdTermScreen(${JSON.stringify(target)}).includes(${JSON.stringify(typed)})`)(),
          settleFrames: 2,
        });
      },
      { runs: 30 },
    );
    await win.keyboard.press("Control+C");
    await sleep(300);
  };
  await typing("type");
  // The same while three other terminals stream output (agents working beside you): ~4,000 lines a second each.
  const busy = panes.filter((p) => p !== target).slice(0, 3);
  if (!only || only.includes("type (busy)")) {
    for (const p of busy) await call("pane.write", { paneId: p, data: "while :; do seq 1 200; sleep 0.05; done\r" });
    await sleep(1000);
    await typing("type (busy)");
    for (const p of busy) await call("pane.write", { paneId: p, data: "\x03" });
    await sleep(800);
  }
}

await scenario("session.next", () => timed(() => menu("session.next"), { ready: undefined }), { runs: 12 });
await scenario("palette open", () => timed(() => menu("view.palette"), { ready: () => !!document.querySelector(".palette") }), {
  teardown: async () => {
    await win.keyboard.press("Escape");
    await win.waitForFunction(() => !document.querySelector(".palette"));
  },
});
await scenario(
  "palette type",
  async () => {
    return timed(() => win.keyboard.type("ter"), { ready: () => document.querySelector(".palette-input")?.value === "ter", settleFrames: 4 });
  },
  {
    setup: async () => {
      await menu("view.palette");
      await win.waitForSelector(".palette-input");
    },
    teardown: async () => {
      await win.keyboard.press("Escape");
      await win.waitForFunction(() => !document.querySelector(".palette"));
    },
  },
);
await scenario("palette close", () => timed(() => win.keyboard.press("Escape"), { ready: () => !document.querySelector(".palette:not([data-closing])") }), {
  setup: async () => {
    await menu("view.palette");
    await win.waitForSelector(".palette-input");
    await sleep(300);
  },
});
await scenario("search open", () => timed(() => menu("view.search"), { ready: undefined }), {
  teardown: async () => {
    await win.keyboard.press("Escape");
    await sleep(400);
  },
});
for (const view of ["view.strip", "view.canvas", "view.focus", "view.grid"]) await scenario(view, () => timed(() => menu(view)), { runs: 4, teardown: () => menu(view === "view.grid" ? "view.strip" : "view.grid").then(() => sleep(600)) });
await scenario("view.sidebar", () => timed(() => menu("view.sidebar")), { runs: 6 });
await scenario("view.zoomIn/Out", (i) => timed(() => menu(i % 2 ? "view.zoomOut" : "view.zoomIn")), { runs: 6 });
await scenario(
  "new terminal",
  () => timed(() => menu("file.newTerminal"), { ready: () => document.querySelectorAll(".tile[data-pane]").length > window.__tiles }),
  {
    runs: 5,
    setup: () => win.evaluate(() => (window.__tiles = document.querySelectorAll(".tile[data-pane]").length)),
    teardown: async () => {
      await menu("window.close");
      await sleep(800);
    },
  },
);
await scenario(
  "close window",
  () => timed(() => menu("window.close"), { ready: () => document.querySelectorAll(".tile[data-pane]:not([data-closing])").length < window.__tiles }),
  {
    runs: 5,
    setup: async () => {
      await menu("file.newTerminal");
      await sleep(900);
      await win.evaluate(() => (window.__tiles = document.querySelectorAll(".tile[data-pane]").length));
    },
  },
);
// A second workspace with its own windows; switch back and forth.
{
  await call("workspace.open", { path: project, show: true });
  await sleep(800);
  for (let i = 0; i < 3; i++) await menu("file.newTerminal");
  await sleep(1500);
  await scenario("workspace switch", () => timed(() => menu("workspace.next"), { settleFrames: 20 }), { runs: 8 });
}
await scenario(
  "window resize",
  (i) =>
    timed(
      async () => {
        for (let k = 0; k < 20; k++) {
          await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]?.setSize(w, 900), (i % 2 ? 1440 : 1100) + (i % 2 ? -k : k) * 17);
        }
      },
      { settleFrames: 20, timeout: 6000 },
    ),
  { runs: 4 },
);

console.log(`\nlatency${label ? ` (${label})` : ""}, ms (120 Hz frame = 8.3 ms)`);
console.table(rows);
const top = [...culprits].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25);
console.log("\nscripts in long animation frames (total ms over all runs, count, forced layout ms):");
for (const [k, v] of top) console.log(`${String(v.ms).padStart(6)} ms ${String(v.n).padStart(4)}× layout ${String(v.layout).padStart(5)}  ${k}`);

const out = path.join(root, ".cmd-dev/perf/results.jsonl");
fs.mkdirSync(path.dirname(out), { recursive: true });
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
for (const r of rows) fs.appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), commit, label, scenario: `latency:${r.action}`, ...r }) + "\n");

const proc = app.process();
const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once("exit", r));
app.close().catch(() => {});
await exited;
await stopCore(home, { terminals: true });
process.exit(0);
