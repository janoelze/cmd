// Experiment: is scrolling smooth inside the app? Logs the strip's scrollLeft
// on every rendered frame (requestAnimationFrame) while the helper plays a real
// sideways swipe, then reports frame times and per-frame movement. Real input:
// the pointer moves. usage: node experiments/scroll-smooth.mjs [px]
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright";
import { Tour } from "../src/driver.ts";
import { fixtureEnv, makeFixture } from "../src/fixture.ts";
import { Helper } from "../src/helper.ts";
import { applyKai } from "../src/persona.ts";
import { planScroll, SCROLL } from "../src/scroll.ts";

const px = Number(process.argv[2] ?? 800);
/** Wheel events per second the helper posts (a real trackpad: about 60–120). */
const hz = Number(process.argv[3] ?? 120);
/** Where the pointer is while swiping, as a share of the window's width. */
const where = Number(process.argv[4] ?? 0.6);
/** "norec": don't record (does recording cause the dropped frames?). */
const record = process.argv[5] !== "norec";
const root = path.resolve(import.meta.dirname, "../../..");
const f = makeFixture("/private/tmp/cmd-tours/scroll-smooth");
applyKai(f);
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const app = await electron.launch({ executablePath: require("electron"), args: [path.join(root, "apps/desktop")], env: fixtureEnv(f) });
const helper = Helper.start();
try {
  const page = await app.firstWindow();
  await page.waitForSelector(".statusbar .core-status");
  console.log("display:", await app.evaluate(({ BrowserWindow, app, screen }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const d = [...screen.getAllDisplays()].sort((a, b) => b.scaleFactor - a.scaleFactor || b.displayFrequency - a.displayFrequency)[0];
    w.setContentSize(1280, 800);
    const [ow, oh] = w.getSize();
    w.setPosition(Math.round(d.workArea.x + (d.workArea.width - ow) / 2), Math.round(d.workArea.y + (d.workArea.height - oh) / 2));
    app.focus({ steal: true });
    w.focus();
    return `${d.scaleFactor}× ${d.displayFrequency} Hz`;
  }));
  const t = new Tour(app, page, helper, 1);
  for (const id of ["file.newTerminal", "file.newFiles", "file.newText", "file.newFiles", "file.newTerminal"]) {
    await t.command(id);
    await t.pause(500);
  }
  await t.command("view.strip");
  const main = page.getByRole("main");
  await t.pause(1500); // the strip fills up (and overflows) after the windows open
  console.log("debug:", await main.evaluate((m) => ({ groups: m.querySelectorAll('[role="group"][aria-label]').length, scrollers: [m, ...m.querySelectorAll("*")].filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowX)).map((el) => `${el.className} ${el.scrollWidth}/${el.clientWidth}`) })));
  await t.scrollToStart(main);
  await t.pause(800);
  await t.parkInWindow(where, 0.5);
  console.log("pointer over:", await page.evaluate(([fx]) => { const el = document.elementFromPoint(innerWidth * fx, innerHeight * 0.5); return `${el?.tagName}.${el?.className} in ${el?.closest('[role="group"]')?.getAttribute("aria-label")}`; }, [where]));
  // A frame logger on the strip's scroller.
  await main.evaluate((m) => {
    const sc = [m, ...m.querySelectorAll("*")].find((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1);
    const log = (globalThis.__scrollLog = []);
    const tick = (ts) => {
      log.push([ts, sc.scrollLeft]);
      if (log.length < 2000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    sc.addEventListener("wheel", (e) => log.push(["wheel", e.timeStamp, e.deltaX]), { passive: true, capture: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) log.push(["long", e.startTime, e.duration]); }).observe({ type: "longtask", buffered: false });
  });
  const rect = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const out = "/private/tmp/cmd-tours/scroll-smooth/raw.mov";
  const started = record ? await helper.call("record-start", { pid: app.process().pid, out, rect: [rect.x, rect.y, rect.width, rect.height] }) : null;
  await t.pause(300);
  const steps = planScroll(px, { ...SCROLL, hz });
  const at = await helper.call("pointer");
  await helper.call("scroll", { x: at.x, y: at.y, axis: "x", steps: steps.map((s) => [s.t, s.d, s.phase]) });
  console.log(`posted ${steps.length} wheel events at ${hz} Hz`);
  await t.pause(600);
  if (record) {
  const stopped = await helper.call("record-stop");
  console.log(`recorded at ${started.fps} fps: ${stopped.frames} frames over ${((stopped.t1 - stopped.t0) / 1e9).toFixed(2)} s`);
  const pts = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "frame=pts_time", "-of", "csv=p=0", out], { encoding: "utf8" })
    .split("\n").map((l) => parseFloat(l)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  const gaps = pts.slice(1).map((p, i) => (p - pts[i]) * 1000);
  const ghist = Object.entries(gaps.reduce((m, x) => ((m[x.toFixed(1)] = (m[x.toFixed(1)] ?? 0) + 1), m), {})).sort((p, q) => q[1] - p[1]).slice(0, 6);
  console.log("captured frame gaps ms:", ghist);
  // What a 60 fps video gets: for each output frame, the newest captured frame at that time; repeats are hitches.
  const outFrames = Math.floor((pts.at(-1) - pts[0]) * 60);
  let repeats = 0, prev = -1;
  for (let k = 0; k < outFrames; k++) {
    const t = pts[0] + k / 60;
    let j = pts.findIndex((p) => p > t + 1e-6) - 1;
    if (j < 0) j = pts.length - 1;
    if (j === prev) repeats++;
    prev = j;
  }
  console.log(`60 fps output: ${outFrames} frames, ${repeats} repeat the one before (while anything moves that's a hitch)`);
  }
  const log = await page.evaluate(() => globalThis.__scrollLog);
  const frames = log.filter((r) => typeof r[0] === "number");
  const wheels = log.filter((r) => r[0] === "wheel");
  const moving = frames.filter((r, i) => i > 0 && r[1] !== frames[i - 1][1]);
  const first = frames.indexOf(moving[0]) - 1;
  const last = frames.indexOf(moving[moving.length - 1]);
  const span = frames.slice(first, last + 1);
  const dts = span.slice(1).map((r, i) => r[0] - span[i][0]);
  const dxs = span.slice(1).map((r, i) => r[1] - span[i][1]);
  const hist = (a) => Object.entries(a.reduce((m, x) => ((m[Math.round(x)] = (m[Math.round(x)] ?? 0) + 1), m), {})).sort((p, q) => q[1] - p[1]).slice(0, 8);
  console.log(`swipe ${px}: moved ${span.at(-1)[1] - span[0][1]} px over ${(span.at(-1)[0] - span[0][0]).toFixed(0)} ms in ${dts.length} frames`);
  console.log("frame interval ms (rounded: count):", hist(dts));
  console.log("frames that didn't move mid-swipe:", dxs.filter((d) => d === 0).length);
  // Hitches: a still frame between moving ones (> 3 px), or a frame moving 1.6× its neighbours.
  const hitches = dxs.filter((d, i) => i > 0 && i < dxs.length - 1 && (Math.abs(dxs[i - 1]) > 3 && Math.abs(dxs[i + 1]) > 3 && (d === 0 || Math.abs(d) > 1.6 * (Math.abs(dxs[i - 1]) + Math.abs(dxs[i + 1])) / 2))).length;
  console.log(`hitches in the app (still or doubled frames mid-motion): ${hitches}`);
  const longs = log.filter((r) => r[0] === "long" && r[1] >= span[0][0] && r[1] <= span.at(-1)[0]);
  console.log(`long main-thread tasks during it: ${longs.length}, ${longs.map((l) => Math.round(l[2])).join(" ")} ms`);
  console.log("per-frame px (all):", dxs.map((d) => Math.round(d * 10) / 10).join(" "));
  console.log(`wheel events seen by the page: ${wheels.length}, deltaX sum ${wheels.reduce((s, w) => s + w[2], 0).toFixed(0)}`);
  const wgaps = wheels.slice(1).map((w, i) => w[1] - wheels[i][1]);
  console.log("wheel event interval ms:", hist(wgaps));
} finally {
  await helper.call("release").catch(() => {});
  helper.close();
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 4000))]);
  try { execFileSync(process.execPath, [path.join(root, "scripts/stop-core.mjs"), "--terminals"], { env: { ...process.env, CMD_HOME: f.cmdHome }, stdio: "ignore" }); } catch {}
}
process.exit(0);
