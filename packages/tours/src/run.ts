// Runs a tour: node packages/tours/src/run.ts <file.tour.ts> [--out dir] [--seed n]
// Launches the built app (pnpm build) in a fixture, places its window, runs the
// tour's unrecorded setup, then records the window while the tour plays.
// Writes raw.mov (no cursor), events.json (the input, on the frames' clock) and
// meta.json (crop on screen, scale, first frame), window.png (the window with
// its shadow) and cursors/ (the real cursor shapes), then tour.mp4 (post.ts).
// The Mac must be left
// alone while it runs: moving the mouse stops it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "playwright";
import { Tour } from "./driver.ts";
import { addAiKeys, fixtureEnv, makeFixture } from "./fixture.ts";
import { Helper } from "./helper.ts";
import { applyKai } from "./persona.ts";
import { render, type PostOptions } from "./post.ts";

export interface TourMeta {
  /** Window content size, points. */
  size?: [number, number];
  /** Files in the fixture home (path → content; a path ending in / is a folder). */
  files?: Record<string, string>;
  settings?: Record<string, unknown>;
  /** Whose Mac it is: Kai (persona.ts, the default: prompt, repos, notes, past sessions), or "none" for a bare home. */
  persona?: "kai" | "none";
  /** Needs a model (a Magic build): the person's AI key goes into the fixture for the run (see fixture.ts). Costs a little per run. */
  ai?: boolean;
  /** How post renders this tour (e.g. `{ idle: 4 }`: waiting sped up). */
  post?: PostOptions;
  /** Unrecorded: get the app into the state the video starts in. */
  setup?: (t: Tour) => Promise<void>;
}

export interface TourModule {
  default: (t: Tour) => Promise<void>;
  meta?: TourMeta;
}

const root = path.resolve(import.meta.dirname, "..", "..", "..");
/** Where fixtures live while a tour runs (its core's state and logs too: <FIXTURES>/<tour>/logs). */
export const FIXTURES = "/private/tmp/cmd-tours";

export async function runTour(file: string, out: string, seed = 1): Promise<TourMeta> {
  const mod = (await import(pathToFileURL(path.resolve(file)).href)) as TourModule;
  const meta = mod.meta ?? {};
  const name = path.basename(file).replace(/\.tour\.ts$|\.ts$/, "");
  fs.mkdirSync(out, { recursive: true });
  // Outside the person's home and any repository: Claude Code prints absolute paths now and
  // then, and git would find the repository a fixture sits in.
  const fixture = makeFixture(path.join(FIXTURES, name), meta.files, meta.settings);
  if ((meta.persona ?? "kai") === "kai") applyKai(fixture);
  const ai = meta.ai ? addAiKeys(fixture) : null;
  const helper = Helper.start();
  const require = createRequire(path.join(root, "apps/desktop/package.json"));
  const app = await electron.launch({ executablePath: require("electron") as unknown as string, args: [path.join(root, "apps/desktop")], env: fixtureEnv(fixture, ai?.env) });
  let recording = false;
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".statusbar .core-status");
    const [w, h] = meta.size ?? [1280, 800];
    await app.evaluate(({ BrowserWindow, app }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      win.setContentSize(w!, h!);
      win.center();
      app.focus({ steal: true });
      win.focus();
    }, [w, h]);
    // cmd's hook in the fixture's Claude Code, so the sidebar follows its sessions.
    if (ai?.env.ANTHROPIC_API_KEY) await page.evaluate((file) => (window as unknown as { cmd: { call: (m: string, p: unknown) => Promise<unknown> } }).cmd.call("hooks.install", { file }), path.join(fixture.home, ".claude", "settings.json"));
    const tour = new Tour(app, page, helper, seed);
    await page.waitForTimeout(400);
    if (meta.setup) await meta.setup(tour);
    await tour.parkInWindow();
    const rect = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
    // The window alone, with its real shadow: post's frame and mask (post.ts).
    const still = await helper.call("window-still", { pid: app.process().pid, out: path.join(out, "window.png") });
    fs.rmSync(path.join(out, "cursors"), { recursive: true, force: true });
    const started = await helper.call("record-start", { pid: app.process().pid, out: path.join(out, "raw.mov"), rect: [rect.x, rect.y, rect.width, rect.height], cursors: path.join(out, "cursors") });
    recording = true;
    await page.waitForTimeout(500);
    await mod.default(tour);
    await page.waitForTimeout(800);
    const stopped = await helper.call("record-stop");
    recording = false;
    const { events } = await helper.call("log");
    fs.writeFileSync(path.join(out, "events.json"), JSON.stringify(events));
    fs.writeFileSync(path.join(out, "meta.json"), JSON.stringify({ name, seed, rect, scale: started.scale, width: started.width, height: started.height, t0: stopped.t0, t1: stopped.t1, frames: stopped.frames, still: { frame: still.frame, size: still.size } }, null, 1));
    console.log(`${name}: ${stopped.frames} frames, ${(((stopped.t1 as number) - (stopped.t0 as number)) / 1e9).toFixed(1)} s → ${out}`);
    return meta;
  } finally {
    if (recording) await helper.call("record-stop").catch(() => {});
    await helper.call("release").catch(() => {});
    helper.close();
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]);
    try {
      execFileSync(process.execPath, [path.join(root, "scripts/stop-core.mjs"), "--terminals"], { env: { ...process.env, CMD_HOME: fixture.cmdHome }, stdio: "ignore" });
    } catch {}
    // The key doesn't outlive the run.
    if (ai) fs.rmSync(ai.secrets, { force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.log("usage: node packages/tours/src/run.ts <file.tour.ts> [--out dir] [--seed n]");
    process.exit(2);
  }
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = opt("--out") ?? path.join(root, ".cmd-dev", "tours", "out", path.basename(file).replace(/\.tour\.ts$|\.ts$/, ""));
  try {
    const meta = await runTour(file, path.resolve(out), Number(opt("--seed") ?? 1));
    console.log(render(path.resolve(out), meta.post));
    process.exit(0);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
