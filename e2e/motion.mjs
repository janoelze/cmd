// Motion and visual stability run (docs/37-motion.md): launches the built app
// against a throwaway core, sets up a workspace of windows and plays the moves
// that rearrange it (⌘↩, view switches, sidebars, opening and closing windows,
// resizing the app window, Spaces). While each plays, a probe in the page reads
// every window's rect, its content's rect, opacity and visibility on every
// animation frame, counts content resizes (a terminal refit, a reflow) and
// long animation frames, and the run scores what it saw:
//
//   instant    a window moved or resized over 16 px in one frame (no motion)
//   snap       one frame took over half of a move that was otherwise animated
//   desync     its size jumped while its position glided (or the other way)
//   wobble     an edge changed direction (jitter, overshoot)
//   reflows    content resized more than once during the move
//   drift      content slid inside its window (not anchored to it)
//   pops       a window on screen appeared or vanished in one frame
//   lag        resizing the app window: a window moved a frame after the window did
//   dropped    frames over 25 ms; loaf: long animation frames (> 50 ms)
//
// Moves inside the app should glide; resizing the app window should be followed
// at once (expect: "follow"), as a Mac app's content follows its window's edge.
//
// usage: pnpm build && node e2e/motion.mjs [--label NAME] [--only a,b] [--film] [--json] [--dump]
// --dump saves every scenario's raw frames to .cmd-dev/motion/frames-<scenario>.json.
// --film saves a screencast per scenario to .cmd-dev/motion/<scenario>.mp4 (needs ffmpeg).
// Results are appended to .cmd-dev/motion/results.jsonl.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { _electron as electron } from "playwright";
import { corePid, stopCore } from "../scripts/stop-core.mjs";

const root = path.resolve(import.meta.dirname, "..");
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : "");
const label = arg("--label");
const only = arg("--only") ? arg("--only").split(",") : null;
const film = process.argv.includes("--film");
const outDir = path.join(root, ".cmd-dev", "motion");
const home = path.join(root, ".cmd-dev", "motion-e2e");
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
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ "search.enabled": false }));
const fixture = path.join(home, "files");
fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(fixture, `file-${String(i).padStart(2, "0")}.txt`), "x\n".repeat(i));
fs.writeFileSync(path.join(fixture, "README.md"), `# Motion\n\n${"A paragraph of text that wraps across the window, so a reflow shows. ".repeat(12)}\n\n## More\n\n${"- an item\n".repeat(20)}`);
fs.writeFileSync(path.join(fixture, "notes.txt"), Array.from({ length: 80 }, (_, i) => `${i} the quick brown fox jumps over the lazy dog `.repeat(3)).join("\n"));
const space2 = path.join(home, "space-two");
fs.mkdirSync(space2, { recursive: true });

const require = createRequire(path.join(root, "apps/desktop/package.json"));
const app = await electron.launch({
  executablePath: require("electron"),
  args: [path.join(root, "apps/desktop")],
  env: { ...process.env, CMD_HOME: home, CMD_NO_SANDBOX: "1", CMD_BACKGROUND: process.env.E2E_VISIBLE ? "" : "1", CMD_TRANSCRIPTS_HOME: path.join(home, "transcripts-home") },
});
const win = await app.firstWindow();
win.on("pageerror", (e) => console.log("pageerror:", e.message));
if (process.env.MOTION_DEBUG) win.on("console", (m) => m.text().startsWith("[") && console.log(m.text()));
await win.waitForSelector(".statusbar .core-status");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const menu = (id) =>
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`no menu item ${id}`);
    item.click();
  }, id);
const call = (method, params = {}) => win.evaluate(([m, p]) => window.cmd.call(m, p), [method, params]);
const setSize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
const tiles = () => win.evaluate(() => [...document.querySelectorAll(".windows-track > .tile")].map((t) => t.dataset.pane));
const selectNth = (i) => win.evaluate((i) => {
  const ids = [...document.querySelectorAll(".windows-track > .tile")].sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return ra.top - rb.top || ra.left - rb.left;
  }).map((t) => t.dataset.pane);
  window.__cmdSelect(ids[i]);
}, i);
const docks = () => win.evaluate(() => ({ left: !!document.querySelector(".dock-left"), right: !!document.querySelector(".dock-right") }));
async function waitTiles(n) {
  for (let i = 0; i < 50 && (await tiles()).length !== n; i++) await sleep(100);
}

await setSize(1440, 900);
// First launch shows onboarding: past it, so it doesn't cover the windows.
if (await win.waitForSelector(".onboarding", { timeout: 3000 }).catch(() => null)) {
  await win.locator(".onboarding button", { hasText: "Get Started" }).click();
  await win.locator(".onboarding button", { hasText: "Set Up Later" }).click();
  await win.waitForSelector(".onboarding", { state: "detached" });
}
await sleep(300);

// ── the probe ────────────────────────────────────────────
await win.evaluate(() => {
  const w = window;
  let rec = null;
  const ro = new ResizeObserver((entries) => {
    if (!rec) return;
    for (const e of entries) {
      const id = e.target.closest(".tile")?.dataset.pane ?? "?";
      rec.reflows[id] = (rec.reflows[id] ?? 0) + 1;
    }
  });
  const observed = new WeakSet();
  const contentOf = (t) => {
    const body = t.querySelector(":scope > .tile-body");
    return body?.lastElementChild ?? body;
  };
  // Sampled just after each frame is painted (a task posted from its rAF callback), so it
  // reads what was on screen: in the rAF callback itself, layout reflects work that
  // ResizeObservers redo before that frame paints.
  const after = new MessageChannel();
  after.port1.onmessage = (e) => sample(e.data);
  const tick = (now) => rec && after.port2.postMessage({ now, w: innerWidth, h: innerHeight });
  const sample = ({ now, w, h }) => {
    if (!rec) return;
    // The app window was resized after this frame was painted: what layout says now was
    // never on screen (the next frame lays it out). Skip it.
    if (w !== innerWidth || h !== innerHeight) return void requestAnimationFrame(tick);
    const view = document.querySelector(".main.windows")?.getBoundingClientRect();
    const frame = { t: now, vp: view ? [view.left, view.top, view.width, view.height] : null, tiles: {} };
    // The workspace's windows, and the sidebars (keyed by their side).
    const els = [...document.querySelectorAll(".windows-track > .tile[data-pane]")].map((t) => [t.dataset.pane, t]);
    // Sidebars by their window too: a window moving to or from one is one window moving.
    for (const d of document.querySelectorAll(".stage > .dock > .tile[data-pane]")) els.push([d.dataset.pane, d]);
    for (const [key, t] of els) {
      const r = t.getBoundingClientRect();
      const c = contentOf(t);
      const cr = c?.getBoundingClientRect();
      if (c && !observed.has(c)) observed.add(c), ro.observe(c);
      const cs = getComputedStyle(t);
      // A terminal's screen inside its content: where its text is drawn.
      const scr = t.querySelector(".xterm-screen")?.getBoundingClientRect();
      const vpEl = t.querySelector(".xterm-viewport");
      frame.tiles[key] = {
        x: scr ? [scr.left, scr.top, scr.width, scr.height, vpEl?.scrollTop ?? 0] : null,
        r: [r.left, r.top, r.width, r.height],
        // Screen px per CSS px (a zoomed canvas, a window scaled while it glides).
        k: r.width / Math.max(1, t.offsetWidth),
        dock: !!t.closest(".dock"),
        c: cr ? [cr.left, cr.top, cr.width, cr.height] : null,
        // What you see: hidden, or as opaque as the window and the track over it.
        o: cs.visibility === "hidden" ? 0 : +cs.opacity,
      };
    }
    // Closed windows fading out where they were (motion.ts ghost).
    frame.ghosts = document.querySelectorAll(".ghost-tile").length;
    // The workspace under a View Transition (switching Spaces): what's seen is its crossfade, not the DOM.
    frame.vt = !!document.querySelector(".stage:active-view-transition");
    rec.frames.push(frame);
    requestAnimationFrame(tick);
  };
  let loaf = [];
  try {
    new PerformanceObserver((l) => rec && loaf.push(...l.getEntries().map((e) => ({
      start: e.startTime, dur: e.duration, block: e.blockingDuration,
      // What took the time: the longest scripts, and the frame's style and layout.
      scripts: [...e.scripts].sort((a, b) => b.duration - a.duration).slice(0, 3).map((s) => `${Math.round(s.duration)}ms ${s.invoker} ${s.sourceFunctionName || ""} ${(s.sourceURL || "").split("/").pop()}:${s.sourceCharPosition}`),
      layout: Math.round(e.startTime + e.duration - (e.styleAndLayoutStart || e.startTime)),
      // Before rendering began: tasks, rAF callbacks, observers.
      work: Math.round((e.renderStart || e.startTime + e.duration) - e.startTime),
      render: Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0),
    })))).observe({ type: "long-animation-frame" });
  } catch {}
  w.__motion = {
    start() {
      loaf = [];
      rec = { frames: [], reflows: {}, loaf };
      // Content resizes from before the move are reported on the next frame: ignore that first batch.
      for (const t of document.querySelectorAll(".windows-track > .tile[data-pane]")) {
        const c = contentOf(t);
        if (c && !observed.has(c)) observed.add(c), ro.observe(c);
      }
      requestAnimationFrame((now) => {
        if (rec) rec.reflows = {};
        tick(now);
      });
    },
    stop() {
      const r = rec;
      rec = null;
      return r;
    },
  };
});

// ── analysis ─────────────────────────────────────────────
/** The area windows and sidebars are seen in: the workspace and the sidebars' columns (the app window's width). */
const document_stage = (frames) => {
  const vp = frames.find((f) => f.vp)?.vp;
  return vp && [0, vp[1], Math.max(...frames.filter((f) => f.vp).map((f) => f.vp[0] + f.vp[2])), vp[3]];
};
const STEP_MIN = 16; // px: a change this big in one frame is a jump, not motion
function analyse(rec, { expect = "glide", reversals: allowed = 0 } = {}) {
  const frames = rec.frames;
  const ids = [...new Set(frames.flatMap((f) => Object.keys(f.tiles)))];
  const issues = [];
  const add = (kind, id, detail) => issues.push({ kind, id: id.slice(-6), detail });
  let moving = 0;
  let lastMove = 0;
  for (const id of ids) {
    const seq = frames.map((f) => ({ t: f.t, s: f.tiles[id] })).filter((x) => x.s);
    if (seq.length < 2) continue;
    const vis = (s) => s.o > 0.01;
    // Geometry only counts while visible (a hidden window may move freely).
    const shown = seq.filter((x) => vis(x.s));
    const q = {
      left: (s) => s.r[0], top: (s) => s.r[1], right: (s) => s.r[0] + s.r[2], bottom: (s) => s.r[1] + s.r[3],
      width: (s) => s.r[2], height: (s) => s.r[3],
    };
    const motionOf = (name) => {
      const v = shown.map((x) => q[name](x.s));
      if (v.length < 2) return null;
      const travel = Math.abs(v.at(-1) - v[0]);
      const steps = v.slice(1).map((x, i) => x - v[i]);
      const moved = steps.filter((d) => Math.abs(d) > 0.25);
      if (!moved.length) return null;
      const maxStep = Math.max(...steps.map(Math.abs));
      const path = steps.reduce((a, d) => a + Math.abs(d), 0);
      let reversals = 0;
      let dir = 0;
      for (const d of steps) {
        // Under a pixel is rounding (two glides adding up), not a change of direction.
        if (Math.abs(d) < 1) continue;
        const s = Math.sign(d);
        if (dir && s !== dir) reversals++;
        dir = s;
      }
      const first = steps.findIndex((d) => Math.abs(d) > 0.25);
      const last = steps.length - 1 - [...steps].reverse().findIndex((d) => Math.abs(d) > 0.25);
      const span = shown[last + 1].t - shown[first].t;
      lastMove = Math.max(lastMove, shown[last + 1].t - frames[0].t);
      return { travel, path, maxStep, frames: moved.length, reversals, span };
    };
    const m = Object.fromEntries(Object.keys(q).map((k) => [k, motionOf(k)]));
    const any = Object.values(m).some(Boolean);
    if (any) moving++;
    for (const [name, x] of Object.entries(m)) {
      if (!x || expect === "follow") continue;
      if (x.reversals > allowed) add("wobble", id, `${name} changed direction ${x.reversals}×`);
      if (x.maxStep < STEP_MIN) continue;
      if (x.frames === 1) add("instant", id, `${name} ${Math.round(x.travel)} px in one frame`);
      else if (x.maxStep > 0.5 * x.path) add("snap", id, `${name}: ${Math.round(x.maxStep)} of ${Math.round(x.path)} px in one frame`);
    }
    const anim = (k) => m[k] && m[k].frames > 1 && m[k].maxStep <= 0.5 * m[k].path;
    const jump = (k) => m[k] && m[k].maxStep >= STEP_MIN && (m[k].frames === 1 || m[k].maxStep > 0.5 * m[k].path);
    if (expect === "follow") {
      // Each move of this window lands in a frame where the app window's size changed too.
      const vpKey = (f) => (f.vp ? `${Math.round(f.vp[2])}x${Math.round(f.vp[3])}` : "");
      let late = 0;
      for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1].tiles[id];
        const b = frames[i].tiles[id];
        if (!a || !b || !vis(b)) continue;
        const movedNow = a.r.some((v, j) => Math.abs(v - b.r[j]) > 0.5);
        if (movedNow && vpKey(frames[i]) === vpKey(frames[i - 1])) late++;
      }
      if (late) add("lag", id, `moved in ${late} frame(s) after the app window did`);
    }
    if ((anim("left") || anim("top")) && (jump("width") || jump("height")) && !(jump("left") || jump("top")))
      add("desync", id, "size jumped while position glided");
    // Content anchored to its window: its offset from the window's top-left stays put.
    // Within one element: a sidebar lays its window's content out its own way.
    const where = shown.at(-1)?.s.dock;
    const offs = shown.filter((x) => x.s.c && x.s.dock === where).map((x) => [(x.s.c[0] - x.s.r[0]) / x.s.k, (x.s.c[1] - x.s.r[1]) / x.s.k]);
    if (offs.length > 1) {
      const drift = Math.max(...offs.map((o) => Math.hypot(o[0] - offs[0][0], o[1] - offs[0][1])));
      if (drift > 1) add("drift", id, `content slid ${Math.round(drift)} px inside its window`);
    }
    // Appearing or vanishing in one frame while on screen (faded, added or removed).
    const stage = document_stage(frames);
    const onScreen = (s, o = 0.01) => stage && s.o > o && s.r[0] < stage[0] + stage[2] - 1 && s.r[0] + s.r[2] > stage[0] + 1 && s.r[2] > 0;
    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1].s;
      const b = seq[i].s;
      if (Math.abs(b.o - a.o) > 0.6 && (onScreen(a) || onScreen(b))) add("pop", id, b.o > a.o ? "appeared in one frame" : "vanished in one frame");
    }
    const at = frames.findIndex((f) => f.tiles[id]);
    const gone = frames.findLastIndex((f) => f.tiles[id]);
    // Mostly opaque on its first or last frame: not faded or slid in or out.
    if (at > 0 && onScreen(frames[at].tiles[id], 0.5) && !frames[at].vt) add("pop", id, "added on screen at once");
    // A closed window leaves a ghost that fades out in its place.
    if (gone < frames.length - 1 && onScreen(frames[gone].tiles[id], 0.5) && !frames[gone + 1].ghosts && !frames[gone + 1].vt) add("pop", id, "removed from screen at once");
    const n = rec.reflows[id] ?? 0;
    if (n > 1) add("reflows", id, `content resized ${n}×`);
  }
  const iv = frames.slice(1).map((f, i) => f.t - frames[i].t);
  const busy = iv.slice(0, Math.max(1, Math.ceil(lastMove / 16.7) + 2));
  const count = (k) => issues.filter((i) => i.kind === k).length;
  return {
    windows: ids.length,
    moving,
    "motion ms": Math.round(lastMove),
    dropped: busy.filter((x) => x > 25).length,
    "worst frame": Math.round(Math.max(0, ...busy)),
    loaf: rec.loaf.filter((l) => l.start >= frames[0].t).length,
    instant: count("instant"),
    snap: count("snap"),
    desync: count("desync"),
    wobble: count("wobble"),
    reflows: Object.values(rec.reflows).reduce((a, b) => a + b, 0),
    drift: count("drift"),
    pops: count("pop"),
    lag: count("lag"),
    issues,
  };
}

// ── scenarios ────────────────────────────────────────────
const results = [];
const cdp = film ? await win.context().newCDPSession(win) : null;
async function scenario(name, act, { settle = 700, ...expect } = {}) {
  if (only && !only.some((o) => name.includes(o))) {
    await act(); // keep the state the later scenarios expect
    await sleep(settle);
    return;
  }
  await sleep(150);
  let shots = [];
  if (cdp) {
    shots = [];
    cdp.on("Page.screencastFrame", async (f) => {
      shots.push(f.data);
      await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
    await sleep(100);
  }
  await win.evaluate(() => window.__motion.start());
  await sleep(50);
  await act();
  await sleep(settle);
  const rec = await win.evaluate(() => window.__motion.stop());
  if (cdp) {
    await cdp.send("Page.stopScreencast");
    cdp.removeAllListeners("Page.screencastFrame");
    const dir = path.join(outDir, "film", name.replace(/[^a-z0-9]+/gi, "-"));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    shots.forEach((d, i) => fs.writeFileSync(path.join(dir, `${String(i).padStart(4, "0")}.jpg`), Buffer.from(d, "base64")));
    spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "30", "-i", path.join(dir, "%04d.jpg"), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", `${dir}.mp4`]);
  }
  const a = analyse(rec, expect);
  if (process.argv.includes("--dump")) fs.writeFileSync(path.join(outDir, `frames-${name.replace(/[^a-z0-9]+/gi, "-")}.json`), JSON.stringify(rec));
  results.push({ name, ...a });
  const flag = a.instant + a.snap + a.desync + a.wobble + a.drift + a.pops + a.lag ? "✗" : "✓";
  console.log(`${flag} ${name}`);
  for (const i of a.issues.slice(0, 8)) console.log(`    ${i.kind.padEnd(8)} ${i.id}  ${i.detail}`);
  for (const l of rec.loaf.filter((l) => l.start >= rec.frames[0]?.t)) console.log(`    loaf     ${Math.round(l.dur)} ms (work ${l.work}, render ${l.render}, style+layout ${l.layout} ms) ${l.scripts.join(" · ")}`);
  if (a.issues.length > 8) console.log(`    … ${a.issues.length - 8} more`);
}

// A workspace of four windows: a terminal when terminals can start here, else a text window,
// and a text window, a file browser and a Markdown preview, side by side in the grid.
await menu("view.grid");
await call("window.open", { kind: "files", input: { path: fixture } });
await call("window.openTarget", { target: path.join(fixture, "README.md") });
await call("window.openTarget", { target: path.join(fixture, "notes.txt") });
await menu("file.newTerminal").catch(() => {});
await sleep(800);
if ((await tiles()).length < 4) await menu("file.newText");
await waitTiles(4);
console.log(`workspace: ${(await tiles()).length} windows, ${(await call("pane.list")).length} terminal(s)`);
const startDocks = await docks();
if (startDocks.right) await menu("view.rightSidebar"), await sleep(400);
if (!startDocks.left) await menu("view.sidebar"), await sleep(400);
await selectNth(3);
await sleep(600);

await scenario("grid → focus (⌘↩)", () => menu("view.toggleFocus"));
await scenario("focus → grid (⌘↩)", () => menu("view.toggleFocus"));
// Interrupted halfway: the window turns back, carrying its speed (one change of direction).
await scenario("⌘↩ twice quickly", async () => (await menu("view.toggleFocus"), await sleep(90), await menu("view.toggleFocus")), { reversals: 1 });
await scenario("grid → strip", () => menu("view.strip"));
await scenario("strip: next window", () => menu("session.next"));
await scenario("strip → grid", () => menu("view.grid"));
await scenario("grid → canvas", () => menu("view.canvas"), { settle: 900 });
await scenario("canvas → grid", () => menu("view.grid"), { settle: 900 });
await scenario("hide left sidebar", () => menu("view.sidebar"));
await scenario("show left sidebar", () => menu("view.sidebar"));
await selectNth(0);
await scenario("move a window to the right sidebar", () => menu("window.dockRight"));
await scenario("hide right sidebar", () => menu("view.rightSidebar"));
await scenario("show right sidebar", () => menu("view.rightSidebar"));
await scenario("move it back to the workspace", () => menu("window.undock"));
await scenario("open a window (grid)", () => menu("file.newText"));
const newest = await call("window.list").then((l) => l.filter((w) => w.kind === "text").sort((a, b) => b.createdAt - a.createdAt)[0]);
await scenario("close a window (grid)", () => call("window.close", { id: newest.id }));
await scenario("app window: one step smaller", () => setSize(1200, 800), { expect: "follow" });
await scenario("app window: live resize", async () => {
  for (let i = 1; i <= 20; i++) await setSize(1200 + i * 12, 800 + i * 5), await sleep(16);
}, { expect: "follow" });
// Font size (⌘+ / ⌘−) with a terminal selected, in the workspace and then in a sidebar.
const terminal = async () => win.evaluate(() => {
  const t = document.querySelector(".tile.kind-terminal[data-pane]");
  window.__cmdSelect(t.dataset.pane);
  return t.dataset.pane;
});
await terminal();
await sleep(300);
await scenario("⌘+ bigger text", () => menu("view.zoomIn"));
await scenario("⌘− smaller text", () => menu("view.zoomOut"));
await menu("window.dockRight");
await sleep(600);
await terminal();
await sleep(300);
await scenario("⌘+ bigger text (terminal in a sidebar)", () => menu("view.zoomIn"));
await scenario("⌘− smaller text (terminal in a sidebar)", () => menu("view.zoomOut"));
await menu("window.undock");
await sleep(600);
// The same, and a window made wider or narrower (⌥⌘+ / ⌥⌘−), in the strip and on the canvas.
for (const mode of ["strip", "canvas"]) {
  await menu(`view.${mode}`);
  await sleep(700);
  await terminal();
  await sleep(500);
  await scenario(`⌘+ bigger text (${mode})`, () => menu("view.zoomIn"));
  await scenario(`⌘− smaller text (${mode})`, () => menu("view.zoomOut"));
  if (mode === "strip") {
    await scenario("⌥⌘+ wider window (strip)", () => menu("view.widen"));
    await scenario("⌥⌘− narrower window (strip)", () => menu("view.narrow"));
    // Interrupted: the scroll turns back to show the window as it keeps growing (one change of direction).
    await scenario("⌥⌘+ wider, twice quickly (strip)", async () => (await menu("view.widen"), await sleep(80), await menu("view.widen")), { reversals: 1 });
    await scenario("⌥⌘− narrower, twice quickly (strip)", async () => (await menu("view.narrow"), await sleep(80), await menu("view.narrow")), { reversals: 1 });
  }
}
await menu("view.grid");
await sleep(700);
await terminal();
await sleep(300);
await scenario("⌥⌘+ wider window (from grid)", () => menu("view.widen"));
await menu("view.grid");
await sleep(700);
await call("space.open", { path: space2, show: false });
await sleep(300);
await scenario("next Space", () => menu("space.next"), { settle: 900 });
await scenario("previous Space", () => menu("space.prev"), { settle: 900 });

// ── report ───────────────────────────────────────────────
const cols = ["motion ms", "dropped", "worst frame", "loaf", "instant", "snap", "desync", "wobble", "reflows", "drift", "pops", "lag"];
console.log(`\nmotion${label ? ` (${label})` : ""}`);
console.table(Object.fromEntries(results.map((r) => [r.name, Object.fromEntries(cols.map((c) => [c, r[c]]))])));
const total = (k) => results.reduce((a, r) => a + r[k], 0);
console.log(`issues: instant ${total("instant")}, snap ${total("snap")}, desync ${total("desync")}, wobble ${total("wobble")}, drift ${total("drift")}, pops ${total("pops")}, lag ${total("lag")}; content resizes ${total("reflows")}; dropped frames ${total("dropped")}`);
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const at = new Date().toISOString();
fs.appendFileSync(path.join(outDir, "results.jsonl"), results.map((r) => JSON.stringify({ at, commit, label, ...r })).join("\n") + "\n");
if (process.argv.includes("--json")) fs.writeFileSync(path.join(outDir, `last${label ? `-${label}` : ""}.json`), JSON.stringify(results, null, 2));
// app.close() can wait on the core: don't let it hold the run.
await Promise.race([app.close(), sleep(3000)]);
process.exit(0);
