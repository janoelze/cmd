// Interaction latency run (docs/43-performance.md): launches the built app against a
// throwaway core with a realistic board (terminals with scrollback, a second
// workspace) and times what a person does: commands through the menu bar (the way
// shortcuts arrive), keystrokes into a terminal, window resizes. For each action it
// reports the time until the change is on screen (the first frame after it shows),
// the time until the board stops moving (animations included), frames dropped
// meanwhile, and the long animation frames with the scripts that made them long.
// usage: pnpm build && node e2e/latency.mjs [--label NAME] [--only name,name] [--runs N]
//        [--windows N] [--workspaces N] [--agents N] [--view grid|strip|canvas|focus]
//        (heavy use: more windows and workspaces, terminals running e2e/fake-agent.mjs)
// Env: LATENCY_FRAMES=1 the long frames of each run; LATENCY_TRACE=<scenario> a Chromium
// trace of its first run (the longest main-thread events, what's inside the longest script;
// for steady states: style and layout per second), LATENCY_TRACE_INV=1 with what invalidated
// style and layout; LATENCY_BOARD=1 every tile and its renderer; LATENCY_SETTINGS='{json}'.
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
/** --only names, or prefixes ending in * ("open *"). */
const wanted = (name) => !only || only.some((o) => o === name || (o.endsWith("*") && name.startsWith(o.slice(0, -1))));
const RUNS = Number(arg("--runs") ?? 8);
// Scale: terminals on the board, extra workspaces (6 terminals each), and terminals running
// a stand-in coding agent (fake-agent.mjs) through every scenario.
const WINDOWS = Number(arg("--windows") ?? 8);
const WORKSPACES = Number(arg("--workspaces") ?? 0);
const AGENTS = Number(arg("--agents") ?? 0);
/** --view grid|strip|canvas|focus: the board's mode for the run (the default is the app's). */
const VIEW = arg("--view");
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
fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); // a core that just stopped may still be writing its logs
fs.mkdirSync(path.join(home, "transcripts-home"), { recursive: true });
fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ "search.enabled": false, ...JSON.parse(process.env.LATENCY_SETTINGS ?? "{}") })); // LATENCY_SETTINGS: more, as JSON
fs.mkdirSync(path.join(home, "ui"), { recursive: true });
fs.writeFileSync(path.join(home, "ui", "onboarding.json"), JSON.stringify({ seen: ["welcome", "ai"] }));
const project = path.join(home, "project");
fs.mkdirSync(path.join(project, "src"), { recursive: true });
for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(project, "src", `file${i}.ts`), `export const x${i} = ${i};\n`.repeat(200));
// A long source file for the editor and a folder of 2,000 files for the file browser.
{
  const fn = (i) => `export function handler${i}(request: { id: number; body: string }): Promise<string> {\n  const parts = request.body.split(",").map((s) => s.trim());\n  if (parts.length > ${i % 7}) return Promise.resolve(parts.join("-"));\n  return Promise.reject(new Error(\`bad request \${request.id}\`));\n}\n\n`;
  fs.writeFileSync(path.join(project, "big.ts"), Array.from({ length: 3000 }, (_, i) => fn(i)).join(""));
  fs.mkdirSync(path.join(project, "many"));
  for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(project, "many", `item-${String(i).padStart(4, "0")}.json`), "{}\n");
  // One file of each kind the app opens (the reference fixtures), and long Markdown and JSON.
  fs.cpSync(path.join(root, "apps/desktop/src/renderer/src/reference/fixtures/kinds"), path.join(project, "kinds"), { recursive: true });
  fs.copyFileSync(path.join(root, "apps/desktop/src/renderer/src/reference/fixtures/manual.pdf"), path.join(project, "kinds", "manual.pdf"));
  const section = (i) => `## Section ${i}\n\nSome *prose* with \`code\`, a [link](https://example.com) and **bold** text that wraps across the width of the window. `.repeat(3) + `\n\n- one\n- two\n  - nested\n\n\`\`\`ts\nconst x${i} = await fetch("/api/${i}");\nconsole.log(x${i});\n\`\`\`\n\n| a | b |\n|---|---|\n| ${i} | ${i * 2} |\n\n`;
  fs.writeFileSync(path.join(project, "kinds", "long.md"), `# Long document\n\n${Array.from({ length: 300 }, (_, i) => section(i)).join("")}`);
  fs.writeFileSync(path.join(project, "kinds", "big.json"), JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ id: i, name: `item ${i}`, tags: ["a", "b"], nested: { ok: i % 2 === 0, n: i * 1.5 } })), null, 2));
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
    return [tiles.join(";"), document.querySelector(".tile.sel .xterm-screen")?.style.width, innerWidth, devicePixelRatio, document.querySelector("main.windows")?.clientWidth, document.querySelector(".tile.sel")?.getAttribute("data-pane"), document.querySelector(".palette:not([data-closing])") ? "P" : "", document.querySelector(".workspace-trigger .workspace-name")?.textContent, document.querySelectorAll("[data-motion]:not([data-closing])").length, document.querySelector(".tile.sel")?.getElementsByTagName("*").length].join("|");
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
            w.__lat.result = { t0, responded, settled: lastChange ?? responded, end: t, timedOut: responded === null };
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
    const until = result.end; // every frame watched, the quiet ones after settling too
    const inside = frames.filter(([t]) => t >= t0 && t <= until + 1);
    const budget = 1000 / 120;
    return {
      respond: result.responded === null ? null : result.responded - t0,
      settle: result.settled === null ? null : result.settled - t0,
      timedOut: result.timedOut,
      dropped: inside.reduce((n, [, d]) => n + Math.max(0, Math.round(d / budget) - 1), 0),
      worstFrame: Math.max(0, ...inside.map(([, d]) => d)),
      loafs: loafs.filter((l) => l.start + l.duration >= t0 - 1),
      // LATENCY_FRAMES=1: every frame of the run, ms from its start, and how long it took.
      frames: inside.map(([t, d]) => [Math.round(t - t0), Math.round(d)]),
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
  if (!wanted(name)) return;
  const results = [];
  const rendersBefore = await win.evaluate(() => ({ ...window.__cmdPerf.renders }));
  const eventsBefore = await win.evaluate(() => ({ ...window.__cmdPerf.events, sets: window.__cmdPerf.sets }));
  const stopProfile = PROFILE ? await startProfile(cdp) : null;
  for (let i = 0; i < runs; i++) {
    if (setup) await setup(i);
    // LATENCY_TRACE=name: a Chromium trace of its first run; the main thread's longest events printed.
    const tracing = process.env.LATENCY_TRACE === name && i === 0;
    const events = [];
    if (tracing) {
      cdp.on("Tracing.dataCollected", (d) => events.push(...d.value));
      await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,v8.execute,gpu,cc", transferMode: "ReportEvents" });
    }
    const res = await run(i).catch((e) => (console.log(`  ${name}: ${e.message.split("\n")[0]}`), { respond: null, settle: null, timedOut: true, dropped: 0, worstFrame: 0, loafs: [] }));
    if (tracing) {
      const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
      await cdp.send("Tracing.end");
      await done;
      const main = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain")?.tid;
      const long = events.filter((e) => e.ph === "X" && e.tid === main && e.dur > 8000).sort((a, b) => b.dur - a.dur).slice(0, 25);
      for (const e of long) console.log(`  trace ${(e.dur / 1000).toFixed(1).padStart(6)} ms  ${e.name} ${JSON.stringify(e.args?.data ?? {}).slice(0, 400)}`);
      // Inside the longest script: its direct parts by kind (layout, style, GC, GPU calls…).
      const top = long.find((e) => e.name === "FunctionCall" || e.name === "EvaluateScript" || e.name === "TimerFire" || e.name === "FireAnimationFrame");
      if (top) {
        const parts = new Map();
        for (const e of events) if (e.tid === main && e.ph === "X" && e.ts >= top.ts && e.ts + e.dur <= top.ts + top.dur && e !== top) parts.set(e.name, (parts.get(e.name) ?? 0) + e.dur / 1000);
        console.log("  inside:", [...parts].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([n, ms]) => `${n} ${ms.toFixed(1)}`).join(" · "));
      }
    }
    if (process.env.LATENCY_FRAMES && res.frames) console.log(`  ${name} #${i}: frames ${res.frames.filter(([, d]) => d > 20).map(([t, d]) => `${d}@${t}`).join(" ")}; long frames ${res.loafs.map((l) => `${Math.round(l.duration)}@${Math.round(l.start - (res.t0 ?? 0))}`).join(" ")}`);
    results.push(res);
    if (teardown) await teardown(i);
    await sleep(150);
  }
  if (stopProfile) await stopProfile(name, runs);
  const rendersAfter = await win.evaluate(() => ({ ...window.__cmdPerf.renders }));
  const renders = Object.fromEntries(Object.entries(rendersAfter).map(([k, v]) => [k, Math.round(((v - (rendersBefore[k] ?? 0)) / runs) * 10) / 10]).filter(([, v]) => v > 0));
  const eventsAfter = await win.evaluate(() => ({ ...window.__cmdPerf.events, sets: window.__cmdPerf.sets }));
  const events = Object.fromEntries(Object.entries(eventsAfter).map(([k, v]) => [k, Math.round(((v - (eventsBefore[k] ?? 0)) / runs) * 10) / 10]).filter(([, v]) => v > 0));
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
  console.log(JSON.stringify(row), "renders/run:", JSON.stringify(renders), "events/run:", JSON.stringify(events));
}

// The board: 8 terminals (--windows) with some scrollback, a Files window, a second workspace.
for (let i = 0; i < WINDOWS; i++) await menu("file.newTerminal");
await win.waitForFunction((n) => document.querySelectorAll(".tile[data-pane]").length >= n, WINDOWS, { timeout: 30000 });
await sleep(1500);
const panes = (await call("pane.list", {})).map((p) => p.id);
// More workspaces, each with its own terminals, then back to the first.
for (let w = 0; w < WORKSPACES; w++) {
  const dir = path.join(home, `workspace-${w}`);
  fs.mkdirSync(dir, { recursive: true });
  await call("workspace.open", { path: dir, show: true });
  await sleep(600);
  for (let i = 0; i < 6; i++) await menu("file.newTerminal");
  await sleep(800);
}
for (let w = 0; WORKSPACES && w <= WORKSPACES; w++) {
  if (await win.evaluate((id) => !!document.querySelector(`.tile[data-pane="${id}"]`), panes[0])) break;
  await menu("workspace.next");
  await sleep(700);
}
for (const p of (await call("pane.list", {})).map((p) => p.id)) await call("pane.write", { paneId: p, data: `for i in $(seq 1 3000); do echo "line $i $(printf '%.0s─' {1..60})"; done\r` });
await sleep(3000 + WORKSPACES * 500);
// Agents at work beside the selected terminal (never in it: that's where the typing goes).
const agentPanes = [];
if (AGENTS) {
  const selected = await win.evaluate(() => document.querySelector(".tile.sel")?.getAttribute("data-pane"));
  for (const p of panes.filter((p) => p !== selected).slice(0, AGENTS)) {
    await call("pane.write", { paneId: p, data: `clear; ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "e2e/fake-agent.mjs"))}\r` });
    agentPanes.push(p);
  }
  await sleep(1500);
}
if (VIEW) await menu(`view.${VIEW}`), await sleep(1200);
console.log(`${(await call("pane.list", {})).length} terminals, ${WORKSPACES + 1} workspaces, ${agentPanes.length} agents`);

/** What the window costs over `seconds` of doing nothing itself (agents may be working): main thread, frames, renders, memory. */
async function steady(name, seconds = 8) {
  if (!wanted(name)) return;
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  await cdp.send("Performance.enable");
  await app.evaluate(({ app }) => app.getAppMetrics());
  const a = await metrics();
  const ra = await win.evaluate(() => ({ ...window.__cmdPerf.renders }));
  await win.evaluate(() => ((window.__lat.frames = []), (window.__lat.loafs = []), (window.__lat.rec = true)));
  const stopProfile = PROFILE ? await startProfile(cdp) : null;
  const events = [];
  const tracing = process.env.LATENCY_TRACE === name;
  if (tracing) {
    cdp.on("Tracing.dataCollected", (d) => events.push(...d.value));
    await cdp.send("Tracing.start", { categories: `devtools.timeline,disabled-by-default-devtools.timeline${process.env.LATENCY_TRACE_INV ? ",disabled-by-default-devtools.timeline.invalidationTracking" : ""}`, transferMode: "ReportEvents" });
  }
  await sleep(seconds * 1000);
  if (tracing) {
    const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
    await cdp.send("Tracing.end");
    await done;
    const main = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain")?.tid;
    const by = new Map();
    for (const e of events) if (e.tid === main && e.ph === "X" && ["UpdateLayoutTree", "Layout", "Paint", "PrePaint", "Layerize", "Commit"].includes(e.name)) by.set(e.name, (by.get(e.name) ?? 0) + e.dur / 1000);
    console.log("  per s:", [...by].map(([n, ms]) => `${n} ${(ms / seconds).toFixed(1)}`).join(" · "));
    // What dirtied style: the elements style recalcs started from, by class.
    const roots = new Map();
    for (const e of events) if (e.tid === main && e.name === "ScheduleStyleRecalculation") roots.set("recalc scheduled", (roots.get("recalc scheduled") ?? 0) + 1);
    for (const e of events) if (e.tid === main && (e.name === "LayoutInvalidationTracking" || e.name === "StyleRecalcInvalidationTracking" || e.name === "StyleInvalidatorInvalidationTracking")) {
      const d = e.args?.data ?? {};
      const k = `${e.name}: ${d.nodeName ?? ""} ${d.reason ?? ""} ${(d.stackTrace?.[0]?.functionName ?? "")}@${(d.stackTrace?.[0]?.url ?? "").split("/").pop()}:${d.stackTrace?.[0]?.lineNumber ?? ""}`.slice(0, 140);
      roots.set(k, (roots.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...roots].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(n).padStart(6)}  ${k}`);
  }
  if (stopProfile) await stopProfile(name, seconds, "s");
  const { frames, loafs } = await win.evaluate(() => ((window.__lat.rec = false), { frames: window.__lat.frames.map(([, d]) => d), loafs: window.__lat.loafs }));
  const b = await metrics();
  const rb = await win.evaluate(() => ({ ...window.__cmdPerf.renders }));
  const procs = await app.evaluate(({ app }) => app.getAppMetrics().map((p) => ({ type: p.type, cpu: p.cpu.percentCPUUsage, mem: p.memory.workingSetSize })));
  const secs = b.Timestamp - a.Timestamp;
  const sorted = [...frames].sort((x, y) => x - y);
  const renders = Object.fromEntries(Object.entries(rb).map(([k, v]) => [k, Math.round((v - (ra[k] ?? 0)) / secs)]).filter(([, v]) => v > 0));
  const row = {
    action: name,
    "main ms/s": Math.round(((b.TaskDuration - a.TaskDuration) * 1000) / secs),
    "script ms/s": Math.round(((b.ScriptDuration - a.ScriptDuration) * 1000) / secs),
    "style+layout ms/s": Math.round(((b.RecalcStyleDuration - a.RecalcStyleDuration + b.LayoutDuration - a.LayoutDuration) * 1000) / secs),
    fps: Math.round(frames.length / secs),
    "p95 frame": Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    "worst frame": Math.round(sorted.at(-1) ?? 0),
    "loaf ms/s": Math.round(loafs.reduce((n, l) => n + l.duration, 0) / secs),
    "renderer CPU %": Math.round(procs.filter((p) => p.type === "Tab").reduce((n, p) => n + p.cpu, 0)),
    "GPU CPU %": Math.round(procs.filter((p) => p.type === "GPU").reduce((n, p) => n + p.cpu, 0)),
    "renderer MB": Math.round(procs.filter((p) => p.type === "Tab").reduce((n, p) => n + p.mem, 0) / 1024),
    "JS heap MB": Math.round((await cdp.send("Runtime.getHeapUsage")).usedSize / 1e6),
    "DOM nodes": await win.evaluate(() => document.getElementsByTagName("*").length),
    // Terminals on screen drawn by WebGL (a canvas) / by the DOM renderer (rows of spans).
    "webgl/dom": await win.evaluate(() => {
      const shown = [...document.querySelectorAll(".tile[data-pane]:not([data-hidden]) .xterm")];
      const gl = shown.filter((x) => x.querySelector("canvas")).length;
      return `${gl}/${shown.length - gl}`;
    }),
  };
  console.log(JSON.stringify(row), "renders/s:", JSON.stringify(renders));
  steadyRows.push(row);
}
const steadyRows = [];
if (process.env.LATENCY_BOARD)
  console.log(await win.evaluate(() => [...document.querySelectorAll(".tile[data-pane]")].map((t) => {
    const r = t.getBoundingClientRect();
    const x = t.querySelector(".xterm");
    return `${t.dataset.pane.slice(0, 6)} ${t.className.replace(/ui-window |tile /g, "").trim()} ${t.hasAttribute("data-hidden") ? "hidden" : ""} at ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} ${x ? (x.querySelector("canvas") ? "webgl" : "dom") : "no xterm"}`;
  }).join("\n")));
await steady("steady");
// The same agents while another workspace is shown: their terminals parse output but draw nothing.
if (AGENTS && WORKSPACES && wanted("steady (agents hidden)")) {
  await menu("workspace.next");
  await sleep(1500);
  await steady("steady (agents hidden)");
  for (let w = 0; w <= WORKSPACES; w++) {
    if (await win.evaluate((id) => !!document.querySelector(`.tile[data-pane="${id}"]`), panes[0])) break;
    await menu("workspace.next");
    await sleep(700);
  }
}

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
          // Lines joined: in a narrow window the typed text wraps.
          ready: new Function(`return () => window.__cmdTermScreen(${JSON.stringify(target)}).split("\\n").join("").includes(${JSON.stringify(typed)})`)(),
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

// Windows other than terminals: the editor, the file browser, a browser, Settings; dragging.
const frame = () => win.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
const countOf = (selector) => win.evaluate((q) => document.querySelectorAll(q).length, selector);
// Opens a path the way the palette and the file browser do: the new window is selected.
const openPath = (target) => win.evaluate(async (t) => {
  const w = await window.cmd.call("window.openTarget", { target: t });
  await window.cmd.call("window.select", { id: w.id });
  return w.id;
}, target);
const closeSelected = async () => {
  await menu("window.close");
  await sleep(700);
};
await scenario("open text", () => timed(() => openPath(path.join(project, "big.ts")), { ready: () => !!document.querySelector(".tile.sel .textwin .cm-line") }), { runs: 4, teardown: closeSelected });
if (!only || only.some((n) => n.startsWith("text "))) {
  await openPath(path.join(project, "big.ts"));
  await win.waitForSelector(".tile.sel .textwin .cm-line");
  await sleep(800);
  const lines = win.locator(".tile.sel .textwin .cm-line");
  await lines.nth(8).click();
  await win.keyboard.press("End");
  let typed = "";
  await scenario(
    "text type",
    (i) => {
      typed += "abcdefghij"[i % 10];
      return timed(() => win.keyboard.press("abcdefghij"[i % 10]), { ready: new Function(`return () => document.querySelector(".tile.sel .cm-activeLine")?.textContent.endsWith(${JSON.stringify(typed)})`)(), settleFrames: 2 });
    },
    { runs: 30 },
  );
  await scenario("text newline", () => timed(() => win.keyboard.press("Enter"), { ready: () => document.querySelector(".tile.sel .cm-activeLine")?.textContent.trim() === "", settleFrames: 2 }), { runs: 10 });
  const box = await win.locator(".tile.sel .cm-scroller").boundingBox();
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await scenario(
    "text scroll",
    (i) =>
      timed(
        async () => {
          for (let k = 0; k < 40; k++) await win.mouse.wheel(0, i % 2 ? -200 : 200), await sleep(8);
        },
        { ready: () => true, settleFrames: 12, timeout: 6000 },
      ),
    { runs: 4 },
  );
  await openPath(path.join(project, "big.ts")); // keeps it selected
  await win.keyboard.press("Meta+Z");
  await closeSelected();
}
await scenario("open files", () => timed(() => openPath(project), { ready: () => !!document.querySelector(".tile.sel [data-path]") }), { runs: 4, teardown: closeSelected });
if (!only || only.some((n) => n.startsWith("files "))) {
  await openPath(project);
  await win.waitForSelector(".tile.sel [data-path]");
  await sleep(500);
  const many = path.join(project, "many");
  await win.locator(`.tile.sel [data-path="${many}"]`).click();
  await scenario("files expand 2000", () => timed(() => win.keyboard.press("ArrowRight"), { ready: () => !!document.querySelector('.tile.sel [data-path$="item-0000.json"]'), settleFrames: 6 }), {
    runs: 4,
    teardown: async () => {
      await win.keyboard.press("ArrowLeft");
      await win.waitForFunction(() => document.querySelectorAll(".tile.sel [data-path]").length < 100);
    },
  });
  await win.keyboard.press("ArrowRight");
  await win.waitForFunction(() => document.querySelectorAll(".tile.sel [data-path]").length > 1000); // drawn in full
  await sleep(300);
  await scenario(
    "files ↓",
    () => {
      return timed(() => win.keyboard.press("ArrowDown"), { ready: () => document.querySelector(".tile.sel [data-selected]")?.dataset.path !== window.__selPath, settleFrames: 2 });
    },
    { runs: 20, setup: () => win.evaluate(() => (window.__selPath = document.querySelector(".tile.sel [data-selected]")?.dataset.path)) },
  );
  await win.keyboard.press("ArrowLeft");
  await sleep(300);
  await closeSelected();
}
await scenario("open browser", () => timed(() => menu("file.newBrowser"), { ready: () => document.querySelectorAll(".tile[data-pane]").length > window.__tiles }), {
  runs: 4,
  setup: () => win.evaluate(() => (window.__tiles = document.querySelectorAll(".tile[data-pane]").length)),
  teardown: closeSelected,
});
// Settings is a window of its own: from the menu item to its first frame on screen, timed
// in main. The first run creates it; later runs show it again after a close.
await scenario(
  "open settings",
  async () => {
    const ms = await app.evaluate(
      ({ app, BrowserWindow, Menu }) =>
        new Promise((resolve) => {
          const t0 = performance.now();
          const painted = (w) => w.webContents.executeJavaScript("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(0))))").then(() => resolve(performance.now() - t0));
          const open = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("settings.html"));
          if (open) open.once("show", () => painted(open));
          else app.once("browser-window-created", (_, w) => w.once("show", () => painted(w)));
          Menu.getApplicationMenu().getMenuItemById("app.settings").click();
          setTimeout(() => resolve(-1), 4000);
        }),
    );
    return { respond: ms, settle: ms, timedOut: ms < 0, dropped: 0, worstFrame: 0, loafs: [] };
  },
  {
    runs: 4,
    teardown: async () => {
      await app.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes("settings.html")) w.close();
      });
      await sleep(500);
    },
  },
);
// Every kind of file and every built-in widget: from the call to the window on screen
// (respond), and until its content stops changing (settle), then scrolling what scrolls.
const tilesNow = () => win.evaluate(() => (window.__tiles = document.querySelectorAll(".tile[data-pane]:not([data-closing])").length));
const tileAdded = () => document.querySelectorAll(".tile[data-pane]:not([data-closing])").length > window.__tiles;
for (const file of fs.readdirSync(path.join(project, "kinds")).sort())
  await scenario(`open ${file}`, () => timed(() => openPath(path.join(project, "kinds", file)), { ready: tileAdded, settleFrames: 30, timeout: 8000 }), { runs: 2, setup: tilesNow, teardown: closeSelected });
if (!only || only.some((o) => o.startsWith("open widget") || o === "open *")) {
  const widgets = (await call("widget.list", {})).filter((w) => w.source === "builtin");
  for (const w of widgets)
    await scenario(
      `open widget ${w.ref.replace(/^type:/, "")}`,
      () =>
        timed(
          () =>
            win.evaluate(async (ref) => {
              const w = await window.cmd.call("widget.add", { ref });
              await window.cmd.call("window.select", { id: w.id });
            }, w.ref),
          { ready: tileAdded, settleFrames: 30, timeout: 8000 },
        ),
      { runs: 2, setup: tilesNow, teardown: closeSelected },
    );
}
/** 40 wheel ticks over `selector` in the selected window, down then up on alternate runs. */
async function scrollOver(name, selector, open) {
  if (!wanted(name)) return;
  await open();
  await sleep(1200);
  const box = await win.locator(`.tile.sel ${selector}`).first().boundingBox();
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await scenario(
    name,
    (i) =>
      timed(
        async () => {
          for (let k = 0; k < 40; k++) await win.mouse.wheel(0, i % 2 ? -150 : 150), await sleep(8);
        },
        { ready: () => true, settleFrames: 12, timeout: 6000 },
      ),
    { runs: 4 },
  );
  await closeSelected();
}
await scrollOver("scroll terminal", ".xterm-screen", async () => {
  await menu("file.newTerminal");
  await sleep(800);
  const id = await sel();
  await call("pane.write", { paneId: id, data: `for i in $(seq 1 5000); do echo "\\033[3$((i % 7))mline $i\\033[0m $(printf '%.0s─' {1..50})"; done\r` });
  await sleep(2500);
});
await scrollOver("scroll markdown", ".markdown, .md, [class*=markdown]", () => openPath(path.join(project, "kinds", "long.md")));
await scrollOver("scroll json", "[class*=json], .cm-scroller", () => openPath(path.join(project, "kinds", "big.json")));
await scrollOver("scroll pdf", "[class*=pdf]", () => openPath(path.join(project, "kinds", "manual.pdf")));
await scrollOver("scroll files", ".ui-tree", async () => {
  await openPath(project);
  await win.waitForSelector(".tile.sel [data-path]");
  await win.locator(`.tile.sel [data-path="${path.join(project, "many")}"]`).click();
  await win.keyboard.press("ArrowRight");
});

// Dragging: a strip window's edge, then a canvas window by its title, 40 pointer moves a frame apart.
async function drag(handle, dx, dy) {
  const b = await win.locator(handle).first().boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + Math.min(b.height / 2, 12);
  await win.mouse.move(x, y);
  await win.mouse.down();
  for (let k = 1; k <= 40; k++) {
    await win.mouse.move(x + (dx * k) / 40, y + (dy * k) / 40);
    await frame();
  }
  await win.mouse.up();
}
await menu("view.strip");
await sleep(800);
await scenario("drag strip edge", (i) => timed(() => drag(".tile.sel .strip-resize[data-edge=right]", i % 2 ? -200 : 200, 0), { settleFrames: 20, timeout: 6000 }), { runs: 4 });
await menu("view.canvas");
await sleep(800);
await scenario("drag canvas window", (i) => timed(() => drag(".tile.sel .tile-title", i % 2 ? -300 : 300, i % 2 ? -100 : 100), { settleFrames: 20, timeout: 6000 }), { runs: 4 });
await scenario("drag canvas resize", (i) => timed(() => drag(".tile.sel .canvas-resize.resize-xy", i % 2 ? -200 : 200, i % 2 ? -120 : 120), { settleFrames: 20, timeout: 6000 }), { runs: 4 });
await menu("view.grid");
await sleep(800);

if (steadyRows.length) console.table(steadyRows);
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
