// The Workbench (apps/desktop/src/renderer/workbench.html): one component from
// a *.story.tsx file in the real app (styles, SF Symbols, preload, core), with
// HMR. It runs on its own instance (.cmd-dev/workbench, or $CMD_WORKBENCH_HOME)
// and exposes the DevTools protocol, so these commands drive the open window:
//   pnpm workbench [story]                        start it (stays in the foreground)
//   pnpm workbench goto <story> [variant] [--theme id]   show that in the window
//   pnpm workbench shot [story] [variant] [--theme id] [--out file.png] [--window]
// Shots crop to the component (a dialog, else what the stage shows) with a margin:
// the window is yours to size and move, so its size and display vary. They are
// always 2x: the window is emulated at 2x for the shot (SF Symbols re-render), then restored.
//   pnpm workbench matrix <story> [--themes a,b,c]   every variant × themes, into .cmd-dev/shots/wb
//   pnpm workbench eval '<js>'                    run JS in the window (await works), print the result
//   pnpm workbench stop                           quit it, its core and PTY host
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { stopCore } from "./stop-core.mjs";

const root = path.resolve(import.meta.dirname, "..");
const home = path.resolve(
  process.env.CMD_WORKBENCH_HOME ?? path.join(root, ".cmd-dev", "workbench"),
);
const stateFile = path.join(home, "workbench.json");
const shots = path.join(root, ".cmd-dev", "shots", "wb");

// --name value and --name (true), then the positional arguments.
const args = [];
const flags = {};
for (const argv = process.argv.slice(2); argv.length;) {
  const a = argv.shift();
  if (!a.startsWith("--")) args.push(a);
  else
    flags[a.slice(2)] =
      argv[0] && !argv[0].startsWith("--") && a !== "--window"
        ? argv.shift()
        : true;
}
const flag = (name) => flags[name];
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const commands = { goto, shot, matrix, eval: evaluate, stop };
await (commands[args[0]] ?? start)(
  ...(commands[args[0]] ? args.slice(1) : args),
);

async function start(story = "") {
  fs.mkdirSync(home, { recursive: true });
  const port = await freePort();
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "@cmd/desktop",
      "exec",
      "electron-vite",
      "dev",
      "--remoteDebuggingPort",
      String(port),
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        CMD_HOME: home,
        CMD_WORKBENCH: story,
        CMD_NO_SANDBOX: "1",
        CMD_USAGE_URL: "off",
      },
    },
  );
  fs.writeFileSync(stateFile, JSON.stringify({ port, pid: child.pid }));
  console.log(`workbench: ${home}, DevTools on ${port}`);
  const quit = async () => {
    child.kill("SIGTERM");
    await stopCore(home, { terminals: true });
    fs.rmSync(stateFile, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  child.on("exit", quit);
}

/** The open Workbench page, over the DevTools protocol. */
async function connect() {
  const { port } = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().includes("/workbench.html"));
  if (!page) throw new Error("no Workbench window open");
  return { browser, page };
}

/** Show story/variant/theme (unset keeps what is there) and wait until it rendered. */
async function show(page, { story, variant, theme }) {
  const want = await page.evaluate(
    ({ story, variant, theme }) => {
      const q = new URLSearchParams(location.search);
      if (story) (q.set("story", story), variant || q.delete("variant"));
      if (variant) q.set("variant", variant);
      if (theme) q.set("theme", theme);
    q.set("mount", String(Date.now())); // fresh state, whatever was clicked before
      history.replaceState(null, "", `?${q}`);
      dispatchEvent(new Event("workbench:url"));
      return q.get("story");
    },
    { story, variant, theme },
  );
  await page.waitForFunction(
    (s) =>
      document.body.dataset.ready?.startsWith(`${s}/`) &&
      (!location.search.includes("variant=") ||
        document.body.dataset.ready ===
          `${s}/${new URLSearchParams(location.search).get("variant")}`),
    want,
    { timeout: 10000 },
  );
  if (theme) await page.waitForFunction((t) => document.body.dataset.theme === t, theme, { timeout: 10000 });
  await page.waitForTimeout(400); // fonts, SF Symbols, entry animations
  return page.evaluate(() => document.body.dataset.ready);
}

/** The component's box plus a margin, or the whole window. */
async function capture(page, file, whole) {
  const cdp = await page.context().newCDPSession(page);
  const [width, height, dpr] = await page.evaluate(() => [
    innerWidth,
    innerHeight,
    devicePixelRatio,
  ]);
  if (dpr !== 2) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page.waitForTimeout(500);
  }
  try {
    await shoot(page, cdp, file, whole);
  } finally {
    if (dpr !== 2) await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.detach();
  }
}

// Page.captureScreenshot, not page.screenshot: on a page Playwright attached to, that one comes out at 1x.
async function shoot(page, cdp, file, whole) {
  const clip = await page.evaluate((whole) => {
    if (whole) return { x: 0, y: 0, width: innerWidth, height: innerHeight };
    const el =
      document.querySelector(".ui-dialog, .ui-popover, .ui-menu") ??
      document.querySelector(".wb-stage > *");
    if (!el) return { x: 0, y: 0, width: innerWidth, height: innerHeight };
    const r = el.getBoundingClientRect();
    const m = 32;
    const x = Math.max(0, r.left - m),
      y = Math.max(0, r.top - m);
    return {
      x,
      y,
      width: Math.min(innerWidth - x, r.width + 2 * m),
      height: Math.min(innerHeight - y, r.height + 2 * m),
    };
  }, whole);
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { ...clip, scale: 1 },
  });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
}

async function goto(story, variant) {
  const { browser, page } = await connect();
  console.log(await show(page, { story, variant, theme: flag("theme") }));
  await browser.close();
}

async function shot(story, variant) {
  const theme = flag("theme");
  const out = flag("out");
  const whole = !!flag("window");
  const { browser, page } = await connect();
  const on = await show(page, { story, variant, theme });
  fs.mkdirSync(shots, { recursive: true });
  const file = path.resolve(
    out ??
      path.join(
        shots,
        `${on.replace("/", "-")}${theme ? `-${theme}` : ""}.png`,
      ),
  );
  await capture(page, file, whole);
  console.log(file);
  await browser.close();
}

async function matrix(story) {
  const themes = (
    flag("themes") ?? "pastel-dark,pastel-light,gruvbox-dark"
  ).split(",");
  const { browser, page } = await connect();
  const before = page.url();
  await show(page, { story });
  const variants = (
    await page.evaluate(() => document.body.dataset.variants ?? "")
  )
    .split(",")
    .filter(Boolean);
  fs.mkdirSync(shots, { recursive: true });
  for (const theme of themes)
    for (const variant of variants) {
      await show(page, { story, variant, theme });
      const file = path.join(shots, `${story}-${variant}-${theme}.png`);
      await capture(page, file);
      console.log(file);
    }
  // Back to what was on screen.
  await page.evaluate(
    (url) => (
      history.replaceState(null, "", url),
      dispatchEvent(new Event("workbench:url"))
    ),
    before,
  );
  await browser.close();
}

/** An expression or statements; the result is printed as JSON. */
async function evaluate(code) {
  const { browser, page } = await connect();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const result = await page.evaluate(`(async () => { ${/\breturn\b|;/.test(code) ? code : `return (${code})`} })()`);
  console.log(JSON.stringify(result, null, 2) ?? "undefined");
  if (errors.length) console.error(errors.join("\n"));
  await browser.close();
}

async function stop() {
  try {
    const { pid } = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    process.kill(pid, "SIGTERM");
  } catch {}
  await stopCore(home, { terminals: true });
  fs.rmSync(stateFile, { force: true });
}
