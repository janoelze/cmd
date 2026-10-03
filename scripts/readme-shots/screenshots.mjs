// README screenshots: launches the built app against a throwaway core, stages
// scenes with fake agents (fake-claude.mjs), shoots each in Pastel Light and
// Pastel Dark, and frames them like macOS windows. usage: pnpm shots
// Output: docs/screenshots/<scene>-<light|dark>.png (raw captures in .cmd-dev/readme/raw).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { _electron as electron, chromium } from "playwright";
import { corePid, stopCore } from "../stop-core.mjs";
import { SCENARIOS } from "./fake-claude.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const home = path.join(root, ".cmd-dev", "readme");
const raw = path.join(home, "raw");
const out = path.join(root, "docs", "screenshots");
const SIZE = { width: 1600, height: 1000 };
const THEMES = { light: "pastel-light", dark: "pastel-dark" };
const only = process.argv.slice(2); // scene names; empty = all

await stopCore(home);
process.on("exit", () => {
  const pid = corePid(home);
  try {
    if (pid) process.kill(pid, "SIGTERM");
  } catch {}
});
fs.rmSync(home, { recursive: true, force: true });
for (const d of [raw, out]) fs.mkdirSync(d, { recursive: true });

// ── fixtures ──────────────────────────────────────────────

// `claude` on PATH is the fake: argv[1] ends in /claude, so cmd classifies it as Claude.
const bin = path.join(home, "bin");
fs.mkdirSync(bin);
// Same for `htop` (fake-htop.mjs): a repeatable frame instead of this machine's processes.
for (const [name, file] of [["claude", "fake-claude.mjs"], ["htop", "fake-htop.mjs"]]) {
  fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nimport(${JSON.stringify(path.join(import.meta.dirname, file))});\n`, { mode: 0o755 });
}

// A plain zsh with a short prompt and no history, instead of the user's own config.
const zdotdir = path.join(home, "zsh");
fs.mkdirSync(zdotdir);
fs.writeFileSync(
  path.join(zdotdir, ".zshrc"),
  [`path=(${bin} $path)`, "unset HISTFILE", "PROMPT='%F{blue}%~%f %F{magenta}❯%f '", "RPROMPT=''"].join("\n") + "\n",
);

// Past sessions for Recent and session search.
const transcripts = path.join(home, "transcripts-home");
const project = path.join(transcripts, ".claude", "projects", root.replaceAll("/", "-"));
fs.mkdirSync(project, { recursive: true });
const PAST = [
  ["Pastel themes", 2, "add a pastel dark and a pastel light theme, same hues, both readable", "Added pastel-dark.ts and pastel-light.ts. The light theme deepens each hue until it reaches 4.5:1 contrast on the off-white base."],
  ["Theme contrast check", 5, "check every theme's ANSI colours for contrast against its background", "Wrote a contrast test over all registered themes. Solarized Light's bright yellow failed (2.1:1); I nudged it to 3.2:1 and left a note in the theme file."],
  ["Canvas minimap", 9, "add a minimap to the canvas view", "The minimap draws every window as a rectangle in its theme colour; clicking it moves the camera there."],
  ["Live theme switching", 14, "switching theme in settings should repaint terminals without a reload", "Terminals now get their theme from the settings.updated event and call term.options.theme, so the switch is live."],
  ["Sidebar attention groups", 20, "group the sidebar by what needs me: waiting agents first", "Rows are now sectioned into Needs you, Agents and Windows; a subagent waiting for input pulls its parent up."],
  ["Transcript search index", 31, "index ~/.claude transcripts in sqlite for full text search", "Search runs in a worker with FTS5 and trigram fallback, so typos like 'wiregaurd' still match."],
];
PAST.forEach(([title, hoursAgo, user, reply], i) => {
  const id = `readme-past-${i}`;
  const ts = new Date(Date.now() - hoursAgo * 3600e3);
  const file = path.join(project, `${id}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: "user", sessionId: id, cwd: root, timestamp: ts.toISOString(), message: { role: "user", content: user } },
      { type: "assistant", sessionId: id, timestamp: ts.toISOString(), message: { role: "assistant", content: [{ type: "text", text: reply }] } },
      { type: "ai-title", aiTitle: title },
    ].map((o) => JSON.stringify(o)).join("\n") + "\n",
  );
  fs.utimesSync(file, ts, ts);
});

fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ "theme.appearance": "light", "theme.light": THEMES.light, "theme.dark": THEMES.dark, "font.codeSize": 12 }, null, 2));

// The browser window's page: a made-up telemetry dashboard.
const page = fs.readFileSync(path.join(import.meta.dirname, "dashboard.html"));
const server = http.createServer((_req, res) => (res.setHeader("content-type", "text/html"), res.end(page)));
// Any free port: a fixed one like 5173 may already be a dev server (and then wins for "localhost").
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

// ── app ───────────────────────────────────────────────────

fs.mkdirSync(path.join(home, "tmp"));
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const app = await electron.launch({
  executablePath: require("electron"),
  args: ["--force-device-scale-factor=2", path.join(root, "apps/desktop")],
  // Playwright emulates prefers-color-scheme: light on every page it attaches to, browser
  // windows' pages included; null leaves it to the app (nativeTheme follows the theme).
  colorScheme: null,
  env: {
    ...process.env,
    CMD_HOME: home,
    CMD_NO_SANDBOX: "1",
    CMD_TRANSCRIPTS_HOME: transcripts,
    ZDOTDIR: zdotdir,
    // Isolates the hook status dir ($TMPDIR/ghostty-agents) from real sessions.
    TMPDIR: path.join(home, "tmp") + "/",
  },
});
const win = await app.firstWindow();
win.on("pageerror", (e) => console.log("pageerror:", e.message));
await app.evaluate(({ BrowserWindow }, { width, height }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.setContentSize(width, height);
  w.center();
}, SIZE);
await win.waitForSelector(".sidebar-status");

const call = (method, params = {}) => win.evaluate(([m, p]) => window.cmd.call(m, p), [method, params]);
const menu = (id) =>
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`no menu item ${id}`);
    item.click();
  }, id);
const until = async (fn, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await win.waitForTimeout(150)) {
    const v = await fn();
    if (v) return v;
  }
  await win.screenshot({ path: path.join(home, "timeout.png") }).catch(() => {});
  throw new Error(`timed out waiting for ${what} (see ${path.relative(root, home)}/timeout.png)`);
};

// Agents first (in grid order), then htop, an editor on the file the first agent is changing, and the browser.
const agents = {};
for (const name of ["working", "ask", "done"]) {
  const pane = await call("pane.create", { cwd: root, command: `claude --demo=${name}` });
  agents[name] = pane.id;
}
const shell = await call("pane.create", { cwd: root, command: "htop" });
const editor = await call("window.open", { kind: "text", input: { path: path.join(root, "apps/desktop/src/renderer/src/canvas.ts") } });
const browserWin = await call("window.open", { kind: "browser", input: { url: pageUrl } });

await until(async () => {
  const list = await call("agent.list");
  return Object.values(agents).every((id) => list.some((a) => a.paneId === id));
}, "the fake agents to be detected");
for (const [name, paneId] of Object.entries(agents)) {
  const s = SCENARIOS[name];
  for (const [event, payload] of s.hooks(root)) {
    await call("hook.ingest", { paneId, agent: "claude", event, payload: { hook_event_name: event, session_id: s.session, cwd: root, ...payload } });
  }
}

await menu("view.grid");
await win.evaluate((id) => window.__cmdSelect(id), editor.id);
await win.waitForSelector(".tile.kind-text .cm-content");
await win.evaluate((id) => window.__cmdSelect(id), agents.working);
await until(() => call("window.list").then((l) => l.some((w) => w.kind === "browser" && w.title === "core telemetry")), "the browser page");
await until(() => win.locator(".sb-recent .row.history").count(), "Recent sessions");
await win.waitForTimeout(1500); // terminals redraw after the grid resize


// ── scenes ────────────────────────────────────────────────

const setAppearance = async (mode) => {
  await call("settings.set", { key: "theme.appearance", value: mode });
  await win.waitForTimeout(600);
};
const shoot = async (scene) => {
  for (const mode of ["light", "dark"]) {
    await setAppearance(mode);
    const file = path.join(raw, `${scene}-${mode}.png`);
    // Electron's own capture: Playwright's page.screenshot composites browser windows
    // (<webview> guests) from a stale frame, at an earlier size.
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    fs.writeFileSync(file, Buffer.from(png, "base64"));
    console.log("shot", scene, mode);
  }
};
const SCENES = {
  hero: async () => {
    await menu("view.grid");
    await win.waitForTimeout(800);
  },
  canvas: async () => {
    // A hand-made arrangement (world px, on the 24 px dot grid) instead of the first-visit grid.
    // The renderer reads canvas.rects at startup, hence the reload.
    const rect = (x, y, w, h) => ({ x: x * 24, y: y * 24, w: w * 24, h: h * 24 });
    await call("ui.set", {
      key: "canvas.rects",
      value: {
        [shell.id]: rect(-19, 8, 17, 22),
        [agents.working]: rect(0, 0, 32, 27),
        [editor.id]: rect(6, 29, 26, 21),
        [agents.ask]: rect(34, -3, 26, 18),
        [agents.done]: rect(34, 17, 26, 17),
        [browserWin.id]: rect(34, 36, 19, 15),
      },
    });
    await win.reload();
    await win.waitForSelector(".sidebar-status");
    await win.evaluate((id) => window.__cmdSelect(id), agents.working);
    await menu("view.canvas");
    await win.waitForTimeout(800);
    await menu("view.canvasFit");
    await win.waitForTimeout(800);
  },
  // Magic windows: real widgets the agent made (magic-widgets.json: their HTML
  // and the data their source returned), in a Space of their own so the other
  // scenes stay as they are, next to an empty one showing the prompt. No model
  // runs here, and nothing refreshes: windows made after the core started are
  // only scheduled when a run finishes.
  magic: async () => {
    const widgets = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "magic-widgets.json"), "utf8"));
    const dir = path.join(home, "dashboard");
    fs.mkdirSync(dir, { recursive: true });
    const { space } = await call("space.open", { path: dir, show: true });
    await win.waitForTimeout(800);
    let first = null;
    for (const w of widgets) {
      const m = await call("window.open", { kind: "magic", input: {}, spaceId: space.id });
      first ??= m.id;
      await call("window.update", {
        id: m.id,
        title: w.title,
        state: { prompt: w.prompt, phase: "ready", kind: "widget", html: w.html, source: w.source, refresh: w.refresh, size: w.size, lastData: w.data === null ? null : { data: w.data, at: Date.now() }, history: [w.prompt] },
      });
    }
    await call("window.open", { kind: "magic", input: {}, spaceId: space.id });
    await menu("view.grid");
    await win.evaluate((id) => window.__cmdSelect(id), first);
    await win.waitForTimeout(2000); // frames load and render their widgets
  },
  search: async () => {
    await menu("view.grid");
    await win.waitForTimeout(500);
    await menu("view.palette");
    await win.waitForSelector(".palette");
    await win.keyboard.type("?theme");
    await win.waitForSelector(".palette-list li.rich", { timeout: 15000 });
    await win.waitForTimeout(400);
  },
};
const scenes = Object.keys(SCENES).filter((s) => !only.length || only.includes(s));
for (const scene of scenes) {
  await SCENES[scene]();
  await shoot(scene);
}

await app.close();
await stopCore(home);
server.close();

// ── framing: rounded corners, traffic lights, a soft shadow, transparent background ──

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: SIZE.width + 200, height: SIZE.height + 200 } });
const tab = await ctx.newPage();
for (const scene of scenes) {
  for (const mode of ["light", "dark"]) {
    const img = fs.readFileSync(path.join(raw, `${scene}-${mode}.png`)).toString("base64");
    const edge = mode === "dark" ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.18)";
    await tab.setContent(`<style>
      body { margin: 0; background: transparent; }
      .pad { display: inline-block; padding: 40px 64px 80px; }
      .win { position: relative; width: ${SIZE.width}px; height: ${SIZE.height}px; border-radius: 12px; overflow: hidden;
             box-shadow: 0 0 0 .5px ${edge}, 0 24px 60px rgba(0,0,0,.28), 0 6px 16px rgba(0,0,0,.12); }
      .win > img { display: block; width: 100%; height: 100%; }
      .lights { position: absolute; left: 14px; top: 12px; display: flex; gap: 8px; }
      .lights i { width: 12px; height: 12px; border-radius: 50%; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.15); }
    </style><div class="pad"><div class="win"><img src="data:image/png;base64,${img}">
      <div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
    </div></div>`);
    await tab.locator(".pad").screenshot({ path: path.join(out, `${scene}-${mode}.png`), omitBackground: true });
  }
}
await browser.close();
console.log("screenshots in", path.relative(root, out));
