// Launches the built app against an isolated core, drives it through the real
// menu bar, takes screenshots. usage: pnpm e2e [--only name,name]
// E2E_SCREEN=ci runs it as on CI's smaller screen (e2e/screen.mjs); E2E_CPU_THROTTLE=12
// slows the app window's CPU that many times, as on CI's slow runner.
// Each section is a scenario: a failure saves failed-<name>.png, and the run goes on
// with the next (skipping those that need it) and lists every failure at the end.
// --only runs the named scenarios (a part of the name will do) and what they need.
// Pages run with Reduce Motion, so glides and fades end at once and checks don't
// wait out animations (no check here is about motion: e2e/motion.mjs and the kit's
// Dialog test measure that). E2E_MOTION=1 keeps real motion.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import http from "node:http";
import { _electron as electron } from "playwright";
import { corePid, stopCore } from "../scripts/stop-core.mjs";
import { fitScreen, screenEnv } from "./screen.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const only = arg("--only")?.split(",").filter(Boolean) ?? null;

const root = path.resolve(import.meta.dirname, "..");
const home = path.join(root, ".cmd-dev", "e2e");
// The app starts a detached core (and PTY host) that outlive it. Stop the last
// run's before wiping its state (or they're orphaned), and this run's on any exit, pass or fail.
await stopCore(home, { terminals: true });
process.on("exit", () => {
  for (const pid of [corePid(home), corePid(home, "ptyhost")]) {
    try {
      if (pid) process.kill(pid, "SIGTERM");
    } catch {}
  }
});
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
const shots = path.join(root, ".cmd-dev", "shots");
fs.mkdirSync(shots, { recursive: true });
for (const f of fs.readdirSync(shots)) if (/^(failed|hung)/.test(f)) fs.rmSync(path.join(shots, f)); // the last run's

// Fixture transcripts (instead of the real ~/.claude) and a harmless agent command.
const transcripts = path.join(home, "transcripts-home");
const project = path.join(transcripts, ".claude", "projects", "-tmp-demo");
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(
  path.join(project, "e2e-session-1.jsonl"),
  [
    { type: "user", sessionId: "e2e-session-1", cwd: home, timestamp: new Date().toISOString(), message: { role: "user", content: "make the wireguard vpn reconnect automatically" } },
    { type: "assistant", sessionId: "e2e-session-1", message: { role: "assistant", content: [{ type: "text", text: "Added a launchd job that runs wg-quick up on network change." }] } },
    { type: "ai-title", aiTitle: "VPN auto reconnect" },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n",
);
fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ "agents.claude.command": "echo claude" }));

const require = createRequire(path.join(root, "apps/desktop/package.json"));
const motion = !!process.env.E2E_MOTION;
const launch = async () => {
  const app = await electron.launch({
    executablePath: require("electron"),
    // Fake camera and microphone (not a fake permission prompt): a page's getUserMedia reaches cmd's sheet without real devices.
    args: ["--use-fake-device-for-media-stream", path.join(root, "apps/desktop")],
    env: { ...process.env, CMD_HOME: home, CMD_USAGE_URL: "off", CMD_DEV_KEYS: "off", CMD_NO_SANDBOX: "1", CMD_BACKGROUND: process.env.E2E_VISIBLE ? "" : "1", CMD_MAGIC_UNSANDBOXED: "1", CMD_TRANSCRIPTS_HOME: transcripts, ...screenEnv() },
  });
  // Reduce Motion in every page: the app window, Settings, browser pages (webviews are pages
  // here too). Chromium's --force-prefers-reduced-motion doesn't reach Electron's pages.
  const reduce = (p) => (motion ? Promise.resolve() : p.emulateMedia({ reducedMotion: "reduce" }).catch(() => {}));
  app.on("window", reduce);
  const win = await app.firstWindow();
  await reduce(win);
  await fitScreen(app, win);
  if (process.env.E2E_CPU_THROTTLE) await (await win.context().newCDPSession(win)).send("Emulation.setCPUThrottlingRate", { rate: +process.env.E2E_CPU_THROTTLE });
  win.on("pageerror", (e) => console.log("pageerror:", e.message));
  // What the checks stub in main (dialogs, menus, opening links), to put back after a failed scenario.
  await app.evaluate(({ dialog, Menu, shell }) => {
    globalThis.__e2eOriginals = { box: dialog.showMessageBox, save: dialog.showSaveDialog, popup: Menu.prototype.popup, ext: shell.openExternal, path: shell.openPath };
  });
  return { app, win };
};
let { app, win } = await launch();

// Some calls have no timeout (app.close, evaluate waiting on the core) and can hang
// for good, on Windows in particular. A watchdog fails the scenario under way instead,
// naming the last step and saving a screenshot; a second hang, or one outside a
// scenario, ends the run.
let lastStep = "launch";
let lastAt = Date.now();
const step = (s) => ((lastStep = s), (lastAt = Date.now()));
const HANG_MS = 90_000;
let hangs = 0;
let abortScenario = null;
setInterval(async () => {
  if (Date.now() - lastAt < HANG_MS) return;
  console.log(`HUNG: nothing for ${HANG_MS / 1000}s after: ${lastStep}`);
  lastAt = Date.now();
  const within = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r("(no answer in 5s)"), 5000))]);
  const wins = await within(
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), visible: w.isVisible() }))),
  ).catch((e) => e.message);
  console.log("electron windows:", JSON.stringify(wins));
  await within(win.screenshot({ path: path.join(shots, "hung.png") })).catch(() => {});
  if (abortScenario && ++hangs < 2) return abortScenario(new Error(`HUNG: nothing for ${HANG_MS / 1000}s after: ${lastStep}`));
  report();
  process.exit(1);
}, 5000).unref();
// A failure outside a scenario (launch, the restart) ends the run: screenshot first, so CI's artifact shows it.
process.on("uncaughtException", async (e) => {
  console.log(e?.stack ?? e);
  console.log(`failed after: ${lastStep}; screenshot in ${path.join(shots, "failed.png")}`);
  const shot = win?.screenshot({ path: path.join(shots, "failed.png") }).catch(() => {});
  await Promise.race([shot, new Promise((r) => setTimeout(r, 5000))]);
  failures.push({ scenario: "(outside a scenario)", error: String(e?.message ?? e) });
  report();
  process.exit(1);
});
// A promise a failed scenario left behind (a waitForEvent it never reached) rejects later: say so, go on.
process.on("unhandledRejection", (e) => console.log(`(a promise left by an earlier step failed: ${String(e?.message ?? e).split("\n")[0]})`));

/**
 * app.close() waits until Electron's stdout/stderr pipes close. On Windows the
 * detached core inherits those handles and keeps running, so wait for Electron
 * itself to exit instead.
 */
const closeApp = async () => {
  const proc = app.process();
  const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once("exit", r));
  app.close().catch(() => {});
  await exited;
};

const check = (cond, msg) => {
  step(`check "${msg}"`);
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
};

// ── scenarios ──
// Each top-level section runs as scenario(name, fn): a failed check ends that scenario
// (screenshot failed-<name>.png), the run goes on, and a scenario that needs what a failed
// one was to leave behind (its terminals, its windows) is skipped, saying so. In run order,
// each with what it needs; every one needs onboarding (its sheet covers the window).
const SCENARIOS = {
  onboarding: [],
  chrome: [],
  keymap: [],
  terminals: [],
  navigator: ["terminals"],
  grid: ["terminals"],
  palette: [],
  "session-search": [],
  search: [],
  "sidebar-search": [],
  browser: [],
  "blank-browser": [],
  "site-permissions": ["browser"],
  osc8: [],
  files: ["terminals"],
  "files-menus": ["files"],
  text: ["files"],
  markdown: [],
  json: [],
  "window-kinds": ["browser", "files", "text", "markdown"],
  "error-boundary": ["markdown", "terminals"],
  untitled: [],
  embedded: ["browser", "terminals"],
  magic: ["terminals"],
  settings: ["files", "markdown"],
  keybindings: [],
  mru: ["terminals"],
  "close-idle": ["mru"],
  strip: ["terminals"],
  marker: ["terminals"],
  sidebars: ["marker"],
  restart: ["marker"],
  "core-status": [],
  workspaces: [],
  "app-window": [],
};
const failures = [];
const outcome = new Map(); // name → "passed" | "failed" | "skipped" | "not run"
// --only: the named scenarios (a part of a name picks each it is in), what they need, and onboarding.
const wanted = (() => {
  if (!only) return null;
  const want = new Set();
  const add = (name) => {
    if (want.has(name)) return;
    want.add(name);
    for (const n of SCENARIOS[name]) add(n);
  };
  // A whole name picks that one; a part picks every one it is in.
  for (const o of only) for (const name of Object.keys(SCENARIOS)) if (o in SCENARIOS ? name === o : name.includes(o)) add(name);
  if (!want.size) throw new Error(`--only ${only.join(",")}: no such scenario (${Object.keys(SCENARIOS).join(", ")})`);
  add("onboarding");
  console.log(`only: ${[...want].join(", ")}`);
  return want;
})();
async function scenario(name, fn) {
  const needs = SCENARIOS[name];
  if (!needs) throw new Error(`scenario ${name} isn't listed in SCENARIOS`);
  if (wanted && !wanted.has(name)) return void outcome.set(name, "not run");
  const missing = [...needs, ...(name === "onboarding" ? [] : ["onboarding"])].find((n) => outcome.get(n) !== "passed");
  if (missing) {
    console.log(`\n# ${name}\nskipped: needs ${missing}`);
    return void outcome.set(name, "skipped");
  }
  console.log(`\n# ${name}`);
  step(`scenario ${name}`);
  try {
    await Promise.race([fn(), new Promise((_, reject) => (abortScenario = reject))]);
    outcome.set(name, "passed");
  } catch (e) {
    outcome.set(name, "failed");
    const error = String(e?.message ?? e);
    failures.push({ scenario: name, error: error.split("\n")[0] });
    console.log(`FAILED in ${name}: ${e?.stack ?? e}`);
    const shot = path.join(shots, `failed-${name}.png`);
    await Promise.race([win.screenshot({ path: shot }).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    console.log(`after: ${lastStep}; screenshot in ${shot}`);
    await recover();
  } finally {
    abortScenario = null;
  }
}
// After a failure: let go of keys and buttons, close what's open over the board, put the
// stubs in main back, close other app windows (Settings), so the next scenario starts clean.
async function recover() {
  step("recovering from a failed scenario");
  const within = (p) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  await within(win.mouse.up());
  for (const k of ["Meta", "Shift", "Alt", "Control"]) await within(win.keyboard.up(k));
  await within(app.evaluate(({ dialog, Menu, shell }) => {
    const o = globalThis.__e2eOriginals;
    if (!o) return;
    dialog.showMessageBox = o.box;
    dialog.showSaveDialog = o.save;
    Menu.prototype.popup = o.popup;
    shell.openExternal = o.ext;
    shell.openPath = o.path;
  }));
  for (const p of app.windows()) if (p !== win && /settings\.html/.test(p.url())) await within(p.close());
  for (let i = 0; i < 2; i++) await within(win.keyboard.press("Escape"));
}
function report() {
  const ran = [...outcome].filter(([, o]) => o !== "not run");
  console.log(`\n${ran.filter(([, o]) => o === "passed").length} of ${ran.length} scenarios passed`);
  const skipped = ran.filter(([, o]) => o === "skipped").map(([n]) => n);
  if (skipped.length) console.log(`skipped (needed a failed one): ${skipped.join(", ")}`);
  if (failures.length) {
    console.log(`${failures.length} failed:`);
    for (const f of failures) console.log(`  ✗ ${f.scenario}: ${f.error}`);
  }
}
// Overlays and sidebars play out a fade or slide before they leave the DOM: wait for that, not a fixed time.
const gone = (sel) => win.waitForSelector(sel, { state: "detached", timeout: 5000 }).catch(() => {});
// Shortcut checks: the macOS keymap, or its Windows translation (docs/10-windows.md).
const mac = process.platform === "darwin";
const macOnly = (msg) => console.log(`skip - ${msg} (macOS keymap)`);
// Synthetic keys bypass the native menu, so trigger menu items directly.
const menu = (id) => (
  step(`menu ${id}`),
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`no menu item ${id}`);
    item.click();
  }, id)
);
const accel = (id) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.accelerator ?? null, id);
const panes = () => win.evaluate(() => window.cmd.call("pane.list", {}).then((p) => p.length));
// Layout and selection live in the shown workspace's view (docs/11-workspaces.md); these checks run in Home.
const homeView = () => win.evaluate(() => window.cmd.call("workspace.list", {}).then((l) => l.find((s) => s.home).view));
// Windows glide (TileMotion) on a clock that steps at most 34 ms a frame, so on a slow
// machine (CI) a glide takes longer than its 0.38 s (with Reduce Motion they jump, but a
// command still takes a moment to reach the renderer). Before measuring the board: give
// the command `min` ms to land, then wait until no window, scroll or sidebar has moved
// for 200 ms, or 5 s have passed (the check then fails on what it reads).
const still = async (min = 300) => {
  await win.waitForTimeout(min); // for the command to land (not a read)
  const read = () => win.evaluate(() => JSON.stringify([
    ...[...document.querySelectorAll(".windows-track > .tile, .dock-left, .dock-right")].map((e) => {
      const r = e.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map(Math.round);
    }),
    Math.round(document.querySelector(".windows-scroller")?.scrollLeft ?? 0),
  ]));
  let last = await read();
  for (let same = 0, t0 = Date.now(); same < 2 && Date.now() - t0 < 5000; ) {
    await win.waitForTimeout(100);
    const now = await read();
    same = now === last ? same + 1 : 0;
    last = now;
  }
};
// State the app changes after a command (a write, a save, a re-render) settles later on a slow
// runner (CI): read it every 100 ms until `ok` holds or `ms` pass, and return the last value
// read, so the check after it fails on (and prints) what it saw. Never a fixed wait before a read.
const until = async (read, ok = Boolean, ms = 10_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await read();
    if ((await ok(v)) || Date.now() - t0 > ms) return v;
    await win.waitForTimeout(100);
  }
};
const countOf = (sel) => win.locator(sel).count();
// Focus is never assumed (it moves asynchronously in Electron): before typing or pressing a
// key, wait until the element that should take it has it. focusIn: inside a window.
const focused = (sel) => until(() => win.evaluate((sel) => !!document.activeElement?.closest(sel), sel), Boolean, 10_000);
const focusIn = (id) => focused(`.tile[data-pane="${id}"]`);
// The window the renderer shows as selected: what a menu command acts on.
const selected = () => win.evaluate(() => document.querySelector(".tile.sel")?.dataset.pane);
// A window the core opened is in the renderer (shown or not: focus mode hides the others).
const tileIn = (id) => win.locator(`.tile[data-pane="${id}"]`).waitFor({ state: "attached", timeout: 10_000 });
const select = async (id) => {
  await win.evaluate((id) => window.__cmdSelect(id), id);
  return until(selected, (s) => s === id);
};
// Windows in visual order (reading order); the DOM keeps a stable creation order.
const visualTiles = async () => {
  const ids = await win.locator(".windows-track > .tile:not([data-hidden])").evaluateAll((els) =>
    els
      .map((e) => ({ id: e.dataset.pane, r: e.getBoundingClientRect() }))
      .sort((a, b) => (Math.abs(a.r.top - b.r.top) > 20 ? a.r.top - b.r.top : a.r.left - b.r.left))
      .map((x) => x.id),
  );
  return ids.map((id) => win.locator(`.tile[data-pane="${id}"]`));
};

await win.waitForSelector(".statusbar .core-status");
// First launch: the onboarding sheet, Welcome then the AI step; without a key only "Set Up Later" moves on.
await scenario("onboarding", async () => {
  await win.waitForSelector(".onboarding");
  check((await win.locator(".onboarding .ui-sheet-header-title").textContent()) === "Welcome to cmd", "a new install opens onboarding at Welcome");
  await win.locator(".onboarding button", { hasText: "Get Started" }).click();
  await win.waitForSelector(".onboarding .ui-sheet-header-title:has-text('Connect an AI provider')");
  await win.screenshot({ path: path.join(shots, "0-onboarding-ai.png") });
  const titles = await win.locator(".onboarding .ui-row-name").allTextContents();
  check(titles.includes("Anthropic") && titles.includes("OpenAI") && (await win.locator(".onboarding button", { hasText: "Done" }).isDisabled()), "the AI step lists the providers, and Done waits for a key");
  await win.locator(".onboarding button", { hasText: "Set Up Later" }).click();
  await win.waitForSelector(".onboarding", { state: "detached" });
  const onboardingFile = path.join(home, "ui", "onboarding.json");
  const seen = await until(() => (fs.existsSync(onboardingFile) ? JSON.parse(fs.readFileSync(onboardingFile, "utf8")).seen.join() : ""), (s) => s === "welcome,ai");
  check(seen === "welcome,ai", `the steps shown are recorded, so they don't open again (${seen})`);
  await win.screenshot({ path: path.join(shots, "1-empty.png") });
});
await scenario("chrome", async () => {
  // One footer across the window (docs/21-sidebars.md): the core's health at its left end,
  // tall enough for its tallest icon button.
  const right = await win.locator(".statusbar").boundingBox();
  const vw = await win.evaluate(() => window.innerWidth);
  const core = await win.locator(".statusbar .core-status").boundingBox();
  const btn = await win.locator(".statusbar :is(.ui-icon-button, .ui-seg button)").first().boundingBox();
  check(right.x === 0 && Math.abs(right.width - vw) < 0.5 && core.x < 40 && right.height >= btn.height,
    `the footer spans the window with the core's health on the left (${right.width} / ${vw}, core at ${core.x})`);
  check(right.height === 34, `the footer keeps its 34 px height (${right.height})`);
  // Every workspace starts with the Navigator docked left, under the top bar.
  await win.waitForSelector(".dock-left .tile.kind-navigator .navigator");
  const nav = await win.locator(".dock-left").boundingBox();
  const top = await win.locator(".topbar").boundingBox();
  check(nav.x === 0 && nav.y >= top.y + top.height - 0.5 && (await win.locator(".topbar .workspace-trigger").count()) === 1,
    `the Navigator is the left sidebar, the workspace switcher in the top bar (${nav.x}, ${nav.y})`);
  // Icons sit on whole pixels, exactly centred in their buttons.
  const offsets = await win.locator(".statusbar :is(.ui-icon-button, .ui-seg button)").evaluateAll((btns) =>
    btns.map((b) => {
      const s = b.querySelector(".sf").getBoundingClientRect();
      const r = b.getBoundingClientRect();
      return [s.left - r.left - (r.right - s.right), s.top - r.top - (r.bottom - s.bottom), s.width % 1, s.height % 1];
    }),
  );
  check(offsets.every(([dx, dy, fw, fh]) => Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01 && fw === 0 && fh === 0),
    `status bar icons are exactly centred on whole pixels (${offsets.length} buttons)`);
});

await scenario("keymap", async () => {
if (mac) {
  check((await accel("file.new")) === "Cmd+N" && (await accel("file.newTerminal")) === "Cmd+T", "⌘N is New…, ⌘T New Terminal");
  check((await accel("file.close")) === "Cmd+W", "⌘W is Close Terminal");
  check((await accel("session.next")) === "Alt+Cmd+Right", "⌥⌘→ is Next Session");
} else {
  // The Windows Terminal-style keymap (shared/commands.ts otherPlatformKey) reached the native menu.
  check((await accel("file.new")) === "Ctrl+Shift+N" && (await accel("file.newTerminal")) === "Ctrl+Shift+T", "Ctrl+Shift+N is New…, Ctrl+Shift+T New Terminal");
  check((await accel("view.palette")) === "Ctrl+Shift+K", "Ctrl+Shift+K is the command palette");
  check((await accel("session.next")) === "Ctrl+Alt+Right", "Ctrl+Alt+→ is Next Session");
}
});

// Every pane's screen, joined: the focused one needn't be first.
const screens = () => win.evaluate(() => window.cmd.call("pane.list", {}).then((ps) =>
  Promise.all(ps.map((p) => window.cmd.call("pane.read", { paneId: p.id, lines: 50 }).then((r) => r.text)))).then((t) => t.join("\n")));
// The newest pane's screen and foreground process.
const newestPane = () => win.evaluate(() => window.cmd.call("pane.list", {}).then((ps) => ps.sort((a, b) => b.createdAt - a.createdAt)[0]));
const paneText = (id, lines = 50) => win.evaluate(([id, lines]) => window.cmd.call("pane.read", { paneId: id, lines }).then((r) => r.text), [id, lines]);
// A new terminal's login shell has started once it drew its prompt.
const shellReady = async () => {
  const p = await until(newestPane, (p) => !!p);
  if (p) await until(() => paneText(p.id, 5), (t) => /\S/.test(t));
  return p;
};
// Two terminals, typed into: the scenarios after this one work with them.
await scenario("terminals", async () => {
  await menu("file.newTerminal");
  await win.locator(".xterm:visible").first().waitFor(); // hidden ones exist too (other workspaces, previews)
  const firstTerm = await shellReady();
  await focusIn(firstTerm.id);
  await win.keyboard.type("echo hello from cmd");
  await win.keyboard.press("Enter");
  // ⇧↩ reaches the PTY as ESC CR (agents' newline), not a plain CR.
  await until(() => paneText(firstTerm.id), (t) => /^hello from cmd$/m.test(t));
  await win.keyboard.type("cat -v");
  await win.keyboard.press("Enter");
  // Sent before cat runs, the shell's line editor would take it.
  await until(newestPane, (p) => p.foreground === "cat");
  await win.keyboard.press("Shift+Enter");
  const text = await until(screens, (t) => /^\^\[$/m.test(t));
  await win.keyboard.press("Control+C");
  check(/^\^\[$/m.test(text), "⇧↩ sends ESC CR to the terminal");
  await menu("file.newTerminal");
  await until(panes, (n) => n === 2);
  const second = await shellReady();
  await focusIn(second.id);
  await win.keyboard.type("ls -la");
  await win.keyboard.press("Enter");
  check((await panes()) === 2, "two terminals open");
  await win.screenshot({ path: path.join(shots, "2-focus.png") });
});

await scenario("navigator", async () => {
  // The Navigator lists both before ⌥⌘→ acts on what it shows.
  const rowsBefore = await until(() => win.locator(".navigator .ui-list-row:not(.history)").allTextContents(), (r) => r.length === 2);
  await menu("session.next");
  const selIndexAfter = await until(() => win.locator(".navigator .ui-list-row:not(.history)").evaluateAll((els) => els.findIndex((e) => e.classList.contains("sel"))), (i) => i >= 0);
  check(rowsBefore.length === 2 && selIndexAfter >= 0, `session.next moves selection (now row ${selIndexAfter + 1})`);
});

await scenario("grid", async () => {
await menu("view.grid");
check((await until(() => countOf(".windows-track > .tile"), (n) => n === 2)) === 2, "grid shows both terminals");
if (process.platform !== "win32") {
  await win.waitForSelector(".statusbar-usage .slot-v", { timeout: 10_000 });
  const usageText = await win.locator(".statusbar-usage .slot-v").first().textContent();
  check(/\d+ (KB|MB|GB)/.test(usageText ?? ""), `status bar shows memory of the process tree (${usageText})`);
} else console.log("skip - status bar memory (needs a Windows procinfo helper)");
// Notifications: a bell in the other terminal marks it until you look at it.
{
  const other = await win.evaluate(() => document.querySelector(".windows-track > .tile:not(.sel)")?.getAttribute("data-pane"));
  // A bell from the shell: PowerShell on Windows, a POSIX shell elsewhere.
  const bell = process.platform === "win32" ? 'Write-Host -NoNewline "`a"\r' : "printf '\\a'\r";
  await win.evaluate(([id, data]) => window.cmd.call("pane.write", { paneId: id, data }), [other, bell]);
  const status = win.locator(`.tile[data-pane="${other}"] .slot-status .slot-v:not(.out)`);
  await status.filter({ hasText: "Bell" }).waitFor({ timeout: 10_000 });
  check(true, "a terminal bell marks its window (Bell)");
  await win.evaluate((id) => window.cmd.call("notify.send", { paneId: id, title: "Build", body: "done" }), other);
  await status.filter({ hasText: "done" }).waitFor({ timeout: 10_000 });
  check(true, "cmd notify marks the terminal it came from");
  await win.evaluate((id) => window.__cmdSelect(id), other);
  await win.waitForFunction((id) => !document.querySelector(`.tile[data-pane="${id}"] .slot-status .slot-v:not(.out)`), other, { timeout: 10_000 });
  check(true, "looking at the terminal clears its mark");
  await win.evaluate((id) => window.cmd.call("pane.clearAttention", { paneId: id }), other);
}
const panesOrder = async () => (await homeView())["grid.order"];
const order0 = await panesOrder();
await still();
{ const t = await visualTiles(); await t[1].locator(".tile-title").dragTo(t[0], { steps: 10 }); }
const order1 = await until(panesOrder, (o) => Array.isArray(o) && JSON.stringify(o) !== JSON.stringify(order0));
check(Array.isArray(order1) && order1.length === 2, `dragging a tile onto another reorders the grid (${JSON.stringify(order1?.map((x) => x.slice(0, 4)))})`);
// Let the windows glide into their new places first: mid-animation, positions (and so the drag target) are stale.
await win.waitForFunction(() => !document.querySelector(".tile[data-morphing], .tile.lifted"), null, { timeout: 10_000 }).catch(() => {});
await still(400);
// The order is saved debounced: wait for it to change rather than a fixed time (slow CI runners).
// A drag that lands while a tile still glides can miss its target: take fresh positions and drag again.
let order2 = order1;
for (let attempt = 0; attempt < 3 && JSON.stringify(order2) === JSON.stringify(order1); attempt++) {
  if (attempt) await still();
  { const t = await visualTiles(); await t[1].locator(".tile-title").dragTo(t[0], { steps: 10 }); }
  order2 = await until(panesOrder, (o) => JSON.stringify(o) !== JSON.stringify(order1), 5000);
}
check(order2[0] === order1[1] && order2[1] === order1[0], "dragging back swaps the slots again");
// A real drag through three tiles: the dragged tile follows the pointer, the others make room.
await menu("file.newTerminal");
await until(panes, (n) => n === 3);
await menu("view.grid");
await until(() => countOf(".windows-track > .tile"), (n) => n === 3);
await still(400);
const order3 = await panesOrder().then((o) => o ?? []);
const vt = await visualTiles();
const src = await vt[0].locator(".tile-title").boundingBox();
const dst = await vt[2].boundingBox();
await win.mouse.move(src.x + 40, src.y + 10);
await win.mouse.down();
await win.mouse.move(src.x + 60, src.y + 30, { steps: 4 });
await win.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2, { steps: 12 });
check((await until(() => countOf(".tile.lifted"), (n) => n === 1, 5000)) === 1, "the dragged tile is lifted and follows the pointer");
await win.screenshot({ path: path.join(shots, "3b-grid-drag.png") });
await win.mouse.up();
const ids3 = await win.evaluate(() => window.cmd.call("pane.list", {}).then((p) => p.sort((a, b) => a.createdAt - b.createdAt).map((x) => x.id)));
const before3 = [...order3, ...ids3.filter((id) => !order3.includes(id))];
const expected = [before3[1], before3[2], before3[0]];
const order4 = await until(panesOrder, (o) => JSON.stringify(o) === JSON.stringify(expected));
check(JSON.stringify(order4) === JSON.stringify(expected), "dropping the first tile on the third inserts it there and shifts the others");
await menu("file.close"); // back to two terminals for the checks below
await until(panes, (n) => n === 2);
await still();
await win.screenshot({ path: path.join(shots, "3-grid.png") });
await menu("view.focus");
});

await scenario("palette", async () => {
  const before = await panes();
  await menu("view.palette");
  await win.waitForSelector(".palette");
  await focused(".palette-input");
  await win.keyboard.type("next");
  await until(() => win.locator(".palette-input").inputValue(), (v) => v === "next");
  await win.screenshot({ path: path.join(shots, "4-palette.png") });
  await menu("file.close"); // ⌘W closes the palette first
  await gone(".palette");
  check((await win.locator(".palette").count()) === 0, "⌘W closes the palette before any terminal");
  const n = await until(panes, (n) => n !== before, 1000); // a wrongly closed terminal would show by then
  check(n === before, `…and leaves terminals alone (${n})`);
});

// Session search: ?query in the palette, Enter resumes the session in a new terminal.
await scenario("session-search", async () => {
  await menu("view.palette");
  await win.waitForSelector(".palette");
  await focused(".palette-input");
  await win.keyboard.type("?wiregaurd"); // typo on purpose
  await win.waitForSelector(".palette.searching");
  await win.waitForSelector(".palette-list li.rich", { timeout: 15000 });
  const label = await win.locator(".palette-list li.rich .palette-label").first().textContent();
  const snippet = await win.locator(".palette-snippet mark").first().textContent();
  check(label === "VPN auto reconnect" && /wireguard/i.test(snippet ?? ""), `session search finds past sessions, typo-tolerant (${label}: ${snippet})`);
  await win.screenshot({ path: path.join(shots, "4b-search.png") });
  const before = await panes();
  await until(() => countOf(".palette-list li.on.rich"), (n) => n === 1); // Enter acts on the highlighted row
  await win.keyboard.press("Enter");
  const agentList = () => win.evaluate(() => window.cmd.call("agent.list", {}));
  await until(panes, (n) => n === before + 1);
  const agents = await until(agentList, (a) => a.some((x) => x.native.claudeSessionId === "e2e-session-1"));
  check((await panes()) === before + 1 && agents.some((a) => a.native.claudeSessionId === "e2e-session-1"), "Enter resumes the session in a new terminal");
  // the resumed "agent" is just echo; close its terminal directly (no confirmation sheet)
  const resumed = agents.find((a) => a.native.claudeSessionId === "e2e-session-1");
  await win.evaluate((id) => window.cmd.call("pane.kill", { paneId: id }), resumed.paneId);
  await until(panes, (n) => n === before);
});

// Search (⇧⌘F): the palette with ? typed, over open windows and past sessions.
await scenario("search", async () => {
  await menu("view.search");
  await win.locator(".palette").waitFor();
  check((await until(() => win.locator(".palette-input").inputValue(), (v) => v === "?")) === "?", "⇧⌘F opens the palette in search mode");
  await focused(".palette-input");
  await win.keyboard.type("wiregaurd");
  await win.waitForSelector(".palette .palette-label:has-text('VPN auto reconnect')", { timeout: 15000 }).catch(() => {});
  check((await win.locator(".palette .palette-label", { hasText: "VPN auto reconnect" }).count()) > 0, "the palette's search finds past sessions, typos and all");
  await win.screenshot({ path: path.join(shots, "4b-palette-search.png") });
  await win.keyboard.press("Escape");
  await win.locator(".palette").waitFor({ state: "detached" });
});

// Sidebar search: the Navigator's field filters open windows and searches past sessions; Esc leaves.
await scenario("sidebar-search", async () => {
  await win.locator(".sb-search input").click();
  await focused(".sb-search");
  await win.keyboard.type("wiregaurd");
  await win.waitForSelector(".navigator .ui-list-row.history", { timeout: 15000 });
  const label = await win.locator(".navigator .ui-list-row.history .ui-list-row-name").first().textContent();
  check(label === "VPN auto reconnect", `sidebar search finds past sessions (${label})`);
  await win.screenshot({ path: path.join(shots, "4c-sidebar-search.png") });
  await win.keyboard.press("Escape");
  check((await until(() => win.locator(".sb-search input").inputValue(), (v) => v === "")) === "", "Esc clears the sidebar search");
  await win.keyboard.press("Escape");
  await win.waitForSelector(".sb-recent .ui-list-row.history", { timeout: 10_000 }).catch(() => {});
  check((await win.locator(".sb-recent .ui-list-row.history").count()) > 0, "Recent lists past sessions from the index");
});

// Browser and file windows: the pages they load, and the folder they show.
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  if (req.url === "/media") return res.end("<title>E2E Media</title><body style='font:20px sans-serif;padding:20px'>A page that asks for the camera</body>");
  res.end("<title>E2E Page</title><body style='font:20px sans-serif;padding:20px'>Hello from a cmd browser window</body>");
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
fs.mkdirSync(path.join(home, "files-fixture", "sub-folder"), { recursive: true });
fs.writeFileSync(path.join(home, "files-fixture", "notes.txt"), "# hi");
fs.writeFileSync(path.join(home, "files-fixture", "sub-folder", "inner.txt"), "inside");
// The browser window the browser scenario opens, and the file window of the files one.
let browserWin = null;
let fw = null;

await scenario("browser", async () => {
  await menu("view.palette");
  await win.waitForSelector(".palette");
  await focused(".palette-input");
  await win.keyboard.type(`localhost:${port}`);
  const offer = await until(() => win.locator(".palette-list li").first().textContent({ timeout: 10_000 }), (t) => t.includes(`Open localhost:${port}`));
  check(offer.includes(`Open localhost:${port}`), `typing a URL offers to open it (${offer.trim()})`);
  await win.keyboard.press("Enter");
  browserWin = await until(() => win.evaluate(() => window.cmd.call("window.list", {})).then((all) => all.find((w) => w.kind === "browser" && w.title === "E2E Page")), Boolean, 15_000);
  check(!!browserWin && browserWin.state.url.startsWith(`http://localhost:${port}`), "browser window loads the page and reports its title");

  // Edit → Select All / Copy reach the page, which is its own WebContents (main/index.ts editNative).
  {
    const saved = await app.evaluate(({ clipboard }) => clipboard.readText());
    await app.evaluate(({ clipboard }) => clipboard.writeText(""));
    // The page takes focus a moment after the click (a slow runner took more than 200 ms):
    // wait until it has it, then Select All and Copy, again until the text arrives.
    const pageFocused = () => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getType() === "webview");
    let copied = "";
    for (let attempt = 0; attempt < 5 && !copied.includes("Hello from a cmd browser window"); attempt++) {
      await win.locator(".tile.kind-browser webview").click();
      await until(pageFocused, Boolean, 3000);
      await menu("edit.selectAll");
      await win.waitForTimeout(200); // for the selection to land in the page before Copy (not a read)
      await menu("edit.copy");
      copied = await until(() => app.evaluate(({ clipboard }) => clipboard.readText()), Boolean, 1000);
    }
    await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), saved);
    check(copied.includes("Hello from a cmd browser window"), `Select All and Copy work in a browser page (${JSON.stringify(copied)})`);
  }

  // Device Size (window menu): the page gets the device's viewport and, for phones, its user agent.
  {
    const page = (js) => win.evaluate((js) => document.querySelector(".tile.kind-browser webview").executeJavaScript(js), js);
    const pageUntil = (js, want) => until(() => page(js).catch(() => null), (got) => got === want);
    await win.evaluate((id) => window.cmd.call("window.update", { id, state: { device: "iphone-16" } }), browserWin.id);
    const w = await pageUntil("innerWidth", 393);
    const ua = await pageUntil("/iPhone/.test(navigator.userAgent)", true);
    check(w === 393 && ua === true, `a device size sets the page's viewport and user agent (${w}, ${ua})`);
    await win.screenshot({ path: path.join(shots, "browser-device.png") });
    await win.evaluate((id) => window.cmd.call("window.update", { id, state: { device: null } }), browserWin.id);
    const back = await pageUntil("/iPhone/.test(navigator.userAgent)", false);
    const fit = await pageUntil("innerWidth !== 393", true);
    check(back === false && fit === true, "Fit Window restores the window's size and the app's user agent");
  }
});

// A new, blank browser window shows the themed empty view, not a white page, until it loads one.
await scenario("blank-browser", async () => {
  const blankWin = await win.evaluate(() => window.cmd.call("window.open", { kind: "browser", input: {} }));
  try {
  await tileIn(blankWin.id);
  await select(blankWin.id);
  const blankView = win.locator(`.tile[data-pane="${blankWin.id}"] .ui-webstage .ui-viewstate`);
  await blankView.waitFor({ timeout: 10_000 }).catch(() => {});
  await win.screenshot({ path: path.join(shots, "browser-blank.png") });
  check(await blankView.isVisible(), "a blank browser window shows the empty view, not a white page");
  await win.evaluate(([id, url]) => window.cmd.call("window.update", { id, state: { url } }), [blankWin.id, `http://localhost:${port}`]);
  await blankView.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  check((await blankView.count()) === 0, "a blank window gets its page once given an address");
  } finally {
    await win.evaluate((id) => window.cmd.call("window.close", { id }), blankWin.id);
  }
});

  // A page asking for the camera and microphone gets cmd's sheet, never a silent grant;
  // Don't Allow is kept for the site, so it isn't asked again (main/web-session.ts).
await scenario("site-permissions", async () => {
  {
    const page = (js) => win.evaluate((js) => document.querySelector(".tile.kind-browser webview").executeJavaScript(js), js);
    await win.evaluate(([id, url]) => window.cmd.call("window.update", { id, state: { url } }), [browserWin.id, `http://localhost:${port}/media`]);
    await until(() => page("location.pathname").catch(() => null), (p) => p === "/media");
    await page(`window.__gum = navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(() => "granted", (e) => e.name); 0`);
    const sheet = win.locator(".site-permission:not([data-closing])"); // not one fading out
    await sheet.waitFor({ timeout: 10_000 }).catch(() => {});
    const title = (await sheet.locator(".ui-dialog-title").textContent().catch(() => "")) ?? "";
    await win.screenshot({ path: path.join(shots, "site-permission.png") });
    check(title.includes(`localhost:${port}`) && title.includes("camera and microphone"), `a page asking for the camera gets cmd's sheet naming the site (${JSON.stringify(title)})`);
    await sheet.getByRole("button", { name: "Don't Allow" }).click();
    const got = await page("window.__gum");
    check(got === "NotAllowedError", `Don't Allow refuses the page's getUserMedia (${got})`);
    const again = await page(`navigator.mediaDevices.getUserMedia({ audio: true }).then(() => "granted", (e) => e.name)`);
    const kept = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(home, "site-permissions.json"), "utf8")); } catch { return {}; } }, (k) => k[`http://localhost:${port}`]?.media === false);
    check(again === "NotAllowedError" && (await sheet.count()) === 0 && kept[`http://localhost:${port}`]?.media === false, `the answer is kept for the site and not asked again (${again})`);
    // Deleting site-permissions.json forgets the answers, without a restart.
    fs.rmSync(path.join(home, "site-permissions.json"));
    await page(`window.__gum = navigator.mediaDevices.getUserMedia({ audio: true }).then(() => "granted", (e) => e.name); 0`);
    await sheet.waitFor({ timeout: 10_000 }).catch(() => {});
    const askedAgain = await sheet.count();
    await focused(".site-permission"); // Esc goes where the focus is
    await win.keyboard.press("Escape");
    const dismissed = await page("window.__gum");
    check(askedAgain === 1 && dismissed === "NotAllowedError" && !fs.existsSync(path.join(home, "site-permissions.json")), `deleting the saved answers asks again; Esc refuses without saving (${askedAgain}, ${dismissed})`);

    // Settings → Browser lists the answers and removes them: the site is asked again, no restart.
    step("site permissions in settings");
    const site = `http://localhost:${port}`;
    const keptNow = () => (fs.existsSync(path.join(home, "site-permissions.json")) ? JSON.parse(fs.readFileSync(path.join(home, "site-permissions.json"), "utf8")) : {});
    const answerNext = async (js, button) => {
      await page(`window.__ask = ${js}; 0`);
      await sheet.waitFor({ timeout: 10_000 }).catch(() => {});
      if (button) await sheet.getByRole("button", { name: button, exact: true }).click();
      else await focused(".site-permission"), await win.keyboard.press("Escape");
      return page("window.__ask");
    };
    const waitUntil = (fn) => until(() => { try { return fn(); } catch { return false; } }, Boolean); // a file read mid-write throws
    const gum = `navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(() => "granted", (e) => e.name)`;
    const granted = await answerNext(gum, "Allow");
    const notified = await answerNext(`Notification.requestPermission()`, "Don't Allow");
    check(granted === "granted" && notified === "denied" && keptNow()[site]?.media === true && keptNow()[site]?.notifications === false, `Allow and Don't Allow are kept (${granted}, ${notified})`);
    const opened = app.waitForEvent("window");
    await menu("app.settings");
    const sw = await opened;
    sw.on("pageerror", (e) => console.log("settings pageerror:", e.message));
    await sw.waitForSelector(".ui-split-pane .ui-list-row");
    await sw.locator(".ui-split-pane .ui-list-row", { has: sw.getByText("Browser", { exact: true }) }).click();
    const section = sw.locator(".ui-form-section", { hasText: `localhost:${port}` });
    await section.waitFor({ timeout: 10_000 }).catch(() => {});
    const rows = async () => (await section.locator(".ui-row").allTextContents().catch(() => [])).map((t) => t.replace(/Remove$/, ""));
    const listed = await rows();
    await sw.screenshot({ path: path.join(shots, "site-permissions-settings.png") });
    check(listed.join("|") === "Camera and microphoneAllowed|NotificationsNot allowed", `Settings → Browser lists the site's answers (${listed.join(", ")})`);
    await section.getByRole("button", { name: "Remove Camera and microphone", exact: false }).click();
    await waitUntil(() => keptNow()[site]?.media === undefined);
    await sw.screenshot({ path: path.join(shots, "site-permissions-removed-one.png") });
    check(JSON.stringify(keptNow()) === JSON.stringify({ [site]: { notifications: false } }) && (await rows()).length === 1, `Remove forgets one answer and keeps the rest (${JSON.stringify(keptNow())})`);
    const reasked = await answerNext(gum, "Allow");
    check(reasked === "granted", `a removed answer is asked again on the next visit, without a restart (${reasked})`);
    await section.locator(".ui-row", { hasText: "Camera and microphone" }).waitFor({ timeout: 10_000 }).catch(() => {});
    check((await rows()).length === 2, `an open Settings shows a new answer at once (${(await rows()).join(", ")})`);
    await section.getByRole("button", { name: `Remove All for localhost:${port}` }).click();
    const empty = sw.locator(".ui-empty", { hasText: "No site permissions yet" });
    await empty.waitFor({ timeout: 10_000 }).catch(() => {});
    await sw.screenshot({ path: path.join(shots, "site-permissions-empty.png") });
    check((await empty.count()) === 1 && JSON.stringify(keptNow()) === "{}", `Remove All forgets the site; the page says nothing is kept (${JSON.stringify(keptNow())})`);
    await sw.close();
    const askedAfterAll = await answerNext(`navigator.mediaDevices.getUserMedia({ audio: true }).then(() => "granted", (e) => e.name)`, null);
    check(askedAfterAll === "NotAllowedError" && JSON.stringify(keptNow()) === "{}", `after Remove All the site is asked again (${askedAfterAll})`);
    await win.evaluate(([id, url]) => window.cmd.call("window.update", { id, state: { url } }), [browserWin.id, `http://localhost:${port}/`]);
    await until(() => page("document.title").catch(() => null), (t) => t === "E2E Page");
  }
});

// OSC 8 links in terminal output: the text can say anything, so a link to another
// app (smb:) gets a native confirm naming the real URL, and opens nothing until
// answered; a web link still opens in a browser window (main/open-policy.ts).
await scenario("osc8", async () => {
  let term = null;
  let linked = null;
  try {
    await app.evaluate(({ dialog, shell }) => {
      globalThis.__opened = [];
      globalThis.__asked = [];
      globalThis.__restore = { box: dialog.showMessageBox, ext: shell.openExternal, path: shell.openPath };
      shell.openExternal = async (url) => void globalThis.__opened.push(url);
      shell.openPath = async (p) => (globalThis.__opened.push(p), "");
      dialog.showMessageBox = async (...args) => {
        const o = args.at(-1);
        globalThis.__asked.push({ message: o.message, detail: o.detail, buttons: o.buttons, sheet: args.length > 1 });
        return { response: o.cancelId ?? 1, checkboxChecked: false };
      };
    });
    term = await win.evaluate(() => window.cmd.call("window.open", { kind: "terminal", input: {} }));
    await tileIn(term.id);
    await select(term.id);
    const screen = win.locator(`.tile[data-pane="${term.id}"] .xterm-screen`);
    await screen.waitFor();
    await until(() => paneText(term.id, 5), (t) => /\S/.test(t));
    // The link's text fills the first row after `clear`, so a hover anywhere on it finds it.
    const printLink = async (uri, label) => {
      const { cols, rows } = (await win.evaluate(() => window.cmd.call("pane.list", {}))).find((p) => p.id === term.id);
      const text = label.repeat(cols).slice(0, cols - 2);
      await win.evaluate(([id, data]) => window.cmd.call("pane.write", { paneId: id, data }), [term.id, `clear; printf '\\e]8;;${uri}\\e\\\\${text}\\e]8;;\\e\\\\\\n'\r`]);
      await until(() => paneText(term.id, 5), (t) => t.startsWith(text.slice(0, 20)));
      // The core has it; the app's terminal draws it to a canvas a moment later (unreadable
      // here): a click that comes too early finds no link, and cmdClickRow0 is tried again.
      await win.waitForTimeout(200);
      return rows;
    };
    const cmdClickRow0 = async (rows) => {
      const box = await screen.boundingBox();
      const at = { x: box.x + box.width / 2, y: box.y + box.height / rows / 2 };
      await win.mouse.move(at.x - 20, at.y);
      await win.mouse.move(at.x, at.y, { steps: 3 });
      await win.waitForTimeout(150); // for xterm to see the hover before the click (not a read)
      await win.keyboard.down("Meta");
      await win.mouse.click(at.x, at.y);
      await win.keyboard.up("Meta");
    };
    // A click before xterm has seen the hover finds no link: click again until it does.
    let rows = await printLink("smb://example", "github.com ");
    let asked = [];
    for (let attempt = 0; attempt < 3 && !asked.length; attempt++) {
      await cmdClickRow0(rows);
      asked = await until(() => app.evaluate(() => globalThis.__asked), (a) => a.length > 0, 3000);
    }
    await win.screenshot({ path: path.join(shots, "open-policy-osc8.png") });
    const opened = await app.evaluate(() => globalThis.__opened);
    check(asked.length === 1 && /^Open smb:\/\/example( in .+)?\?$/.test(asked[0].message) && asked[0].sheet && asked[0].buttons.at(-1) === "Cancel", `an OSC 8 smb: link asks first, in a sheet naming the real URL (${JSON.stringify(asked)})`);
    check(opened.length === 0, `Cancel opens nothing (${JSON.stringify(opened)})`);
    rows = await printLink(`http://localhost:${port}/osc8`, "link ");
    for (let attempt = 0; attempt < 3 && !linked; attempt++) {
      await cmdClickRow0(rows);
      linked = await until(() => win.evaluate(() => window.cmd.call("window.list", {})).then((l) => l.find((w) => w.kind === "browser" && w.state.url?.endsWith("/osc8"))), Boolean, 4000);
    }
    const after = await app.evaluate(() => globalThis.__asked.length);
    check(!!linked && after === 1, `an OSC 8 http link opens in a browser window, without asking (${linked?.state.url})`);
  } finally {
    await app.evaluate(({ dialog, shell }) => globalThis.__restore && ((dialog.showMessageBox = globalThis.__restore.box), (shell.openExternal = globalThis.__restore.ext), (shell.openPath = globalThis.__restore.path)));
    for (const w of [term, linked]) if (w) await win.evaluate((id) => window.cmd.call("window.close", { id }), w.id);
  }
});

// The file window: the tree, and the keyboard driving it.
const rowsNow = () => win.locator(".tile.kind-files .ui-tree .ui-tree-row .ui-tree-name").allTextContents();
const rowsAre = (want) => (rows) => JSON.stringify(rows) === JSON.stringify(want);
await scenario("files", async () => {
  fw = await win.evaluate((p) => window.cmd.call("window.open", { kind: "files", input: { path: p } }), path.join(home, "files-fixture"));
  await tileIn(fw.id);
  await select(fw.id);
  await win.waitForSelector(".tile.kind-files .ui-tree .ui-tree-row");
  const selName = () => win.locator(".tile.kind-files .ui-tree .ui-tree-row[data-selected] .ui-tree-name").textContent();
  const filesPath = () => win.evaluate(() => window.cmd.call("window.list", {})).then((l) => l.find((w) => w.kind === "files").state.path);
  check(rowsAre(["sub-folder", "notes.txt"])(await until(rowsNow, rowsAre(["sub-folder", "notes.txt"]))), "file tree lists the folder, folders first");

  await win.locator(".tile.kind-files .ui-tree .ui-tree-row", { hasText: "sub-folder" }).dblclick();
  check(rowsAre(["sub-folder", "inner.txt", "notes.txt"])(await until(rowsNow, rowsAre(["sub-folder", "inner.txt", "notes.txt"]))), "double-clicking a folder expands it in place");

  // Keyboard: come from a terminal, then select the file window — arrows drive the tree.
  const firstPane = await win.evaluate(() => window.cmd.call("pane.list", {}).then((p) => p[0].id));
  await select(firstPane);
  await focusIn(firstPane);
  await select(fw.id);
  await focusIn(fw.id);
  await win.keyboard.press("Home");
  await win.keyboard.press("ArrowLeft"); // collapse
  check(rowsAre(["sub-folder", "notes.txt"])(await until(rowsNow, rowsAre(["sub-folder", "notes.txt"]))), "← collapses the selected folder (focus moved here from a terminal)");
  const selNameIs = async (want) => until(() => selName().catch(() => null), (n) => n === want);
  await win.keyboard.press("ArrowRight"); // expand
  await until(rowsNow, (r) => r.includes("inner.txt"));
  await win.keyboard.press("ArrowRight"); // into first child
  check((await selNameIs("inner.txt")) === "inner.txt", "→ expands, then steps into the folder");
  await win.keyboard.press("ArrowLeft");
  check((await selNameIs("sub-folder")) === "sub-folder", "← on a child jumps to its folder");
  await win.keyboard.type("n");
  check((await selNameIs("notes.txt")) === "notes.txt", "typing selects by name");
  await win.keyboard.press("Home");
  if (mac) {
    await selNameIs("sub-folder");
    await win.keyboard.press("Meta+ArrowDown");
    check((await until(filesPath, (p) => p.endsWith("sub-folder"))).endsWith("sub-folder"), "⌘↓ makes the folder the root");
    // ⌘↑ goes up from the root the window shows: wait until it shows the new one, not only
    // until the core has it (pressed before that, it went up from the old root, two levels).
    const inside = await until(rowsNow, rowsAre(["inner.txt"]));
    check(rowsAre(["inner.txt"])(inside), `⌘↓ shows the folder's contents (${inside.join(", ")})`);
    await focusIn(fw.id);
    await win.keyboard.press("Meta+ArrowUp");
    const fp = await until(filesPath, (p) => p.endsWith("files-fixture"));
    const sn = await selNameIs("sub-folder");
    check(fp.endsWith("files-fixture") && sn === "sub-folder", `⌘↑ goes back up and re-selects where you were (${path.basename(fp)}, ${sn})`);
  } else macOnly("⌘↓/⌘↑ in the file tree");
});

// The file window's menus: Add to Bookmarks, Move to Trash.
await scenario("files-menus", async () => {
  // Bookmarks: right-click → Add to Bookmarks; the toolbar's bookmark button lists them.
  {
    await app.evaluate(({ Menu }) => {
      globalThis.__bmPopup = Menu.prototype.popup;
      Menu.prototype.popup = function (o) {
        globalThis.__lastMenu = this.items.map((i) => i.label).filter(Boolean);
        this.items.find((i) => i.label === globalThis.__pick)?.click();
        o?.callback?.();
      };
      globalThis.__pick = "Add to Bookmarks";
    });
    await win.locator(".tile.kind-files .ui-tree .ui-tree-row", { hasText: "sub-folder" }).click({ button: "right" });
    const saved = await until(() => win.evaluate(() => window.cmd.call("ui.get", {})).then((u) => u["files.bookmarks"]), (b) => b?.length > 0);
    await app.evaluate(() => ((globalThis.__pick = null), (globalThis.__lastMenu = null)));
    await win.locator('.tile.kind-files [data-tip="Bookmarks"]').click();
    const listed = (await until(() => app.evaluate(() => globalThis.__lastMenu), Boolean)) ?? [];
    await app.evaluate(({ Menu }) => (Menu.prototype.popup = globalThis.__bmPopup));
    check(!!saved?.[0]?.path.endsWith("sub-folder") && saved[0].dir && listed.some((l) => l.startsWith("sub-folder —")),
      `a folder bookmarked from its menu is kept and listed by the bookmark button (${listed.slice(0, 3).join(", ")})`);
  }
  // Move to Trash asks first (the sheet is stubbed to answer Cancel): nothing moves.
  {
    await app.evaluate(({ dialog, Menu }) => {
      dialog.__orig ??= dialog.showMessageBox;
      dialog.__trashAsked = null;
      dialog.showMessageBox = async (_w, o) => ((dialog.__trashAsked = (o ?? _w).message), { response: 1 });
      globalThis.__bmPopup = Menu.prototype.popup;
      Menu.prototype.popup = function (o) {
        this.items.find((i) => i.label === "Move to Trash (⌘⌫)")?.click();
        o?.callback?.();
      };
    });
    await win.locator(".tile.kind-files .ui-tree .ui-tree-row", { hasText: "notes.txt" }).click({ button: "right" });
    const askedTrash = await until(() => app.evaluate(({ dialog }) => dialog.__trashAsked), Boolean);
    await win.waitForTimeout(300); // Cancel must keep the file: give a wrong move time to show
    await app.evaluate(({ dialog, Menu }) => ((dialog.showMessageBox = dialog.__orig), (Menu.prototype.popup = globalThis.__bmPopup)));
    check(askedTrash === "Move “notes.txt” to the Trash?" && (await win.locator(".tile.kind-files .ui-tree .ui-tree-row", { hasText: "notes.txt" }).count()) === 1,
      `Move to Trash asks first, and Cancel keeps the file (${askedTrash})`);
  }
});

// Files open in the window that suits them: notes.txt → text window; edit and ⌘S.
await scenario("text", async () => {
  await win.locator(".tile.kind-files .ui-tree .ui-tree-row", { hasText: "notes.txt" }).dblclick();
  await win.waitForSelector(".tile.kind-text .cm-content");
  const editorText = () => win.locator(".tile.kind-text .cm-content").textContent();
  check((await until(editorText, (t) => t === "# hi")) === "# hi", "double-clicking a text file opens it in a text window (CodeMirror)");
  await win.locator(".tile.kind-text .cm-content").click();
  await focused(".tile.kind-text .cm-content");
  await win.keyboard.press("End");
  await win.keyboard.type(" there");
  await until(editorText, (t) => t === "# hi there");
  await menu("file.save");
  const notes = () => fs.readFileSync(path.join(home, "files-fixture", "notes.txt"), "utf8");
  check((await until(notes, (t) => t === "# hi there")) === "# hi there", "⌘S saves the text window");

  // Live: outside edits show up in the editor; new files show up in the tree.
  fs.writeFileSync(path.join(home, "files-fixture", "notes.txt"), "# changed by an agent\n");
  const live = (await until(editorText, (t) => t?.includes("changed by an agent"))) ?? "";
  check(live.includes("changed by an agent"), "the text window reloads live when the file changes on disk");
  fs.writeFileSync(path.join(home, "files-fixture", "zz-new-file.txt"), "new");
  const rows = await until(rowsNow, (r) => r.includes("zz-new-file.txt"));
  check(rows.includes("zz-new-file.txt"), "the file tree shows new files live");
});

// Markdown window: rendered, highlighted code, local image, live, ⌘E ⇄ editor.
const mdDir = path.join(home, "md-fixture");
fs.mkdirSync(mdDir, { recursive: true });
await scenario("markdown", async () => {
  // 1×1 PNG
  fs.writeFileSync(path.join(mdDir, "dot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  fs.writeFileSync(path.join(mdDir, "README.md"), "# Hello cmd\n\nSome **bold** text and a [link](https://example.com).\n\n- [x] done\n- [ ] todo\n\n![dot](dot.png)\n\n```ts\nconst answer: number = 42;\n```\n");
  const md = await win.evaluate((p) => window.cmd.call("window.openTarget", { target: p }), path.join(mdDir, "README.md"));
  check(md.kind === "markdown", "README.md opens in a Markdown window");
  await tileIn(md.id);
  await select(md.id); // ⌘E below acts on the selected window
  await win.waitForSelector(".tile.kind-markdown .ui-doc h1");
  const h1 = await win.locator(".tile.kind-markdown .ui-doc h1").textContent();
  // Code highlighting waits for the language parser to load on demand.
  const tokens = await until(() => countOf(".tile.kind-markdown pre code span[class]"), (n) => n > 0);
  const imgOk = await until(() => win.locator(".tile.kind-markdown .ui-doc img").evaluate((img) => img.complete && img.naturalWidth === 1, null, { timeout: 10_000 }), Boolean, 5000);
  check(h1 === "Hello cmd" && tokens > 0, `Markdown renders with highlighted code (${tokens} tokens)`);
  check(imgOk, "relative images load through cmd-file:");
  fs.appendFileSync(path.join(mdDir, "README.md"), "\n## Added live\n");
  await win.waitForSelector(".tile.kind-markdown .ui-doc h2", { timeout: 10_000 });
  check(true, "Markdown re-renders live when the file changes");
  await menu("view.toggleEdit");
  await win.waitForSelector(`.tile.kind-text[data-pane="${md.id}"] .cm-content`, { timeout: 10_000 });
  check(true, "⌘E switches the same window to the editor");
  await menu("view.toggleEdit");
  await win.waitForSelector(`.tile.kind-markdown[data-pane="${md.id}"] .ui-doc h1`, { timeout: 10_000 });
  check(true, "⌘E switches back to the preview");
});

// JSON window: a tree, rows fold, ⌘E opens the editor at the selected row's line and back, live, JSON Lines.
await scenario("json", async () => {
  const opened = []; // closed at the end, passed or not (the window-kinds count)
  try {
  const jsonFile = path.join(mdDir, "data.json");
  fs.writeFileSync(jsonFile, JSON.stringify({ name: "cmd", list: [1, 2, 3], nested: { deep: { value: true } } }, null, 2) + "\n");
  const js = await win.evaluate((p) => window.cmd.call("window.openTarget", { target: p }), jsonFile);
  opened.push(js);
  check(js.kind === "json", "data.json opens in a JSON window");
  await tileIn(js.id);
  await select(js.id);
  const jsonTile = `.tile.kind-json[data-pane="${js.id}"]`;
  await win.waitForSelector(`${jsonTile} .json-row`);
  const keys = await until(() => win.locator(`${jsonTile} .json-key`).allTextContents(), (k) => k.join(",") === "name,list,nested,deep");
  check(keys.join(",") === "name,list,nested,deep", `the JSON tree opens two levels (${keys.join(", ")})`);
  await win.locator(`${jsonTile} .json-row`, { hasText: "deep" }).locator(".ui-twisty").click();
  await win.waitForSelector(`${jsonTile} .json-key:text-is("value")`, { timeout: 10_000 });
  check(true, "a row unfolds");
  await win.locator(`${jsonTile} .json-row`, { hasText: "value" }).click();
  await until(() => win.locator(`${jsonTile} .json-row.sel .json-key`).textContent().catch(() => null), (k) => k === "value"); // ⌘E opens at the selected row
  await menu("view.toggleEdit");
  await win.waitForSelector(`.tile.kind-text[data-pane="${js.id}"] .cm-content`, { timeout: 10_000 });
  const cursorLine = await until(() => win.evaluate((id) => document.querySelector(`.tile.kind-text[data-pane="${id}"] .cm-activeLine`)?.textContent ?? "", js.id), (l) => l.includes("value"));
  check(cursorLine.includes('"value": true'), `⌘E opens the editor at the selected row's line (${cursorLine.trim()})`);
  await menu("view.toggleEdit");
  await win.waitForSelector(`${jsonTile} .json-row.sel`, { timeout: 10_000 });
  const back = await until(() => win.locator(`${jsonTile} .json-row.sel .json-key`).textContent().catch(() => null), (k) => k === "value");
  check(back === "value", `⌘E back selects the value at the cursor (${back})`);
  fs.writeFileSync(jsonFile, '{"name": "cmd", "added": 1}\n');
  await win.waitForSelector(`${jsonTile} .json-key:text-is("added")`, { timeout: 10_000 });
  check(true, "the JSON tree re-renders live");
  fs.writeFileSync(jsonFile, '{"name": "cmd", "added": ');
  const banner = await win.waitForSelector(`${jsonTile} .ui-callout`, { timeout: 10_000 }).then(() => true, () => false);
  check(banner && (await win.locator(`${jsonTile} .json-key:text-is("added")`).count()) === 1, "a half-written file keeps the last good tree under a banner");
  const linesFile = path.join(mdDir, "events.jsonl");
  fs.writeFileSync(linesFile, '{"event":"start"}\n{"event":"stop"}\nnot json\n');
  const jl = await win.evaluate((p) => window.cmd.call("window.openTarget", { target: p }), linesFile);
  opened.push(jl);
  await tileIn(jl.id);
  await select(jl.id);
  await win.waitForSelector(`.tile.kind-json[data-pane="${jl.id}"] .json-row`);
  const lineRows = await until(() => win.locator(`.tile.kind-json[data-pane="${jl.id}"] .json-index`).allTextContents(), (r) => r.length >= 3);
  const unreadable = await until(() => countOf(`.tile.kind-json[data-pane="${jl.id}"] .json-invalid`), (n) => n === 1);
  check(jl.kind === "json" && lineRows.slice(0, 3).join(",") === "1,2,3" && unreadable === 1, `JSON Lines: a row per line, bad lines shown (${lineRows.join(", ")})`);
  await win.screenshot({ path: path.join(shots, "10-json.png") });
  } finally {
    for (const w of opened) await win.evaluate((id) => window.cmd.call("window.close", { id }), w.id);
  }
});

await scenario("window-kinds", async () => {
  await menu("view.grid");
  const kinds = async () => [await countOf(".tile.kind-browser"), await countOf(".tile.kind-files"), await countOf(".tile.kind-text"), await countOf(".tile.kind-markdown")].join();
  await until(kinds, (k) => k === "1,1,1,1");
  await still();
  await win.screenshot({ path: path.join(shots, "10-window-kinds.png") });
  check((await win.locator(".tile.kind-browser").count()) === 1 && (await win.locator(".tile.kind-files").count()) === 1 && (await win.locator(".tile.kind-text").count()) === 1 && (await win.locator(".tile.kind-markdown").count()) === 1, "browser, file, text and Markdown windows take part in the grid");
});

// A window whose view throws shows a fallback in its own tile (ErrorBoundary in
// WindowContent); the rest of the app stays live and terminals take input.
// __cmdBreakView is a test hook (windows/break.ts), absent in a packaged app.
await scenario("error-boundary", async () => {
  // Both windows on screen: the broken one's Reload button is clicked after typing in the terminal.
  await menu("view.grid");
  await win.waitForSelector(".main.mode-grid", { timeout: 10_000 });
  {
    const broken = (await win.evaluate(() => window.cmd.call("window.list", {}))).find((w) => w.kind === "markdown");
    await win.evaluate((id) => window.__cmdBreakView(id, true), broken.id);
    const fallback = win.locator(`.tile[data-pane="${broken.id}"] .ui-viewstate[data-kind="error"]`);
    const shown = await fallback.waitFor({ timeout: 10_000 }).then(() => true, () => false);
    check(shown && (await fallback.textContent()).includes("This window stopped working"), "a window whose view throws shows its fallback in its own tile");
    const term = win.locator(".tile.kind-terminal").first();
    const termId = await term.getAttribute("data-pane");
    await select(termId);
    await term.locator(".xterm").click();
    // Typed only once the terminal has focus, and given 10 s to echo: 3 s ran out on a busy CI runner.
    const hasFocus = await focused(`.tile[data-pane="${termId}"] .xterm`);
    await win.keyboard.type("echo still-live-$((6*7))");
    await win.keyboard.press("Enter");
    const text = await until(() => paneText(termId), (t) => t.includes("still-live-42"));
    const screen = text.trim().split("\n").slice(-3).join(" ⏎ ");
    check(text.includes("still-live-42") && (await win.locator(".topbar, .statusbar").count()) > 0, `with one window broken, the rest of the app renders and a terminal takes input (focused: ${hasFocus}; screen: ${screen})`);
    await win.screenshot({ path: path.join(shots, "10b-error-boundary.png") });
    await win.evaluate((id) => window.__cmdBreakView(id, false), broken.id);
    await fallback.locator("button", { hasText: "Reload Window" }).click();
    const back = await win.waitForSelector(`.tile.kind-markdown[data-pane="${broken.id}"] .ui-doc`, { timeout: 10_000 }).then(() => true, () => false);
    check(back && (await fallback.count()) === 0, "Reload Window mounts the view again");
  }
});

// New Text Editor: an untitled buffer whose text survives in the window's state;
// ⌘S asks where to save (the native panel is stubbed) and the window becomes that file's.
await scenario("untitled", async () => {
  const textWin = () => win.evaluate(() => window.cmd.call("window.list", {})).then((l) => l.filter((w) => w.kind === "text").sort((a, b) => b.createdAt - a.createdAt)[0]);
  // A new Untitled: in the core, then selected and shown (what ⌘W and typing act on).
  const newUntitled = async (not) => {
    await menu("file.newText");
    const w = await until(textWin, (w) => w?.title === "Untitled" && w.id !== not);
    if (w?.title === "Untitled") await until(selected, (s) => s === w.id);
    return w;
  };
  const draft = await newUntitled();
  check(draft?.title === "Untitled", "⇧⌘E opens an untitled text window");
  const untitled = win.locator(`.tile[data-pane="${draft.id}"] .cm-content`);
  await untitled.click();
  await focused(`.tile[data-pane="${draft.id}"] .cm-content`);
  await win.keyboard.type("scratch notes");
  check((await until(textWin, (w) => w.state.draft === "scratch notes")).state.draft === "scratch notes", "an untitled window keeps its unsaved text in the core");
  // ⌘W asks before losing that text (the sheet is stubbed to answer Cancel).
  const asked = () => app.evaluate(({ dialog }) => dialog.__asked);
  await app.evaluate(({ dialog }) => {
    dialog.__orig ??= dialog.showMessageBox;
    dialog.__asked = 0;
    dialog.showMessageBox = async () => (dialog.__asked++, { response: 1 });
  });
  const draftId = (await textWin()).id;
  await menu("file.close");
  await until(asked, (n) => n >= 1);
  await win.waitForTimeout(300); // Cancel must keep the window: give a wrong close time to show
  check((await asked()) === 1 && (await textWin()).id === draftId, "⌘W on an untitled window with text asks first, and Cancel keeps it");
  const savedAs = path.join(home, "files-fixture", "scratch.txt");
  await app.evaluate(({ dialog }, p) => (dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })), savedAs);
  await menu("file.save");
  const after = await until(textWin, (w) => w.title === "scratch.txt" && w.state.path === savedAs);
  await until(() => fs.existsSync(savedAs) && fs.readFileSync(savedAs, "utf8"), (t) => t === "scratch notes");
  check(fs.readFileSync(savedAs, "utf8") === "scratch notes" && after.title === "scratch.txt" && after.state.path === savedAs, "⌘S on an untitled window saves it where the panel says, and the window becomes that file's");
  await win.evaluate((id) => window.cmd.call("window.close", { id }), after.id);
  // An empty Untitled has nothing to lose: ⌘W closes it without asking.
  const emptyId = (await newUntitled(draftId)).id;
  await menu("file.close");
  const left = await until(() => win.evaluate(() => window.cmd.call("window.list", {})), (l) => !l.some((w) => w.id === emptyId));
  check((await asked()) === 1 && !left.some((w) => w.id === emptyId), "⌘W closes an empty untitled window without asking");
  await app.evaluate(({ dialog }) => (dialog.showMessageBox = dialog.__orig));
});

// Embedded pages: browser pages and Magic widgets run in their own process, so
// they report presses and sideways scrolls (renderer/src/embed.ts; browser pages
// through preload/guest.ts, widgets by postMessage). Magic widgets are staged
// with a widget and its data, so no model runs.
await scenario("embedded", async () => {
  const call = (m, p = {}) => win.evaluate(([m, p]) => window.cmd.call(m, p), [m, p]);
  const magic = [];
  try {
  for (const name of ["Alpha", "Beta"]) {
    const w = await call("window.open", { kind: "magic", input: {} });
    await call("window.update", {
      id: w.id,
      title: name,
      state: { prompt: name, phase: "ready", kind: "widget", html: '<div class="k-big" id="v">–</div><script>cmd.onData((d) => (v.textContent = d.text))</script>', source: null, refresh: 0, size: "m", lastData: { data: { text: `${name} data` }, at: Date.now() } },
    });
    magic.push(w.id);
  }
  await menu("view.grid");
  const frameText = (id, sel) => win.frameLocator(`.tile[data-pane="${id}"] iframe.magic-frame`).locator(sel).textContent({ timeout: 10_000 }).catch(() => null);
  const widgetText = await until(() => frameText(magic[0], "#v"), (t) => t === "Alpha data");
  check(widgetText === "Alpha data", "a Magic widget renders its data in its sandboxed frame");

  // A theme change reaches widgets live: CSS variables, and colours drawn from JavaScript (cmd.onTheme).
  const themed = await call("window.open", { kind: "magic", input: {} });
  await call("window.update", {
    id: themed.id,
    title: "Themed",
    state: { prompt: "themed", phase: "ready", kind: "widget", html: '<canvas id="c"></canvas><script>cmd.onTheme(() => (c.dataset.bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()))</script>', source: null, refresh: 0, size: "s", lastData: null },
  });
  const themedFrame = win.frameLocator(`.tile[data-pane="${themed.id}"] iframe.magic-frame`);
  const readTheme = () => themedFrame.locator("body").evaluate(() => ({ css: getComputedStyle(document.body).backgroundColor, js: document.getElementById("c")?.dataset.bg }), null, { timeout: 10_000 }).catch(() => ({}));
  const beforeTheme = await until(readTheme, (t) => !!t.js && !!t.css);
  const appearance = (await call("settings.get")).settings["theme.appearance"];
  await call("settings.set", { key: "theme.appearance", value: appearance === "light" ? "dark" : "light" });
  const afterTheme = await until(readTheme, (t) => t.css && t.css !== beforeTheme.css && t.js && t.js !== beforeTheme.js);
  await call("settings.set", { key: "theme.appearance", value: appearance });
  check(!!beforeTheme.js && afterTheme.css !== beforeTheme.css && afterTheme.js !== beforeTheme.js, `a theme change reaches a widget live, CSS and cmd.onTheme (${beforeTheme.js} → ${afterTheme.js})`);

  // Media: a widget's media origins are blocked by the frame's CSP until the person allows them.
  const radio = await call("window.open", { kind: "magic", input: {} });
  const radioHtml = '<div id="r">–</div><script>document.addEventListener("securitypolicyviolation",()=>r.textContent="blocked");const a=new Audio();a.onerror=()=>r.textContent==="–"&&(r.textContent="loaded");a.src="https://radio.invalid/live.aacp"</script>';
  await call("window.update", { id: radio.id, title: "Radio", state: { prompt: "radio", phase: "ready", kind: "widget", html: radioHtml, media: ["https://radio.invalid"], source: null, refresh: 0, size: "s", lastData: null } });
  const radioTile = win.locator(`.tile[data-pane="${radio.id}"]`);
  const radioText = () => frameText(radio.id, "#r");
  const asked = await until(() => radioTile.locator(".ui-webstage-cover").isVisible(), Boolean);
  const before = await until(radioText, (t) => t === "blocked");
  await radioTile.locator(".ui-webstage-cover .ui-button[data-variant=primary]").click();
  const after = await until(radioText, (t) => t === "loaded");
  await until(() => radioTile.locator(".ui-webstage-cover").count(), (n) => n === 0);
  const stored = await until(async () => (await call("window.list")).find((x) => x.id === radio.id).state.mediaAllowed, (m) => m?.[0] === "https://radio.invalid");
  check(asked && before === "blocked" && after === "loaded" && !(await radioTile.locator(".ui-webstage-cover").count()) && stored?.[0] === "https://radio.invalid", `a widget's media origins are asked for and then allowed by the frame's CSP (${asked}, ${before} → ${after})`);
  await call("window.close", { id: themed.id });

  // Links in a widget work only while its window is selected (underlined then): a click on
  // another window's link selects that window. Then a cmd browser window by default; the
  // default browser with open.links = "browser".
  const linked = await call("window.open", { kind: "magic", input: {} });
  const linkHtml = '<a id="l" href="https://link.invalid/a" target="_blank" style="display:block;padding:40px;text-decoration:none">link</a>';
  await call("window.update", { id: linked.id, title: "Links", state: { prompt: "links", phase: "ready", kind: "widget", html: linkHtml, source: null, refresh: 0, size: "s", lastData: null } });
  const firstPaneId = (await call("pane.list"))[0].id;
  await win.evaluate((id) => window.__cmdSelect?.(id), firstPaneId);
  const selected = () => win.evaluate(() => document.querySelector(".tile.sel")?.dataset.pane);
  await until(selected, (s) => s === firstPaneId);
  await still();
  const link = win.frameLocator(`.tile[data-pane="${linked.id}"] iframe.magic-frame`).locator("#l");
  const underline = () => link.evaluate((a) => getComputedStyle(a).textDecorationLine, null, { timeout: 10_000 }).catch(() => null);
  const linkWindows = async () => (await call("window.list")).filter((x) => x.kind === "browser" && JSON.stringify(x.state).includes("link.invalid"));
  const lockedLook = await until(underline, (u) => u === "none");
  await link.click({ timeout: 10_000 });
  const selectedNow = await until(selected, (s) => s === linked.id);
  const liveLook = await until(underline, (u) => u === "underline");
  const lockedOpened = (await linkWindows()).length;
  check(lockedLook === "none" && lockedOpened === 0 && selectedNow === linked.id && liveLook === "underline", `a widget's links wait until its window is selected, then show underlined (${lockedLook} → ${liveLook}, ${lockedOpened} opened)`);
  await link.click({ timeout: 10_000 });
  const inCmd = await until(linkWindows, (l) => l.length >= 1);
  await win.waitForTimeout(300); // one click, one window: give a second one time to show
  await app.evaluate(({ shell }) => {
    globalThis.__openExternal ??= shell.openExternal;
    shell.openExternal = async (u) => void (globalThis.__opened = u);
  });
  await call("settings.set", { key: "open.links", value: "browser" });
  await win.evaluate((id) => window.__cmdSelect?.(id), linked.id);
  await until(selected, (s) => s === linked.id);
  await until(underline, (u) => u === "underline");
  await link.click({ timeout: 10_000 });
  const external = await until(() => app.evaluate(() => globalThis.__opened), Boolean);
  check(inCmd.length === 1 && (await linkWindows()).length === 1 && external === "https://link.invalid/a", `a widget link opens a cmd browser window, or the default browser per open.links (${inCmd.length}, ${external})`);
  await app.evaluate(({ shell }) => (shell.openExternal = globalThis.__openExternal));
  await call("settings.reset", { key: "open.links" });
  for (const w of [linked, ...inCmd]) await call("window.close", { id: w.id });
  await still(600);

  // A click selects the window it lands in: wait for that, and return what is selected.
  const clickIn = async (loc, id) => {
    const b = await loc.boundingBox();
    await win.mouse.click(b.x + b.width / 2, b.y + b.height * 0.6);
    return until(selected, (s) => s === id, 5000);
  };
  const frame = (id) => win.locator(`.tile[data-pane="${id}"] iframe.magic-frame`);
  const page = win.locator(".tile.kind-browser webview");
  const pageId = await win.locator(".tile.kind-browser").getAttribute("data-pane");
  const term = win.locator(".tile.kind-terminal .xterm").first();
  const termId = await win.locator(".tile.kind-terminal").first().getAttribute("data-pane");
  const order = [];
  for (const [loc, id] of [[term, termId], [frame(magic[0]), magic[0]], [frame(magic[1]), magic[1]], [page, pageId], [frame(magic[0]), magic[0]]]) {
    order.push((await clickIn(loc, id)) === id);
  }
  check(order.every(Boolean), `clicking from one embedded page into the next selects each window (${order.map((x) => (x ? "✓" : "✗")).join(" ")})`);

  // Right-click in a widget opens its window's menu (host.js reports it; the native menu is stubbed to record and pick).
  await app.evaluate(({ Menu }) => {
    globalThis.__menuPopup ??= Menu.prototype.popup;
    Menu.prototype.popup = function (o) {
      globalThis.__lastMenu = this.items.map((i) => i.label).filter(Boolean);
      this.items.find((i) => i.label === globalThis.__pick)?.click();
      o?.callback?.();
    };
  });
  await app.evaluate(() => (globalThis.__pick = "Change…"));
  const b0 = await frame(magic[0]).boundingBox();
  await win.mouse.click(b0.x + b0.width / 2, b0.y + b0.height / 2, { button: "right" });
  const titleInput = win.locator(`.tile[data-pane="${magic[0]}"] .tile-title-input`);
  await titleInput.waitFor({ timeout: 10_000 });
  const menuItems = await app.evaluate(() => globalThis.__lastMenu);
  await until(selected, (s) => s === magic[0], 5000);
  check(menuItems[0] === "Change…" && menuItems.includes("Copy Request") && (await selected()) === magic[0], `right-click in a Magic widget opens its window's menu, Change first (${menuItems.slice(0, 3).join(", ")}…)`);
  const isFocused = (loc) => until(() => loc.evaluate((el) => el === document.activeElement).catch(() => false), Boolean, 5000);
  check(await isFocused(titleInput), "Change from that menu edits the title bar, focused");
  await win.keyboard.press("Escape");
  check(!(await until(() => titleInput.count(), (n) => n === 0, 5000)), "Esc puts the title back");
  await app.evaluate(({ Menu }) => (Menu.prototype.popup = globalThis.__menuPopup));

  await clickIn(frame(magic[0]), magic[0]);
  await menu("view.magicChange");
  const input = win.locator(`.tile[data-pane="${magic[0]}"] .tile-title-input`);
  await input.waitFor({ timeout: 10_000 });
  check(await isFocused(input), "⌘L (a menu command) opens Change in the selected Magic widget's title bar, even with the widget focused");
  await win.keyboard.press("Escape");

  await menu("view.strip");
  await still(800);
  const offset = () => win.evaluate(() => document.querySelector(".windows-scroller").scrollLeft);
  const scrolls = async (loc, id) => {
    await select(id); // the strip reveals it
    await still(700);
    const b = await loc.boundingBox();
    await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    for (const dx of [60, -60]) {
      const before = await offset();
      for (let i = 0; i < 3; i++) await win.mouse.wheel(dx, 0), await win.waitForTimeout(16);
      // The page forwards the wheel to the strip by IPC: on a slow runner it lands later.
      const moved = (await until(offset, (o) => o !== before, 1500)) !== before;
      await still(300); // let it snap back to a window
      if (moved) return true;
    }
    return false;
  };
  check(await scrolls(frame(magic[0]), magic[0]), "sideways scrolling over a Magic widget scrolls the strip");
  check(await scrolls(page, pageId), "sideways scrolling over a browser page scrolls the strip");
  } finally {
    await menu("view.grid");
    for (const id of magic) await call("window.close", { id }).catch(() => {});
  }
});

// Magic v2 (docs/14-magic-v2.md): cmd.state survives the frame, the app renders
// previews for the core, and a widget folder's data.ts runs in the core (Deno,
// validated against its schema). The folder is staged as a revision and brought
// back with magic.restore, the path a real build ends in; no model runs.
await scenario("magic", async () => {
  const call = (m, p = {}) => win.evaluate(([m, p]) => window.cmd.call(m, p), [m, p]);
  // Every widget on screen: the edit view below is opened by a click on its window.
  await menu("view.grid");
  await win.waitForSelector(".main.mode-grid", { timeout: 10_000 });
  const rt = await call("magic.runtime");
  check(rt.previewer === "app", `the app renders widget previews for the core (${rt.previewer})`);

  // cmd.state: kept by the core, there again in a new frame.
  const kept = await call("window.open", { kind: "magic", input: {} });
  const counter = (v) => `<div id="k"></div><script>/*${v}*/const n=(cmd.state.get("n")||0)+1;cmd.state.set("n",n);k.textContent=String(n)</script>`;
  await call("window.update", { id: kept.id, title: "Kept", state: { prompt: "kept", phase: "ready", kind: "widget", html: counter(1), refresh: 0, size: "s", lastData: null } });
  const storedN = await until(async () => (await call("window.list")).find((x) => x.id === kept.id).state.kv?.n, (n) => n === 1);
  await call("window.update", { id: kept.id, state: { html: counter(2) } });
  const keptText = () => win.frameLocator(`.tile[data-pane="${kept.id}"] iframe.magic-frame`).locator("#k").textContent({ timeout: 10_000 }).catch(() => null);
  const shownN = await until(keptText, (t) => t === "2");
  check(storedN === 1 && shownN === "2", `cmd.state is kept by the core across frames (${storedN}, ${shownN})`);
  await call("window.close", { id: kept.id });

  const deno = rt.deno;
  if (!deno) console.log("  (skipped: no Deno for widget data)");
  else {
    const w = await call("window.open", { kind: "magic", input: {} });
    const dir = path.join(home, "widgets", w.id);
    const files = {
      "manifest.json": JSON.stringify({ cmd: 2, kind: "widget", title: "Counter", size: "s", refresh: 0, config: [{ key: "start", title: "Start", type: "number", default: 40 }] }),
      "data.ts": 'import { s, type Infer } from "cmd";\nexport const schema = s.object({ n: s.number() });\nexport type Data = Infer<typeof schema>;\nexport default async (c: { start: number }): Promise<Data> => ({ n: c.start + 2 });\n',
      "view.html": '<div class="k-big" id="n">–</div>',
      "view.ts": 'import type { Data } from "./data.ts";\nconst el = document.getElementById("n")!;\ncmd.onData<Data>((d) => { el.textContent = String(d.n); });\n',
    };
    const rev = path.join(dir, "revisions", "0001");
    for (const [f, t] of Object.entries(files)) {
      fs.mkdirSync(path.join(rev, "files"), { recursive: true });
      fs.writeFileSync(path.join(rev, "files", f), t);
    }
    fs.writeFileSync(path.join(rev, "meta.json"), JSON.stringify({ n: 1, at: Date.now(), prompt: "a counter", ok: true }));
    await call("window.update", { id: w.id, state: { prompt: "a counter", phase: "ready", widgetId: w.id } });
    await call("magic.restore", { id: w.id, revision: 1 });
    const frameN = () => win.frameLocator(`.tile[data-pane="${w.id}"] iframe.magic-frame`).locator("#n").textContent({ timeout: 10_000 }).catch(() => "");
    let shown = await until(frameN, (t) => t === "42", 20_000);
    const st = await until(async () => (await call("window.list")).find((x) => x.id === w.id), (x) => x.title === "Counter" && x.state.hasData && x.state.revision === 2, 5000);
    check(shown === "42" && st.title === "Counter" && st.state.hasData && st.state.revision === 2, `a widget's data.ts runs in the core and its typed view shows it (${shown}, ${st.title}, v${st.state.revision})`);

    // Its settings reach data.ts.
    await call("magic.config", { id: w.id, values: { start: 98 } });
    shown = await until(frameN, (t) => t === "100", 20_000);
    check(shown === "100", `a widget's settings reach its data (${shown})`);

    // ⌘E: the edit view, with its versions; ⌘E again: back to the widget.
    await win.locator(`.tile[data-pane="${w.id}"]`).click({ position: { x: 20, y: 10 } });
    await until(() => win.evaluate(() => document.querySelector(".tile.sel")?.dataset.pane), (s) => s === w.id, 5000);
    await menu("view.toggleEdit");
    const tile = win.locator(`.tile[data-pane="${w.id}"]`);
    const versions = await until(() => tile.locator(".magic-revision").count(), (n) => n === 2);
    const tabs = await until(() => tile.locator(".ui-tb-seg [role=radio]").allTextContents(), (t) => t.join(",").startsWith("Changes,Settings,Files,Health"), 5000);
    // A narrow tile (CI's smaller screen) compacts the tabs into a popup.
    const settingsTab = tile.locator(".ui-tb-seg [role=radio]", { hasText: "Settings" });
    if (await settingsTab.isVisible()) await settingsTab.click();
    else {
      await tile.locator(".ui-tb-seg-pop").click();
      await win.getByRole("menuitemradio", { name: "Settings" }).click();
    }
    const fields = await until(() => tile.locator(".ui-row").allTextContents(), (f) => f.some((x) => x.includes("Start")));
    await win.screenshot({ path: path.join(shots, "magic-edit.png") });
    await menu("view.toggleEdit");
    await until(() => tile.locator(".magic-edit").count(), (n) => n === 0);
    check(versions === 2 && tabs.join(",").startsWith("Changes,Settings,Files,Health") && fields.some((f) => f.includes("Start")) && !(await tile.locator(".magic-edit").count()), `⌘E shows a widget's edit view (versions, settings) and back (${versions}, ${tabs.join("/")})`);
    await call("window.close", { id: w.id });

    // The Widget Library (docs/16-widgets.md): widgets have their own menu; a closed one stays in the library and comes back from it.
    const menuLabels = await app.evaluate(({ Menu }) => Object.fromEntries(Menu.getApplicationMenu().items.map((m) => [m.label, m.submenu?.items.filter((i) => i.visible && i.type !== "separator").map((i) => i.label) ?? []])));
    check(!menuLabels.File.some((l) => /widget/i.test(l)) && menuLabels.Widgets?.[0] === "Widget Library…" && menuLabels.Widgets.includes("New Widget with Magic…"), `File has windows only; widgets have their own menu (${menuLabels.Widgets?.join(", ")})`);
    await menu("widget.library");
    await win.waitForSelector(".widget-library .wl-card", { timeout: 10_000 });
    const cards = await until(() => win.locator(".widget-library .wl-name").allTextContents(), (c) => c[0] === "Counter" && c.includes("Agent Activity") && c.includes("Live Diff"), 5000);
    await win.screenshot({ path: path.join(shots, "widget-library.png") });
    const magicButton = await win.locator(".widget-library .ui-dialog-foot button", { hasText: "New Widget" }).count();
    check(magicButton === 1 && cards[0] === "Counter" && cards.includes("Agent Activity") && cards.includes("Live Diff"), `the Widget Library has New Widget in its footer, then the closed widget and the built-ins (${cards.join(", ")})`);
    await win.locator(".widget-library .wl-card", { hasText: "Counter" }).click();
    const back = await until(async () => (await call("window.list")).find((x) => x.kind === "magic" && x.title === "Counter" && x.state.phase === "ready"), Boolean);
    await gone(".widget-library");
    await until(() => countOf(".widget-library"), (n) => n === 0, 5000);
    const listed = await until(async () => (await call("widget.list")).find((e) => e.title === "Counter"), (l) => back && l?.windows.includes(back.id), 5000);
    await until(() => countOf(".sb-widgets"), (n) => n === 1, 5000);
    check(!!back && (await win.locator(".widget-library").count()) === 0 && listed?.windows.includes(back.id) && (await win.locator(".sb-widgets").count()) === 1, `a widget comes back from the library, on the board and in the Navigator's Widgets (${listed?.windows.length})`);
    await menu("widget.library");
    await win.waitForSelector(".widget-library", { timeout: 10_000 });
    await menu("file.close");
    // The command reaches the renderer over IPC after the click returns: wait for the sheet to go.
    const libraryClosed = await win.waitForSelector(".widget-library", { state: "detached", timeout: 10_000 }).then(() => true, () => false);
    check(libraryClosed, "⌘W closes the Widget Library first");
    await call("window.close", { id: back.id });

    // New… (⌘N): windows first, then your widgets and the built-in ones, then Magic; typing finds one.
    await menu("file.new");
    await win.waitForSelector(".palette", { timeout: 10_000 });
    const offered = await until(() => win.locator(".palette-list .palette-label").allTextContents(), (o) => o.at(-1) === "New Widget with Magic" && o.includes("Counter"), 5000);
    await win.mouse.move(0, 0);
    await win.waitForTimeout(500); // the rows' symbols load from macOS
    await win.screenshot({ path: path.join(shots, "new-picker.png") });
    await win.locator(".palette-input").fill("timer");
    // Enter acts on the highlighted row: wait until the filter has made it Timer (pressing at once raced the re-render).
    await win.waitForSelector(".palette-list li.on .palette-label:text-is('Timer')", { timeout: 10_000 }).catch(() => {});
    await win.keyboard.press("Enter");
    const timer = await until(async () => (await call("window.list")).find((x) => x.kind === "timer"), Boolean);
    await gone(".palette");
    check(
      offered[0] === "Terminal" && offered.indexOf("Counter") > offered.indexOf("Text Editor") && offered.at(-1) === "New Widget with Magic" && !!timer && (await win.locator(".palette").count()) === 0,
      `New… lists windows, then widgets, then Magic, and opens what you type (${offered.join(", ")}; timer ${!!timer}, palette ${await win.locator(".palette").count()})`,
    );
    if (timer) await call("window.close", { id: timer.id });

    // Built-in widgets: Live Diff shows a repository's changes; Agent Activity opens from the library too.
    const repo = path.join(home, "diff-repo");
    fs.mkdirSync(repo, { recursive: true });
    const g = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
    g("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
    const ld = await call("widget.add", { ref: "type:diff" });
    await call("window.update", { id: ld.id, state: { path: repo } });
    const ldTile = win.locator(`.tile[data-pane="${ld.id}"]`);
    const ldFiles = await until(() => ldTile.locator(".ui-list-row-name").allTextContents(), (f) => f.join(",") === "a.txt,b.txt");
    const ldLines = await until(() => ldTile.locator(".ui-diff-line[data-kind=add]").allTextContents(), (l) => l.includes("+two") && l.includes("+new"));
    check(ldFiles.join(",") === "a.txt,b.txt" && ldLines.includes("+two") && ldLines.includes("+new"), `Live Diff shows a repository's changes, untracked files too (${ldFiles.join(", ")})`);
    const aa = await call("widget.add", { ref: "type:agents" });
    await win.locator(`.tile[data-pane="${aa.id}"] .ui-view`).waitFor({ timeout: 10_000 });
    // Its scope is the title bar's menu, as in the other list widgets.
    const aaScope = await until(async () => (await win.locator(`.tile[data-pane="${aa.id}"] .tile-menu`).textContent()) ?? "", (t) => t.includes("This Workspace"));
    const inWidgets = await until(async () => (await win.locator(".sb-widgets").textContent()) ?? "", (t) => t.includes("Agent Activity") && t.includes("Changes · diff-repo"));
    check(inWidgets.includes("Agent Activity") && inWidgets.includes("Changes · diff-repo") && aaScope.includes("This Workspace"), `Agent Activity and Live Diff are listed under the sidebar's Widgets, Agent Activity's scope in its title bar (${aaScope})`);
    await call("window.close", { id: ld.id });
    await call("window.close", { id: aa.id });

    // Status and notifications from data.ts; actions from the view (after a click only).
    const b = await call("window.open", { kind: "magic", input: {} });
    const bdir = path.join(home, "widgets", b.id, "revisions", "0001");
    const bfiles = {
      "manifest.json": JSON.stringify({ cmd: 2, kind: "widget", title: "Builds", size: "s", refresh: 0, config: [{ key: "fail", title: "Failing", type: "number", default: 0 }] }),
      "data.ts": 'import { s, status, notify, type Infer } from "cmd";\nexport const schema = s.object({ fail: s.number() });\nexport type Data = Infer<typeof schema>;\nexport default async (c: { fail: number }): Promise<Data> => {\n  status({ text: c.fail ? `${c.fail} failing` : "all good", tone: c.fail ? "bad" : "good" });\n  if (c.fail) notify({ key: `fail-${c.fail}`, title: "Build failed", body: `run ${c.fail}` });\n  return { fail: c.fail };\n};\n',
      "view.html": '<button class="k-btn" id="go">Rerun</button>',
      "view.ts": 'import type { Data } from "./data.ts";\ncmd.terminal("echo refused-without-a-click");\ndocument.getElementById("go")!.onclick = () => cmd.terminal("echo clicked-rerun");\ncmd.onData<Data>(() => {});\n',
    };
    fs.mkdirSync(path.join(bdir, "files"), { recursive: true });
    for (const [f, t] of Object.entries(bfiles)) fs.writeFileSync(path.join(bdir, "files", f), t);
    fs.writeFileSync(path.join(bdir, "meta.json"), JSON.stringify({ n: 1, at: Date.now(), prompt: "builds", ok: true }));
    await call("window.update", { id: b.id, state: { prompt: "builds", phase: "ready", widgetId: b.id } });
    await call("magic.restore", { id: b.id, revision: 1 });
    const btile = win.locator(`.tile[data-pane="${b.id}"]`);
    const bstate = async () => (await call("window.list")).find((x) => x.id === b.id).state;
    const statusText = () => btile.locator(".tile-status").textContent({ timeout: 10_000 }).then((t) => t ?? "", () => "");
    await until(statusText, (t) => t.includes("all good"), 15_000);
    await until(() => btile.locator('.mark[data-tone="success"]:not(.has-light)').count(), (n) => n === 1, 5000);
    check((await statusText()).includes("all good") && (await btile.locator('.mark[data-tone="success"]:not(.has-light)').count()) === 1, `a widget's status line shows in its title bar, its icon tinted, no light (${await statusText()})`);

    // Select another window, so the news isn't seen at once.
    const other = (await call("pane.list"))[0];
    await win.evaluate((id) => window.__cmdSelect?.(id), other.id);
    await until(() => win.evaluate(() => document.querySelector(".tile.sel")?.dataset.pane), (s) => s === other.id, 5000);
    await call("magic.config", { id: b.id, values: { fail: 1 } });
    await until(bstate, (st) => !!st.attention, 15_000);
    await until(statusText, (t) => t.includes("Build failed"), 5000);
    const marked = (await bstate()).attention;
    await win.screenshot({ path: path.join(shots, "magic-attention.png") });
    check(marked?.text === "Build failed" && (await statusText()).includes("Build failed"), `a widget's notification marks its window until seen (${marked?.text}, ${await statusText()})`);
    // Looking at it (selected, with the app in front) is seeing it.
    await win.evaluate((id) => window.__cmdSelect?.(id), b.id);
    await until(bstate, (st) => !st.attention);
    await until(statusText, (t) => t.endsWith("1 failing"), 5000);
    check(!(await bstate()).attention && (await statusText()).endsWith("1 failing"), `looking at the widget clears it, and its status shows again (${await statusText()})`);

    // cmd.terminal: refused at load, typed (not run) into a new terminal after a click.
    const known = new Set((await call("pane.list")).map((p) => p.id));
    const before = known.size;
    await win.frameLocator(`.tile[data-pane="${b.id}"] iframe.magic-frame`).locator("#go").click();
    const panes = await until(() => call("pane.list"), (p) => p.length !== before);
    const fresh = panes.filter((p) => !known.has(p.id));
    const typed = await until(async () => (fresh.length ? (await call("pane.read", { paneId: fresh.at(-1).id })).text ?? "" : ""), (t) => t.includes("clicked-rerun"));
    check(panes.length === before + 1 && typed.includes("echo clicked-rerun") && !typed.includes("refused"), `cmd.terminal types a command into a new terminal only after a click (${panes.length - before} new)`);
    await call("pane.kill", { paneId: fresh.at(-1).id }).catch(() => {});
    await call("window.close", { id: b.id });
  }
});

// Settings: its own native window (⌘,), generated from the schema; changes apply live.
await scenario("settings", async () => {
  const opened = app.waitForEvent("window");
  await menu("app.settings");
  const sw = await opened;
  sw.on("pageerror", (e) => console.log("settings pageerror:", e.message));
  await sw.waitForSelector(".ui-split-pane .ui-list-row");
  const allPages = ["Appearance", "Windows", "Terminal", "Opening Files", "Notifications", "AI & Agents", "Magic Widgets", "Browser", "Keyboard Shortcuts", "Updates & About"];
  const pages = await until(() => sw.locator(".ui-split-pane .ui-list-row-name").allTextContents(), (p) => allPages.every((x) => p.includes(x)), 5000);
  check(["Appearance", "Windows", "Terminal", "Opening Files", "Notifications", "AI & Agents", "Magic Widgets", "Browser", "Keyboard Shortcuts", "Updates & About"].every((p) => pages.includes(p)), `settings has its pages (${pages.join(", ")})`);

  // AI & Agents: a row per provider, models only once it has a key. Keys typed here are
  // checked with the provider first; this one goes in as `cmd settings secret`
  // does, so the run needs no network. Stored outside settings.json, shown as a hint.
  await sw.locator(".ui-split-pane .ui-list-row", { has: sw.getByText("AI & Agents", { exact: true }) }).click();
  await sw.waitForSelector(".ui-row-title:has-text('Anthropic')");
  const rowTitles = () => sw.locator(".ui-row-name").allTextContents();
  let titles = await until(rowTitles, (t) => t.includes("Anthropic") && t.includes("OpenAI"), 5000);
  check(titles.includes("Anthropic") && titles.includes("OpenAI") && !titles.includes("Model"), `AI lists the providers, and no models before a key (${titles.join(", ")})`);
  const rpc = (m, p = {}) => win.evaluate(([m, p]) => window.cmd.call(m, p), [m, p]);
  await rpc("secrets.set", { key: "ai.openai.apiKey", value: "sk-e2e-not-a-real-key-1234" });
  await sw.waitForSelector(".ui-secret-stored");
  titles = await until(rowTitles, (t) => t.includes("Model") && t.includes("Fast model"));
  await until(() => sw.locator(".ui-secret-stored").textContent(), (t) => t === "••••1234", 5000);
  const keyStatus = (await rpc("secrets.status", {}))["ai.openai.apiKey"];
  const settingsFile = fs.readFileSync(path.join(home, "settings.json"), "utf8");
  check(
    keyStatus.set && keyStatus.hint === "…1234" && (await sw.locator(".ui-secret-stored").textContent()) === "••••1234" && !settingsFile.includes("sk-e2e") && fs.existsSync(path.join(home, "secrets.json")),
    "an API key is stored outside settings.json and shown only as a hint",
  );
  check(titles.includes("Model") && titles.includes("Fast model"), "a key brings its provider's models");
  await rpc("secrets.set", { key: "ai.openai.apiKey", value: null });
  await sw.screenshot({ path: path.join(shots, "5-settings-terminal.png") });
  const page = (name) => sw.locator(".ui-split-pane .ui-list-row", { has: sw.getByText(name, { exact: true }) }).click();
  const row = (title) => sw.locator(".ui-row", { has: sw.locator(".ui-row-title", { hasText: title }) });
  const saved = () => JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8").replace(/^\/\/.*$/gm, ""));
  // fn may be async: until awaits it (a bare !fn() on a promise would pass at once).
  // A file read mid-write throws: that's "not yet".
  const waitFor = async (fn, what) => check(await until(() => Promise.resolve().then(fn).catch(() => false), Boolean), what);

  // Notifications: whether macOS shows them at all, read from macOS (Electron's bundle id in a dev build).
  await page("Notifications");
  const macos = sw.locator(".ui-row-title", { hasText: /^Notifications (are on|aren't on yet|are quiet|are off)$/ });
  await macos.waitFor();
  check(await macos.count() === 1, `Notifications says whether macOS shows them (${await macos.textContent()})`);
  await sw.screenshot({ path: path.join(shots, "5-settings-notifications.png") });
  await page("AI & Agents");

  // AI & Agents → Hooks: the fixture's Claude config, and Install writes cmd's hook into it.
  const claudeRow = sw.locator(".ui-row", { has: sw.locator(".ui-row-title", { hasText: "Claude Code" }) });
  await claudeRow.locator("button", { hasText: "Install" }).click();
  await claudeRow.locator("button", { hasText: "Remove" }).waitFor();
  const claudeSettings = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(transcripts, ".claude", "settings.json"), "utf8")); } catch { return {}; } }, (c) => !!c.hooks);
  check(JSON.stringify(claudeSettings.hooks?.PreToolUse ?? []).includes("/hooks/cmd-hook' claude"), "Settings → AI & Agents installs cmd's hook into the Claude config");
  await sw.screenshot({ path: path.join(shots, "5-settings-agents.png") });

  await page("Updates & About");
  await sw.waitForSelector(".ui-row:has-text('Status') .ui-text[data-select]");
  const status = await row("Status").locator(".ui-text[data-select]").textContent();
  check(/^pid \d+$/.test(status ?? ""), `About shows the running core (${status})`);

  await page("Terminal");
  const tags = await until(() => sw.locator(".ui-row-desc i").allTextContents(), (t) => t.filter((x) => x.includes("new terminals")).length === 3, 5000);
  check(tags.filter((t) => t.includes("new terminals")).length === 3, `settings that don't apply live say so (${tags.join(", ")})`);

  await page("Windows");
  await row("Show resource usage").locator(".ui-switch").click();
  await waitFor(() => saved()["ui.showResources"] === false, "a switch saves to settings.json");
  await row("Window corner radius").locator(".ui-number button[aria-label=Increase]").click();
  await waitFor(() => saved()["ui.windowRadius"] === 12, "+ steps a number field and saves");
  const radius = () => win.evaluate(() => document.documentElement.style.getPropertyValue("--window-radius"));
  check((await until(radius, (r) => r === "12px")) === "12px", "the app window applies it live");
  await row("Window corner radius").locator(".ui-reset").click();
  await sw.screenshot({ path: path.join(shots, "5-settings-interface.png") });
  await row("Show resource usage").locator(".ui-reset").click();
  await waitFor(() => !("ui.showResources" in saved()), "restore default removes the override");

  await page("Appearance");
  const fontSize = row("Code font size").locator("input");
  await fontSize.fill("16");
  await fontSize.press("Enter");
  await waitFor(() => saved()["font.codeSize"] === 16, "the code font size saves");
  const codePx = () => win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-code-size").trim());
  check((await until(codePx, (p) => p === "16px")) === "16px", "the app's file and Markdown windows get the code font size live (--font-code-size)");
  const fonts = await win.evaluate(() =>
    [".ui-tree .ui-tree-row", ".ui-doc", ".ui-doc code"].map((sel) => {
      const el = document.querySelector(sel);
      return el ? [sel, getComputedStyle(el).fontFamily, getComputedStyle(el).fontSize] : null;
    }),
  );
  check(fonts[0] && !/Monaspace/.test(fonts[0][1]) && fonts[0][2] === "13px", `file browser rows use the UI font, like the Navigator (${fonts[0]})`);
  check(fonts[1] && /system-ui|-apple-system/.test(fonts[1][1]), `Markdown prose uses the text font (${fonts[1]})`);
  check(!fonts[2] || /Monaspace/.test(fonts[2][1]), `Markdown code uses the code font (${fonts[2]})`);
  await row("Code font size").locator(".ui-reset").click();

  await page("Terminal");
  await row("Renderer").locator(".ui-seg button", { hasText: "WebGL" }).click();
  await waitFor(() => saved()["terminal.renderer"] === "webgl", "a segmented control saves its option");
  await page("Appearance");
  const size = row("Code font size").locator("input");
  await size.fill("");
  await size.press("Enter");
  await until(() => size.inputValue(), (v) => v === "14", 5000);
  check((await size.inputValue()) === "14" && !("font.codeSize" in saved()), "an emptied number field reverts instead of saving 0");
  await size.fill("99");
  await size.press("Enter");
  await waitFor(() => saved()["font.codeSize"] === 32, "a number field clamps to the setting's range");
  await row("Code font size").locator(".ui-reset").click();
  await page("Terminal");
  await row("Line height").locator(".ui-number input").focus();
  await row("Line height").locator(".ui-number input").press("ArrowUp");
  await waitFor(() => Math.abs(saved()["terminal.lineHeight"] - 1.15) < 1e-9, "↑ steps a number field by its step");
  await sw.locator(".ui-form-actions .ui-button").click();
  await waitFor(() => !("terminal.lineHeight" in saved()) && !("terminal.renderer" in saved()), "Restore Defaults resets the page");

  await sw.locator(".ui-split-pane .ui-search input").fill("zoom");
  const found = await until(() => sw.locator(".ui-row-name").allTextContents(), (f) => ["Minimum zoom", "Maximum zoom"].every((t) => f.some((x) => x.startsWith(t))), 5000);
  check(["Minimum zoom", "Maximum zoom"].every((t) => found.some((f) => f.startsWith(t))), `search finds settings across pages (${found.join(", ")})`);
  await sw.locator(".ui-split-pane .ui-search input").fill("");

  await page("Keyboard Shortcuts");
  check((await until(() => sw.locator(".ui-row[data-compact] kbd").count(), (n) => n > 10, 5000)) > 10, "keyboard shortcuts are listed");
  // Recording a shortcut: the menu lets go of its keys meanwhile; it's saved to keybindings.json.
  const kbFile = path.join(home, "keybindings.json");
  const lastWorkspace = row("Last Workspace");
  await lastWorkspace.hover();
  await lastWorkspace.locator(".ui-shortcut-add").click();
  await waitFor(async () => (await accel("view.palette")) === null, "the menu has no shortcuts while one is recorded");
  await sw.keyboard.press("Control+Alt+L");
  await waitFor(() => fs.existsSync(kbFile) && fs.readFileSync(kbFile, "utf8").includes('"workspace.last": ["Ctrl+Alt+L"]'), "a recorded shortcut is saved to keybindings.json");
  await waitFor(async () => (await accel("workspace.last")) === "Ctrl+Alt+L" && (await accel("view.palette")) !== null, "the menu takes the new shortcut and its others back");
  await lastWorkspace.locator(".ui-reset").click();
  await waitFor(() => !fs.readFileSync(kbFile, "utf8").includes("workspace.last"), "Restore default removes the shortcut from keybindings.json");
  await lastWorkspace.hover();
  await lastWorkspace.locator(".ui-shortcut-add").click();
  await until(async () => (await accel("view.palette")) === null, Boolean); // recording: the keys go to Settings, not the menu
  await sw.keyboard.press("Control+Alt+L");
  await waitFor(() => fs.readFileSync(kbFile, "utf8").includes("workspace.last"), "a second recording is saved");
  await sw.locator(".ui-form-actions .ui-button", { hasText: "Restore Defaults" }).click();
  await waitFor(() => !fs.readFileSync(kbFile, "utf8").includes("workspace.last"), "Restore Defaults puts every shortcut back");
  await sw.locator(".ui-split-pane .ui-search input").fill("palette");
  const paletteRows = await until(() => sw.locator(".ui-row[data-compact] .ui-row-name").allTextContents(), (r) => r.includes("Command Palette"), 5000);
  check(paletteRows.includes("Command Palette"), `search finds shortcuts (${paletteRows.join(", ")})`);
  await sw.locator(".ui-split-pane .ui-search input").fill("");
  await sw.screenshot({ path: path.join(shots, "5-settings-shortcuts.png") });
  await sw.close();
});

// Live remap via keybindings.json
await scenario("keybindings", async () => {
  fs.writeFileSync(path.join(home, "keybindings.json"), '// test\n{ "session.next": ["Ctrl+Tab"], "edit.clear": null }');
  const remapped = await until(() => accel("session.next"), (a) => a === "Ctrl+Tab");
  await until(() => accel("edit.clear"), (a) => a === null, 5000);
  check(remapped === "Ctrl+Tab", "keybindings.json remaps live");
  check((await accel("edit.clear")) === null, "null unbinds a shortcut");
});

// Closing the focused terminal returns to the previously used one (MRU), not a sidebar neighbour.
await scenario("mru", async () => {
  const n0 = await panes();
  await menu("file.newTerminal");
  await until(panes, (n) => n === n0 + 1);
  await shellReady();
  const list = await win.evaluate(() => window.cmd.call("pane.list", {}).then((p) => p.sort((a, b) => a.createdAt - b.createdAt).map((x) => x.id)));
  const [first, , newest] = [list[0], list[1], list[list.length - 1]];
  const selectedTile = () => win.evaluate(() => document.querySelector(".tile.sel")?.dataset.pane);
  const selectPane = async (id) => {
    await win.evaluate((id) => window.__cmdSelect?.(id), id);
    await until(selectedTile, (s) => s === id, 5000);
  };
  await selectPane(first);
  await selectPane(newest);
  await menu("file.close");
  await until(panes, (n) => n === n0);
  const sel = await until(async () => (await homeView())["selection.pane"], (s) => s === first);
  check(sel === first, "closing a terminal focuses the previously used one");
  // ⌘W next acts on the window the renderer shows selected.
  await until(selectedTile, (s) => s === first);
});

// ⌘W on an idle shell closes it without asking
await scenario("close-idle", async () => {
  const before = await panes();
  await menu("file.close");
  const n = await until(panes, (n) => n === before - 1);
  check(n === before - 1, `⌘W closes an idle terminal (${before} → ${n})`);
});

// ── PaperWM-style strip ──
await scenario("strip", async () => {
  try {
  for (let i = 0; i < 3; i++) {
    const n0 = await panes();
    await menu("file.newTerminal");
    await until(panes, (n) => n === n0 + 1);
  }
  await menu("view.strip");
  await win.waitForSelector(".main.mode-strip");
  await still(500);
  const pane = await win.locator(".main.mode-strip").boundingBox();
  const tiles = win.locator(".windows-track > .tile");
  const n = await tiles.count();
  const heights = await tiles.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  check(n >= 4 && heights.every((h) => Math.abs(h - heights[0]) < 1 && h > pane.height - 40), `strip: ${n} windows, all full height (${heights.map(Math.round).join(", ")} in a ${Math.round(pane.height)} pane)`);
  // The strip is a native scroller: its content sits at -scrollLeft.
  const trackX = () => win.locator(".windows-scroller").evaluate((e) => -e.scrollLeft);

  // keyboard: walk to the last window; it must end up fully visible
  for (let i = 0; i < n; i++) await menu("session.next");
  await still(500);
  const sel = await win.locator(".windows-track > .tile.sel").boundingBox();
  check(sel && sel.x >= pane.x - 1 && sel.x + sel.width <= pane.x + pane.width + 1 && (await trackX()) < 0,
    "⌥⌘→ scrolls the strip to reveal the selected window");

  // trackpad: a horizontal swipe left stays where it stopped (no snapping)
  await win.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  const before = -(await trackX());
  await win.mouse.wheel(-37, 0);
  await until(trackX, (x) => -x !== before, 3000);
  await still(700);
  check(Math.abs(-(await trackX()) - (before - 37)) < 1, "horizontal scroll moves freely and stays put");

  // pagination: a dot per window, in strip order; a dot brings its window into view
  await win.locator(".windows-scroller").evaluate((e) => (e.scrollLeft = e.scrollWidth));
  const dotIsCurrent = (i) => () => win.locator(".strip-dots button").nth(i).getAttribute("data-current", { timeout: 10_000 }).catch(() => null);
  await until(dotIsCurrent(n - 1), (c) => c === "true");
  check((await win.locator(".strip-dots button").count()) === n && (await win.locator(".strip-dots button[data-current]").count()) === 1
    && (await win.locator(".strip-dots button").last().getAttribute("data-current")) === "true",
    "the strip shows a pagination dot per window, the last one current at the end");
  await menu("session.prev");
  await until(dotIsCurrent(n - 2), (c) => c === "true");
  check((await win.locator(".strip-dots button").nth(n - 2).getAttribute("data-current")) === "true",
    "⌥⌘← from the last window moves the current dot, even when nothing scrolls");
  await win.mouse.wheel(60, 0);
  await until(dotIsCurrent(n - 1), (c) => c === "true");
  check((await win.locator(".strip-dots button").last().getAttribute("data-current")) === "true",
    "swiping on at the end of the strip makes the last dot current again, whatever is selected");
  // The swipe's scroll must have come to rest first: one still settling would carry on past the click.
  await still(300);
  await win.locator(".strip-dots button").first().click();
  const atStart = await until(async () => [await trackX(), await dotIsCurrent(0)()], ([x, c]) => Math.abs(x) < 1 && c === "true");
  check(Math.abs(atStart[0]) < 1 && atStart[1] === "true", `clicking the first dot scrolls the strip to its start (at ${Math.round(atStart[0])}, first dot current: ${atStart[1]})`);

  // ⌘↩ into focus and back: the strip returns to exactly where it was
  await still(300);
  const scrolled = await trackX();
  const selX = (await win.locator(".windows-track > .tile.sel").boundingBox()).x;
  await menu("view.toggleFocus");
  await win.waitForSelector(".main.mode-focus");
  await still();
  await menu("view.toggleFocus");
  await win.waitForSelector(".main.mode-strip");
  await still(600);
  const selX2 = (await win.locator(".windows-track > .tile.sel").boundingBox()).x;
  check(Math.abs((await trackX()) - scrolled) < 1 && Math.abs(selX2 - selX) < 1,
    `toggling focus returns the strip to its scroll position (${Math.round(scrolled)} → ${Math.round(await trackX())})`);

  // resizing the app window keeps the strip where it was scrolled to, even with
  // the selected window out of view
  {
    await win.locator(".windows-scroller").evaluate((e) => (e.scrollLeft = 0));
    await until(trackX, (x) => x === 0, 3000);
    await still(300);
    const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
    for (const dw of [-120, -60, 0]) {
      await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, BrowserWindow.getAllWindows()[0].getSize()[1]), size[0] + dw);
      await win.waitForTimeout(250); // a live resize, step by step (not a read)
    }
    await still(400);
    check((await trackX()) === 0, `resizing the window keeps the strip scrolled to the start (${Math.round(-(await trackX()))})`);
  }

  // resize by the right edge, capped at the pane width
  const first = (await visualTiles())[0];
  await select(await first.getAttribute("data-pane"));
  await still(500);
  const fb = await first.boundingBox();
  const handle = await first.locator('.strip-resize[data-edge="right"]').boundingBox();
  await win.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await win.mouse.down();
  await win.mouse.move(pane.x + pane.width - 2, handle.y + handle.height / 2, { steps: 8 });
  await win.mouse.up();
  await still(400);
  const fb2 = await first.boundingBox();
  check(fb2.width > fb.width && fb2.width <= pane.width - 16 + 1, `resizing is capped at the pane width (${Math.round(fb.width)} → ${Math.round(fb2.width)})`);
  await menu("view.cycleWidth");
  await still(400);
  const fb3 = await first.boundingBox();
  check(fb3.width < fb2.width, `⌃⌘R cycles width presets (${Math.round(fb2.width)} → ${Math.round(fb3.width)})`);
  // Every window has a left edge too: it grows the window leftwards (its right edge stays, the strip scrolls).
  {
    const second = (await visualTiles())[1];
    await select(await second.getAttribute("data-pane"));
    await still(600);
    const b = await second.boundingBox();
    const h = await second.locator('.strip-resize[data-edge="left"]').boundingBox();
    await win.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await win.mouse.down();
    await win.mouse.move(h.x + h.width / 2 - 50, h.y + h.height / 2, { steps: 6 });
    await win.mouse.up();
    await still(400);
    const b2 = await second.boundingBox();
    check(Math.abs(b2.x + b2.width - (b.x + b.width)) <= 1 && b2.width >= b.width + 45,
      `a window's left edge resizes it leftwards, its right edge staying put (${Math.round(b.width)} → ${Math.round(b2.width)})`);
  }
  // drag a window along the strip: the others make room (insert-style)
  {
    await select(await (await visualTiles())[0].getAttribute("data-pane"));
    await still(500);
    const vt = await visualTiles();
    const movedId = await vt[0].getAttribute("data-pane");
    const nextId = await vt[1].getAttribute("data-pane");
    const s0 = await vt[0].locator(".tile-title").boundingBox();
    const d1 = await vt[1].boundingBox();
    await win.mouse.move(s0.x + 30, s0.y + 10);
    await win.mouse.down();
    await win.mouse.move(s0.x + 60, s0.y + 20, { steps: 3 });
    await win.mouse.move(Math.min(d1.x + d1.width / 2, pane.x + pane.width - 80), d1.y + 100, { steps: 12 });
    check((await until(() => countOf(".tile.lifted"), (n) => n === 1, 5000)) === 1, "dragging in the strip lifts the window");
    await win.screenshot({ path: path.join(shots, "8b-strip-drag.png") });
    await win.mouse.up();
    const order = await until(async () => (await homeView())["grid.order"], (o) => o?.indexOf(movedId) === o?.indexOf(nextId) + 1);
    check(order.indexOf(movedId) === order.indexOf(nextId) + 1, "dropping on the next window swaps their places along the strip");
  }
  await menu("session.next");
  await still();
  await win.screenshot({ path: path.join(shots, "8-strip.png") });
  const widths = await until(async () => (await homeView())["strip.widths"], (w) => w && Object.keys(w).length >= 1);
  check(widths && Object.keys(widths).length >= 1, "strip widths are remembered");
  } finally {
    await menu("view.grid");
  }
});

// Terminal content must survive re-attaching exactly once (no replayed duplicates): a
// marker now, read again after the restart below. Sidebars dock this terminal too.
let markerPane = null;
await scenario("marker", async () => {
  markerPane = (await win.evaluate(() => window.cmd.call("pane.list", {})))[0].id;
  // Mouse reporting on, then off, then a marker computed by the shell (PowerShell on Windows).
  const markerCmd = process.platform !== "win32"
    ? "printf '\\033[?1000h\\033[?1000l'; echo MARKER-$((40+2))\r"
    : 'Write-Host -NoNewline "`e[?1000h`e[?1000l"; echo "MARKER-$(40+2)"\r';
  await win.evaluate(([id, data]) => window.cmd.call("pane.write", { paneId: id, data }), [markerPane, markerCmd]);
  const text = await until(() => paneText(markerPane, 500), (t) => t.includes("MARKER-42"));
  check(text.includes("MARKER-42"), "the terminal runs the re-attach marker");
});

// Sidebars (docs/21-sidebars.md): any window docks to a side and comes back to the board.
await scenario("sidebars", async () => {
  await select(markerPane);
  const onBoard = () => win.locator(`.windows-track > .tile[data-pane="${markerPane}"]`).count();
  await menu("window.dockRight");
  await win.waitForSelector(`.dock-right .tile[data-pane="${markerPane}"]`, { timeout: 10_000 });
  // The workspace's layout is saved debounced.
  const storedRight = await until(async () => (await homeView()).docks?.right?.id, (id) => id === markerPane);
  await until(onBoard, (n) => n === 0, 5000);
  check((await onBoard()) === 0 && storedRight === markerPane, "Move to Right Sidebar docks the window, out of the board");
  await win.screenshot({ path: path.join(shots, "9-sidebars.png") });
  await menu("view.rightSidebar");
  await gone(".dock-right");
  await until(() => countOf(".dock-right"), (n) => n === 0, 5000);
  check((await win.locator(".dock-right").count()) === 0 && (await onBoard()) === 0, "Show Right Sidebar hides the side; the window stays docked");
  await menu("view.rightSidebar");
  await win.waitForSelector(`.dock-right .tile[data-pane="${markerPane}"]`, { timeout: 10_000 });
  await still(200);
  // Canvas: one canvas under the sidebars; fitting keeps the windows between them.
  await menu("view.canvas");
  await win.waitForSelector(".main.mode-canvas", { timeout: 10_000 }).catch(() => {});
  await still(400);
  const stage = await win.locator(".main.windows").boundingBox();
  const vw = await win.evaluate(() => window.innerWidth);
  await menu("view.canvasFit");
  await still(500);
  const leftEdge = (await win.locator(".dock-left").boundingBox()).width;
  const rightEdge = (await win.locator(".dock-right").boundingBox()).x;
  const tiles = await win.locator(".windows-track > .tile").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [r.left, r.right]));
  check(stage.x === 0 && Math.abs(stage.width - vw) < 1 && tiles.every(([l, r]) => l >= leftEdge - 1 && r <= rightEdge + 1),
    `the canvas spans the window under the sidebars, and Fit keeps windows between them (${stage.width} / ${vw})`);
  await menu("view.grid");
  await win.waitForSelector(".main.mode-grid", { timeout: 10_000 });
  await until(selected, (s) => s === markerPane); // what Move to Board acts on
  await menu("window.undock");
  await win.waitForSelector(`.windows-track > .tile[data-pane="${markerPane}"]`, { timeout: 10_000 });
  await gone(".dock-right");
  await until(() => countOf(".dock-right"), (n) => n === 0, 5000);
  check((await win.locator(".dock-right").count()) === 0 && (await win.locator(".dock-left .navigator").count()) === 1, "Move to Board brings it back; the Navigator stays on the left");
});

// ── remembered UI state across an app restart (the core keeps running) ──
await scenario("restart", async () => {
// A browser and a file window to come back (the browser and files scenarios leave one each;
// run alone, this opens them).
if (!(await countOf(".tile.kind-browser"))) await win.evaluate((url) => window.cmd.call("window.open", { kind: "browser", input: { url } }), `http://localhost:${port}/`);
if (!(await countOf(".tile.kind-files"))) await win.evaluate((p) => window.cmd.call("window.open", { kind: "files", input: { path: p } }), path.join(home, "files-fixture"));
await until(async () => (await countOf(".tile.kind-browser")) + (await countOf(".tile.kind-files")), (n) => n >= 2);
await menu("view.grid");
await win.click(".sb-windows .ui-list-heading"); // collapse a Navigator section
await menu("view.zoomIn");
await menu("view.zoomIn");
{
  // Drag the left sidebar's inner edge; the width is the workspace's layout.
  const edge = await win.locator(".dock-left .dock-resize").boundingBox();
  await win.mouse.move(edge.x + edge.width / 2, 300);
  await win.mouse.down();
  await win.mouse.move(300, 300, { steps: 4 });
  await win.mouse.move(340, 300, { steps: 4 });
  await win.mouse.up();
}
// Debounced writes reach the core before we read them back.
await until(async () => (await homeView()).docks?.left?.width, (w) => w > 300);
await until(() => win.evaluate(() => window.cmd.call("ui.get", {})), (u) => u["terminal.zoom"] === 2 && u["sidebar.collapsed"]?.length > 0);
step("reading the UI state before the restart");
// The selection is saved debounced too: the one shown, once the core has it.
const shownSel = await selected();
const selectedBefore = await until(async () => (await homeView())["selection.pane"], (s) => s === shownSel);
step("closing the app");
await closeApp();
step("relaunching the app");

({ app, win } = await launch());
await win.waitForSelector(".statusbar .core-status");
await win.waitForSelector(".dock-left .navigator");
check((await until(() => countOf(".main.mode-grid"), (n) => n === 1)) === 1, "view mode restored (grid)");
{
  const stored = (await homeView()).docks?.left?.width;
  const leftWidth = async () => (await win.locator(".dock-left").boundingBox()).width;
  const w = await until(leftWidth, (w) => Math.abs(w - stored) <= 1);
  check(stored > 300 && Math.abs(w - stored) <= 1, `dragged sidebar width restored (${w} / ${stored})`);
  await win.locator(".dock-left .dock-resize").dblclick();
  const reset = await until(leftWidth, (w) => Math.abs(w - 280) <= 1);
  check(Math.abs(reset - 280) <= 1, `double-clicking the edge resets the width (${reset})`);
}
check((await until(() => countOf('.sb-windows .ui-list-heading[aria-expanded="false"]'), (n) => n === 1)) === 1, "collapsed sidebar section restored");
const ui = await win.evaluate(() => window.cmd.call("ui.get", {}));
check(ui["terminal.zoom"] === 2, "terminal zoom restored (+2)");
const restored = await until(async () => (await homeView())["selection.pane"], (s) => s === selectedBefore, 5000);
check(restored === selectedBefore && !!selectedBefore, `selected terminal restored (${selectedBefore} → ${restored})`);
{
  const text = await win.evaluate((id) => window.cmd.call("pane.read", { paneId: id, lines: 500 }).then((r) => r.text), markerPane);
  await select(markerPane);
  await menu("view.focus");
  // WebGL draws to a canvas: read the screen through the DOM renderer (settings apply live).
  const settingsPath = path.join(home, "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8").replace(/^\/\/.*$/gm, ""));
  fs.writeFileSync(settingsPath, JSON.stringify({ ...settings, "terminal.renderer": "dom" }));
  // The terminal redraws through the DOM renderer once the setting reaches it: a moment on a laptop, seconds on CI.
  const rows = () => win.evaluate((id) => document.querySelector(`.tile[data-pane="${id}"] .xterm-rows`)?.textContent ?? "", markerPane);
  const shown = await until(rows, (t) => /MARKER-42/.test(t), 15_000);
  const count = (shown.match(/MARKER-42/g) ?? []).length;
  check((text.match(/MARKER-42/g) ?? []).length === 1 && count === 1, `re-attached terminal shows its output exactly once (${count}×)`);
  check(!/\[<\d+;\d+;\d+[mM]/.test(shown), "no stray mouse escape codes after re-attaching");
  await menu("view.grid");
}
check((await win.locator(".tile.kind-browser").count()) === 1 && (await win.locator(".tile.kind-files").count()) === 1, "browser and file windows survive an app restart");
await win.screenshot({ path: path.join(shots, "7-restored.png") });
});

// The sidebar footer shows the core's health; its details restart the core, and the terminals live on.
await scenario("core-status", async () => {
  const button = win.locator(".core-status-button");
  await win.waitForFunction(() => document.querySelector(".core-status-button .ui-dot[data-state=\"success\"]") && document.querySelector(".core-status-usage .slot-v"), null, { timeout: 10_000 });
  check((await button.locator(".ui-dot[data-state=\"success\"]").count()) === 1, `core status is healthy (${await button.textContent()})`);
  await button.click();
  await win.waitForSelector(".core-details .ui-kv");
  const details = await until(() => win.locator(".core-details").textContent(), (d) => /Uptime/.test(d) && /PTY host\d/.test(d) && /pid \d+/.test(d), 5000);
  await win.screenshot({ path: path.join(shots, "7b-core-status.png") });
  check(/Uptime/.test(details) && /PTY host\d/.test(details) && /pid \d+/.test(details), `core details show uptime and both processes (${details})`);
  const pidBefore = await win.evaluate(() => window.cmd.call("core.hello", {}).then((h) => h.pid));
  const clients = await win.evaluate(() => window.cmd.call("core.info", {}).then((i) => i.connections));
  const before = await panes();
  await win.locator(".core-details button", { hasText: "Restart Core" }).click();
  // A call can land while the old core shuts down and reject; that's "not yet".
  // A call sent as the old core shuts down can reject, or never be answered (its socket
  // closed under it): both are "not yet", so each try gives up after a second and asks again.
  const ask = (m) => win.evaluate((m) => Promise.race([window.cmd.call(m, {}).catch(() => null), new Promise((r) => setTimeout(() => r(null), 1000))]), m).catch(() => null);
  const hello = await until(() => ask("core.hello"), (h) => h && h.pid !== pidBefore, 45_000);
  check(hello && hello.pid !== pidBefore, `Restart Core starts a new core (pid ${pidBefore} → ${hello?.pid})`);
  await win.waitForFunction(() => document.querySelector(".core-status-button .ui-dot[data-state=\"success\"]") && document.querySelector(".core-status-usage .slot-v"), null, { timeout: 30_000 });
  // Every client (this window, main's workspace.show listener) is back before going on.
  await until(() => ask("core.info"), (i) => i?.connections >= clients, 20_000);
  await until(panes, (n) => n === before);
  check((await panes()) === before, `terminals survive Restart Core (${before} → ${await panes()})`);
  await win.keyboard.press("Escape");
  await gone(".core-details");
  check((await until(() => countOf(".core-details"), (n) => n === 0, 5000)) === 0, "Escape closes the core details");
});

// Workspaces: `cmd .` (workspace.open with show) switches the window to a new, empty
// Workspace; new terminals start at its root; ⌃⌘[ goes back; closing ends its terminals.
await scenario("workspaces", async () => {
  const proj = path.join(home, "proj");
  fs.mkdirSync(proj, { recursive: true });
  const tilesInHome = await win.locator(".windows-track > .tile").count();
  const chip = () => win.locator(".workspace-trigger .workspace-name").textContent();
  const sp = await win.evaluate((p) => window.cmd.call("workspace.open", { path: p, show: true }).then((r) => r.workspace), proj);
  check((await until(chip, (c) => c === "proj")) === "proj", "workspace.open shows the new workspace in the switcher");
  check((await until(() => countOf(".windows-track > .tile"), (n) => n === 0)) === 0, "a new workspace starts empty");
  await menu("file.newTerminal");
  const inWorkspace = () => win.evaluate((id) => window.cmd.call("pane.list", {}).then((l) => l.filter((x) => x.workspaceId === id)), sp.id);
  const p = await until(inWorkspace, (p) => p.length === 1 && p[0].cwd === fs.realpathSync.native(proj));
  check(p.length === 1 && p[0].cwd === fs.realpathSync.native(proj), `new terminals start at the workspace's root (${p[0]?.cwd})`);
  check((await until(() => win.title(), (t) => t === "proj", 5000)) === "proj", "the app window is titled after its workspace");
  await win.screenshot({ path: path.join(shots, "8-workspace.png") });
  await menu("workspace.prev");
  await until(chip, (c) => c === "Home");
  const backTiles = await until(() => countOf(".windows-track > .tile"), (n) => n === tilesInHome);
  check((await chip()) === "Home" && backTiles === tilesInHome, `⌃⌘[ switches back to Home and its windows (${await chip()}, ${backTiles}/${tilesInHome})`);
  const again = await win.evaluate((p) => window.cmd.call("workspace.open", { path: p + "/" }), proj);
  check(again.created === false && again.workspace.id === sp.id, "opening the folder again returns the same workspace");
  await win.locator(".workspace-trigger").click();
  await win.locator(".workspace-menu").waitFor();
  const workspaceItems = () => countOf(".workspace-menu .workspace-item:not(.workspace-item-open)");
  const listed = await until(workspaceItems, (n) => n === 2, 5000);
  check(listed === 2, `the switcher's menu lists both workspaces (${listed})`);
  await win.screenshot({ path: path.join(shots, "8-workspace-menu.png") });
  await win.keyboard.press("Escape");
  // Change Icon…: the grid picker sets an SF Symbol on the workspace, shown in the switcher.
  await win.evaluate((id) => window.cmd.call("workspace.update", { id, icon: null }), "home");
  await menu("workspace.icon");
  await win.locator(".icon-picker").waitFor();
  await focused(".icon-picker input");
  await win.keyboard.type("leaf");
  await until(() => win.locator(".icon-picker input").inputValue(), (v) => v === "leaf"); // Enter picks from what it shows
  await win.screenshot({ path: path.join(shots, "8-workspace-icon.png") });
  await win.keyboard.press("Enter");
  const icon = await until(() => win.evaluate(() => window.cmd.call("workspace.list", {}).then((l) => l.find((x) => x.home).icon)), (i) => i === "leaf");
  check(icon === "leaf", `Change Workspace Icon… sets the workspace's icon (${icon})`);
  await gone(".icon-picker");
  // The Enter that picks is the picker's: it doesn't also click the switcher that gets the focus back.
  check((await win.locator(".workspace-trigger").getAttribute("aria-expanded")) === "false" && (await countOf(".workspace-menu")) === 0, "Enter in the icon picker doesn't open the switcher's menu");
  await win.evaluate((id) => window.cmd.call("workspace.close", { id }), sp.id);
  const still = (await until(inWorkspace, (l) => l.length === 0)).length;
  await gone(".icon-picker");
  await win.locator(".workspace-trigger").click();
  await win.locator(".workspace-menu").waitFor();
  const left = await until(workspaceItems, (n) => n === 1, 5000);
  await win.keyboard.press("Escape");
  check(still === 0 && left === 1, `closing a workspace ends its terminals and leaves the switcher (${still} terminals, ${left} Workspaces)`);
});

// The app window never leaves its page and opens no windows (it carries window.cmd): a web
// link that gets that far opens in a browser window instead (main/web-session.ts). Last:
// Playwright waits for good on the navigation that main prevented.
await scenario("app-window", async () => {
  const own = await win.evaluate(() => location.href);
  await win.evaluate((u) => void (location.href = u), "https://example.invalid/?away");
  const popup = await win.evaluate((u) => window.open(u) === null, "https://example.invalid/?popup");
  const forwarded = await until(() => win.evaluate(() => window.cmd.call("window.list", {})).then((l) => l.filter((w) => w.kind === "browser" && /\?(away|popup)/.test(JSON.stringify(w.state)))), (f) => f.length >= 2);
  const stayed = (await win.evaluate(() => location.href)) === own && (await win.evaluate(() => typeof window.cmd?.call)) === "function";
  check(stayed && popup && forwarded.length === 2, `an app window stays on its page and sends web links and pop-ups to browser windows (${stayed}, ${popup}, ${forwarded.length})`);
  for (const w of forwarded) await win.evaluate((id) => window.cmd.call("window.close", { id }), w.id);
});

server.close();
step("closing");
await Promise.race([closeApp(), new Promise((r) => setTimeout(r, 30_000))]);
await stopCore(home, { terminals: true });
report();
if (failures.length) console.log(`screenshots in ${shots}`);
else console.log("all checks passed; screenshots in", shots);
// Done: don't let a handle Playwright leaves open keep us alive until the watchdog fires.
process.exit(failures.length ? 1 : 0);
