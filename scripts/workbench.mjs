// The UI Workbench (apps/desktop/src/renderer/workbench.html, docs/48): every component
// and story, read from the sources, in the real app (styles, icons, preload, core),
// with HMR. It runs on its own instance (.cmd-dev/workbench, or $CMD_WORKBENCH_HOME)
// and exposes the DevTools protocol, so these commands drive the open window. A target
// is a story (shell/feedback, or its old id feedback) or a component (ui/Button).
//   pnpm workbench [target] [--headless]          start it (stays in the foreground); headless: the window isn't shown
//   pnpm workbench ls [--json]                    the components and stories (read from the sources; no window needed)
//   pnpm workbench goto <target> [variant] [--theme id]   show that in the window
//   pnpm workbench shot [target] [variant] [--theme id | --themes all] [--out file.png] [--window]
// Shots crop to the component (a dialog, else what the stage shows) with a margin, or to
// the page as far as it shows; --themes all: the target in every theme, one image of the
// whole grid. The window is yours to size and move, so its size and display vary. They
// are always 2x: the window is emulated at 2x for the shot, then restored.
//   pnpm workbench matrix <story> [--themes a,b,c]   every variant × themes, into .cmd-dev/shots/wb
//   pnpm workbench eval '<js>'                    run JS in the window (await works), print the result
//   pnpm workbench audit [story] [variant] [--theme id]   (or audit --all: every story, its Sizes too) where each window's content sits against its
//                                                 edges (window-design skill, audit.ts); exits 1 on a problem
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
      argv[0] && !argv[0].startsWith("--") && a !== "--window" && a !== "--headless"
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

const commands = { ls, goto, shot, matrix, eval: evaluate, audit, stop };
await (commands[args[0]] ?? start)(
  ...(commands[args[0]] ? args.slice(1) : args),
);

async function start(story = "") {
  fs.mkdirSync(home, { recursive: true });
  const port = await freePort();
  // Into apps/desktop/out-dev (dev-electron.mjs), so it runs beside pnpm e2e and pnpm build.
  const child = spawn(
    "node",
    [path.join(root, "scripts/dev-electron.mjs"), "--remoteDebuggingPort", String(port)],
    {
      cwd: root,
      stdio: "inherit",
      // Its own process group (pid = group id), so stop reaches Electron too, not only the
      // wrapper: electron-vite exits on SIGTERM without quitting the Electron it started.
      detached: true,
      env: {
        ...process.env,
        CMD_HOME: home,
        CMD_WORKBENCH: story,
        ...(flag("headless") ? { CMD_WORKBENCH_HIDDEN: "1" } : {}),
        CMD_NO_SANDBOX: "1",
        CMD_USAGE_URL: "off",
      },
    },
  );
  fs.writeFileSync(stateFile, JSON.stringify({ port, pid: child.pid }));
  console.log(`workbench: ${home}, DevTools on ${port}`);
  const quit = async () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    await stopCore(home, { terminals: true });
    // Only ours: a Workbench started since (stop, then start) has written its own.
    try {
      if (JSON.parse(fs.readFileSync(stateFile, "utf8")).pid === child.pid) fs.rmSync(stateFile, { force: true });
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  child.on("exit", quit);
}

/** The open Workbench page, over the DevTools protocol. */
/** Commands run as the script loads (top-level await), so this is a function, not a const below them. */
function notRunning() {
  console.error(`The UI Workbench isn't running for ${path.relative(root, home) || home}. Start it with pnpm workbench (--headless for no window).`);
  process.exit(1);
}

async function connect() {
  let port;
  try {
    ({ port } = JSON.parse(fs.readFileSync(stateFile, "utf8")));
  } catch {
    notRunning();
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(notRunning);
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().includes("/workbench.html"));
  if (!page) throw new Error("no Workbench window open");
  return { browser, page };
}

/** The newest edit to what the window shows: the renderer's sources and the kit's. */
function lastEdit() {
  let t = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else t = Math.max(t, fs.statSync(p).mtimeMs);
    }
  };
  for (const dir of ["apps/desktop/src/renderer", "packages/ui/src"]) walk(path.join(root, dir));
  return t;
}

/**
 * Wait until the window shows the sources as they are now: the dev server has handled the
 * newest edit and the page has taken the update it sent (HMR), so a shot right after an
 * edit is of the edit, with no sleep. One that doesn't compile: show() prints the error.
 */
async function settle(page) {
  const edit = lastEdit();
  const deadline = Date.now() + 8000;
  for (;;) {
    const s = await page
      .evaluate(async () => {
        const d = document.body.dataset;
        const server = await fetch("/__workbench/hmr").then((r) => r.json()).catch(() => null);
        return { at: Number(d.hmrAt ?? 0), pending: !!d.hmrPending, error: !!d.hmrError, server };
      })
      .catch(() => null); // reloading
    // Older than the page: already in it. No server endpoint: an older Workbench, nothing to ask.
    if (s && (edit <= s.at || !s.server)) return;
    if (s && s.server.heard >= edit && !s.pending && (s.at >= s.server.sent || s.error)) return;
    if (Date.now() > deadline) {
      console.error("workbench: the last edit hasn't reached the window after 8 s; the shot may be of the code before it");
      return;
    }
    await page.waitForTimeout(50);
  }
}

/**
 * Show a story (its page, or one variant) or a component's page, and a theme (unset keeps
 * what is there), then wait until it rendered: the page says what it was asked, for which
 * mount, and what is on stage (data-asked, data-mount, data-ready).
 */
async function show(page, { story: target, variant, theme, mode }) {
  await settle(page);
  const mount = String(Date.now()); // fresh state, whatever was clicked before
  const want = await page.evaluate(
    ({ target, variant, theme, mount, mode }) => {
      const q = new URLSearchParams(location.search);
      if (target && globalThis.workbenchCatalog?.components.some((c) => c.id === target)) (q.set("component", target), q.delete("story"), q.delete("variant"));
      else if (target) (q.set("story", target), q.delete("component"), variant || q.delete("variant"));
      if (variant) q.set("variant", variant);
      if (theme) q.set("theme", theme);
      // Every theme at once, or one (null); unset keeps what is there.
      if (mode) q.set("mode", mode);
      else if (mode === null) q.delete("mode");
      q.set("mount", mount);
      history.replaceState(null, "", `?${q}`);
      dispatchEvent(new Event("workbench:url"));
      return q.get("component") ?? q.get("story") ?? "";
    },
    { target, variant, theme, mount, mode },
  );
  await page.waitForFunction(
    ({ want, mount, variant }) => {
      const d = document.body.dataset;
      return d.asked === want && d.mount === mount && (!!d.loadError || (!!d.ready && (!variant || d.ready.endsWith(`/${variant}`))));
    },
    { want, mount, variant },
    { timeout: 15000 },
  );
  const failed = await page.evaluate(() => document.body.dataset.loadError);
  if (failed) {
    console.error(`workbench: ${target}'s story file didn't load:\n${failed}`);
    process.exit(1);
  }
  if (theme) await page.waitForFunction((t) => document.body.dataset.theme === t, theme, { timeout: 10000 });
  await page.waitForTimeout(400); // fonts, entry animations
  const { ready, hmrError } = await page.evaluate(() => ({ ...document.body.dataset }));
  if (hmrError) console.error(`workbench: the window shows the code from before the last edit, which doesn't compile:\n${hmrError}`);
  return ready;
}

/** The component's box plus a margin (one variant alone), the page as far as it shows, or the whole window. */
async function capture(page, file, whole, grid) {
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
    await (grid ? shootGrid(page, cdp, file) : shoot(page, cdp, file, whole));
  } finally {
    if (dpr !== 2) await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.detach();
  }
}

// Page.captureScreenshot, not page.screenshot: on a page Playwright attached to, that one comes out at 1x.
async function shoot(page, cdp, file, whole) {
  const clip = await page.evaluate((whole) => {
    if (whole) return { x: 0, y: 0, width: innerWidth, height: innerHeight };
    const stage = document.querySelector(".wb-stage");
    if (!stage) {
      const main = document.querySelector(".ui-split-main")?.getBoundingClientRect();
      return main ? { x: main.left, y: main.top, width: main.width, height: main.height } : { x: 0, y: 0, width: innerWidth, height: innerHeight };
    }
    const el = stage.querySelector(".wb-layer .ui-dialog") ?? document.querySelector(".ui-popover, .ui-menu") ?? stage.firstElementChild;
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

// The audit's measurements live in the page (renderer/src/workbench/audit.ts), which the
// UI Workbench's audit overlay draws too: one copy.
async function audit(story, variant) {
  if (story === "--all" || flag("all")) return auditAll();
  const { browser, page } = await connect();
  if (story) console.log(await show(page, { story, variant, theme: flag("theme") }));
  const { inset, barInset, rows } = await page.evaluate(() => globalThis.workbenchAudit());
  await browser.close();
  if (!rows.length) {
    console.log("No View in this story: nothing to measure.");
    return;
  }
  const pad = (v, n) => String(v).padEnd(n);
  const wn = Math.max(...rows.map((r) => r.window.length));
  console.log(`--inset ${inset}px, --bar-inset ${barInset}px. Distances to the nearest text, icon or drawing:`);
  for (const r of rows) console.log(`${pad(r.window, wn)}  ${pad(r.part, 8)} ${r.part === "body" ? `top ${pad(r.top, 4)}` : "        "} left ${pad(r.left, 4)} right ${pad(r.right, 4)} ${r.problems.length ? "✗ " + r.problems.join("; ") : ""}`);
  const bad = rows.filter((r) => r.problems.length).length;
  if (bad) {
    console.log(`${bad} problem${bad > 1 ? "s" : ""}.`);
    process.exitCode = 1;
  } else console.log("No problems.");
}

/** `audit --all`: every story's default variant, and its Sizes (from the catalog); only what has a problem is printed. */
async function auditAll() {
  const { browser, page } = await connect();
  const stories = await page.evaluate(() => globalThis.workbenchCatalog.stories.map((s) => ({ story: s.id, sizes: s.variants.some((v) => v.name === "Sizes") })));
  let bad = 0;
  for (const { story, sizes } of stories) {
    for (const variant of sizes ? [undefined, "Sizes"] : [undefined]) {
      try {
        await show(page, { story, variant, theme: flag("theme") });
      } catch {
        console.log(`${story}${variant ? "/" + variant : ""}: didn't render`);
        continue;
      }
      const { rows } = await page.evaluate(() => globalThis.workbenchAudit());
      for (const r of rows.filter((r) => r.problems.length)) {
        bad++;
        console.log(`${story}${variant ? "/" + variant : ""}  ${r.window}  ${r.part}: ${r.problems.join("; ")}`);
      }
    }
  }
  await browser.close();
  console.log(bad ? `${bad} problem${bad > 1 ? "s" : ""}.` : "No problems.");
  if (bad) process.exitCode = 1;
}

/** The catalog, read from the sources here (no window needed): stories with their variants, then the kit's components with how many variants render each. */
async function ls() {
  const { extractCatalog, catalogRoots } = await import("../apps/desktop/src/renderer/src/workbench/catalog/extract.ts");
  const catalog = extractCatalog(catalogRoots(root));
  if (flag("json")) return console.log(JSON.stringify(catalog, null, 2));
  const pad = (s, n) => s.padEnd(n);
  const w = Math.max(...catalog.stories.map((s) => s.id.length), ...catalog.components.map((c) => c.id.length));
  console.log(`Stories (${catalog.stories.length}):`);
  for (const s of catalog.stories) console.log(`  ${pad(s.id, w)}  ${s.variants.map((v) => v.name).join(", ")}`);
  const kit = catalog.components.filter((c) => c.kit);
  const shownBy = (id) => catalog.stories.flatMap((s) => s.variants.filter((v) => v.components?.includes(id))).length;
  console.log(`\nKit components (${kit.length}), and how many variants render each:`);
  for (const c of kit) console.log(`  ${pad(c.id, w)}  ${shownBy(c.id) || "none"}`);
  const bare = kit.filter((c) => !shownBy(c.id));
  console.log(bare.length ? `\n${bare.length} without a story: ${bare.map((c) => c.name).join(", ")}` : "\nA story renders every one.");
}

async function goto(story, variant) {
  const { browser, page } = await connect();
  console.log(await show(page, { story, variant, theme: flag("theme") }));
  await browser.close();
}

/** Every theme's box, the whole grid: the page's scroller let out to its content for the shot, then put back. */
async function shootGrid(page, cdp, file) {
  const clip = await page.evaluate(() => {
    const main = document.querySelector(".ui-split-main");
    const wb = document.querySelector(".wb");
    main.dataset.shot = main.getAttribute("style") ?? "";
    main.style.overflow = "visible";
    wb.style.height = "auto";
    document.body.style.overflow = "visible";
    const r = document.querySelector(".wb-themes").getBoundingClientRect();
    const m = 24;
    return { x: Math.max(0, r.left - m), y: Math.max(0, r.top + scrollY - m), width: r.width + 2 * m, height: r.height + 2 * m };
  });
  await page.waitForTimeout(300);
  try {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 }, captureBeyondViewport: true });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
  } finally {
    await page.evaluate(() => {
      const main = document.querySelector(".ui-split-main");
      main.setAttribute("style", main.dataset.shot ?? "");
      delete main.dataset.shot;
      document.querySelector(".wb").style.height = "";
      document.body.style.overflow = "";
    });
  }
}

async function shot(story, variant) {
  const theme = flag("theme");
  const out = flag("out");
  const whole = !!flag("window");
  const every = flag("themes") === "all";
  const { browser, page } = await connect();
  const on = await show(page, { story, variant, theme, mode: every ? "themes" : null });
  fs.mkdirSync(shots, { recursive: true });
  const file = path.resolve(
    out ??
      path.join(
        shots,
        `${on.replaceAll("/", "-").replace(/-\*$/, "")}${every ? "-themes" : theme ? `-${theme}` : ""}.png`,
      ),
  );
  await capture(page, file, whole, every);
  console.log(file);
  await browser.close();
}

async function matrix(story) {
  const themes = (
    flag("themes") ?? "pastel-dark,pastel-light,gruvbox-dark"
  ).split(",");
  const { browser, page } = await connect();
  const before = page.url();
  await show(page, { story, mode: null });
  const variants = (
    await page.evaluate(() => document.body.dataset.variants ?? "")
  )
    .split(",")
    .filter(Boolean);
  fs.mkdirSync(shots, { recursive: true });
  for (const theme of themes)
    for (const variant of variants) {
      await show(page, { story, variant, theme, mode: null });
      const file = path.join(shots, `${story.replaceAll("/", "-")}-${variant}-${theme}.png`);
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
    process.kill(-pid, "SIGTERM"); // the group: wrapper, electron-vite and Electron
  } catch {}
  await stopCore(home, { terminals: true });
  fs.rmSync(stateFile, { force: true });
}
