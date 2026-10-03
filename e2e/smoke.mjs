// Launches the built app against an isolated core, drives it through the real
// menu bar, takes screenshots. usage: pnpm e2e
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import http from "node:http";
import { _electron as electron } from "playwright";
import { corePid, stopCore } from "../scripts/stop-core.mjs";

const root = path.resolve(import.meta.dirname, "..");
const home = path.join(root, ".cmd-dev", "e2e");
// The app starts a detached core that outlives it. Stop the last run's before
// wiping its state (or it's orphaned), and this run's on any exit, pass or fail.
await stopCore(home);
process.on("exit", () => {
  const pid = corePid(home);
  try {
    if (pid) process.kill(pid, "SIGTERM");
  } catch {}
});
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
const shots = path.join(root, ".cmd-dev", "shots");
fs.mkdirSync(shots, { recursive: true });

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
const launch = async () => {
  const app = await electron.launch({
    executablePath: require("electron"),
    args: [path.join(root, "apps/desktop")],
    env: { ...process.env, CMD_HOME: home, CMD_NO_SANDBOX: "1", CMD_TRANSCRIPTS_HOME: transcripts },
  });
  const win = await app.firstWindow();
  win.on("pageerror", (e) => console.log("pageerror:", e.message));
  return { app, win };
};
let { app, win } = await launch();

// Some calls have no timeout (app.close, evaluate waiting on the core) and can
// hang for good, on Windows in particular. A watchdog fails the run instead,
// naming the last step and saving a screenshot.
let lastStep = "launch";
let lastAt = Date.now();
const step = (s) => ((lastStep = s), (lastAt = Date.now()));
const HANG_MS = 90_000;
setInterval(async () => {
  if (Date.now() - lastAt < HANG_MS) return;
  console.log(`HUNG: nothing for ${HANG_MS / 1000}s after: ${lastStep}`);
  const within = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r("(no answer in 5s)"), 5000))]);
  const wins = await within(
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), visible: w.isVisible() }))),
  ).catch((e) => e.message);
  console.log("electron windows:", JSON.stringify(wins));
  await within(win.screenshot({ path: path.join(shots, "hung.png") })).catch(() => {});
  process.exit(1);
}, 5000).unref();

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
// Layout and selection live in the shown Space's view (docs/11-spaces.md); these checks run in Home.
const homeView = () => win.evaluate(() => window.cmd.call("space.list", {}).then((l) => l.find((s) => s.home).view));
// Windows in visual order (reading order); the DOM keeps a stable creation order.
const visualTiles = async () => {
  const ids = await win.locator(".windows-track > .tile:not(.hidden-tile)").evaluateAll((els) =>
    els
      .map((e) => ({ id: e.dataset.pane, r: e.getBoundingClientRect() }))
      .sort((a, b) => (Math.abs(a.r.top - b.r.top) > 20 ? a.r.top - b.r.top : a.r.left - b.r.left))
      .map((x) => x.id),
  );
  return ids.map((id) => win.locator(`.tile[data-pane="${id}"]`));
};

await win.waitForSelector(".sidebar-status");
await win.screenshot({ path: path.join(shots, "1-empty.png") });
{
  // The sidebar footer and the main status bar share one bottom row: same top, same height,
  // and tall enough for their tallest icon button.
  const left = await win.locator(".sidebar-status").boundingBox();
  const right = await win.locator(".statusbar").boundingBox();
  const btn = await win.locator(".statusbar .icon-btn").first().boundingBox();
  check(Math.abs(left.y - right.y) < 0.5 && Math.abs(left.height - right.height) < 0.5 && right.height >= btn.height,
    `bottom bars line up and fit their icons (${left.height} / ${right.height}, button ${btn.height})`);
  check(right.height === 30, `bottom bars keep their 30 px height (${right.height})`);
  // Icons sit on whole pixels, exactly centred in their buttons.
  const offsets = await win.locator(".statusbar .icon-btn").evaluateAll((btns) =>
    btns.map((b) => {
      const s = b.querySelector(".sf").getBoundingClientRect();
      const r = b.getBoundingClientRect();
      return [s.left - r.left - (r.right - s.right), s.top - r.top - (r.bottom - s.bottom), s.width % 1, s.height % 1];
    }),
  );
  check(offsets.every(([dx, dy, fw, fh]) => Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01 && fw === 0 && fh === 0),
    `status bar icons are exactly centred on whole pixels (${offsets.length} buttons)`);
}

if (mac) {
  check((await accel("file.newTerminal")) === "Cmd+N", "⌘N is New Terminal");
  check((await accel("file.close")) === "Cmd+W", "⌘W is Close Terminal");
  check((await accel("session.next")) === "Alt+Cmd+Right", "⌥⌘→ is Next Session");
} else {
  // The Windows Terminal-style keymap (shared/commands.ts otherPlatformKey) reached the native menu.
  check((await accel("file.newTerminal")) === "Ctrl+Shift+N", "Ctrl+Shift+N is New Terminal");
  check((await accel("view.palette")) === "Ctrl+Shift+K", "Ctrl+Shift+K is the command palette");
  check((await accel("session.next")) === "Ctrl+Alt+Right", "Ctrl+Alt+→ is Next Session");
}

await menu("file.newTerminal");
await win.waitForSelector(".xterm");
await win.waitForTimeout(1500); // let the login shell finish starting
await win.keyboard.type("echo hello from cmd");
await win.keyboard.press("Enter");
await menu("file.newTerminal");
await win.waitForTimeout(1500);
await win.keyboard.type("ls -la");
await win.keyboard.press("Enter");
await win.waitForTimeout(500);
check((await panes()) === 2, "two terminals open");
await win.screenshot({ path: path.join(shots, "2-focus.png") });

const before = await win.locator(".row.sel").getAttribute("class");
const rowsBefore = await win.locator(".row:not(.history)").allTextContents();
await menu("session.next");
await win.waitForTimeout(200);
const selIndexAfter = await win.locator(".row:not(.history)").evaluateAll((els) => els.findIndex((e) => e.classList.contains("sel")));
check(rowsBefore.length === 2 && selIndexAfter >= 0, `session.next moves selection (now row ${selIndexAfter + 1})`);
void before;

await menu("view.grid");
await win.waitForTimeout(400);
check((await win.locator(".tile").count()) === 2, "grid shows both terminals");
if (process.platform !== "win32") {
  await win.waitForSelector(".statusbar-usage .slot-v", { timeout: 8000 });
  const usageText = await win.locator(".statusbar-usage .slot-v").first().textContent();
  check(/\d+ (KB|MB|GB)/.test(usageText ?? ""), `status bar shows memory of the process tree (${usageText})`);
} else console.log("skip - status bar memory (needs a Windows procinfo helper)");
// Notifications: a bell in the other terminal marks it until you look at it.
{
  const other = await win.evaluate(() => document.querySelector(".tile:not(.sel)")?.getAttribute("data-pane"));
  // A bell from the shell: PowerShell on Windows, a POSIX shell elsewhere.
  const bell = process.platform === "win32" ? 'Write-Host -NoNewline "`a"\r' : "printf '\\a'\r";
  await win.evaluate(([id, data]) => window.cmd.call("pane.write", { paneId: id, data }), [other, bell]);
  const status = win.locator(`.tile[data-pane="${other}"] .slot-status .slot-v:not(.out)`);
  await status.filter({ hasText: "Bell" }).waitFor({ timeout: 5000 });
  check(true, "a terminal bell marks its window (Bell)");
  await win.evaluate((id) => window.cmd.call("notify.send", { paneId: id, title: "Build", body: "done" }), other);
  await status.filter({ hasText: "done" }).waitFor({ timeout: 3000 });
  check(true, "cmd notify marks the terminal it came from");
  await win.evaluate((id) => window.__cmdSelect(id), other);
  await win.waitForFunction((id) => !document.querySelector(`.tile[data-pane="${id}"] .slot-status .slot-v:not(.out)`), other, { timeout: 3000 });
  check(true, "looking at the terminal clears its mark");
  await win.evaluate((id) => window.cmd.call("pane.clearAttention", { paneId: id }), other);
}
const panesOrder = async () => (await homeView())["grid.order"];
const order0 = await panesOrder();
{ const t = await visualTiles(); await t[1].locator(".tile-title").dragTo(t[0]); }
let order1 = await panesOrder();
for (let i = 0; i < 30 && (!Array.isArray(order1) || JSON.stringify(order1) === JSON.stringify(order0)); i++) {
  await win.waitForTimeout(100);
  order1 = await panesOrder();
}
check(Array.isArray(order1) && order1.length === 2, `dragging a tile onto another reorders the grid (${JSON.stringify(order1?.map((x) => x.slice(0, 4)))})`);
// Let the windows glide into their new places first: mid-animation, positions (and so the drag target) are stale.
await win.waitForFunction(() => !document.querySelector(".tile.settling, .tile.lifted"), null, { timeout: 3000 }).catch(() => {});
await win.waitForTimeout(400);
{ const t = await visualTiles(); await t[1].locator(".tile-title").dragTo(t[0]); }
// The order is saved debounced: wait for it to change rather than a fixed time (slow CI runners).
let order2 = await panesOrder();
for (let i = 0; i < 30 && JSON.stringify(order2) === JSON.stringify(order1); i++) {
  await win.waitForTimeout(100);
  order2 = await panesOrder();
}
check(order2[0] === order1[1] && order2[1] === order1[0], "dragging back swaps the slots again");
// A real drag through three tiles: the dragged tile follows the pointer, the others make room.
await menu("file.newTerminal");
await win.waitForTimeout(800);
await menu("view.grid");
await win.waitForTimeout(400);
const order3 = await panesOrder().then((o) => o ?? []);
const vt = await visualTiles();
const src = await vt[0].locator(".tile-title").boundingBox();
const dst = await vt[2].boundingBox();
await win.mouse.move(src.x + 40, src.y + 10);
await win.mouse.down();
await win.mouse.move(src.x + 60, src.y + 30, { steps: 4 });
await win.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2, { steps: 12 });
await win.waitForTimeout(250);
check((await win.locator(".tile.lifted").count()) === 1, "the dragged tile is lifted and follows the pointer");
await win.screenshot({ path: path.join(shots, "3b-grid-drag.png") });
await win.mouse.up();
await win.waitForTimeout(500);
const order4 = await panesOrder();
const ids3 = await win.evaluate(() => window.cmd.call("pane.list", {}).then((p) => p.sort((a, b) => a.createdAt - b.createdAt).map((x) => x.id)));
const before3 = [...order3, ...ids3.filter((id) => !order3.includes(id))];
const expected = [before3[1], before3[2], before3[0]];
check(JSON.stringify(order4) === JSON.stringify(expected), "dropping the first tile on the third inserts it there and shifts the others");
await menu("file.close"); // back to two terminals for the checks below
await win.waitForTimeout(500);
await win.screenshot({ path: path.join(shots, "3-grid.png") });
await menu("view.focus");

await menu("view.palette");
await win.waitForSelector(".palette");
await win.keyboard.type("next");
await win.waitForTimeout(150);
await win.screenshot({ path: path.join(shots, "4-palette.png") });
await menu("file.close"); // ⌘W closes the palette first
check((await win.locator(".palette").count()) === 0, "⌘W closes the palette before any terminal");
{ const n = await panes(); check(n === 2, `…and leaves terminals alone (${n})`); }

// Session search: ?query in the palette, Enter resumes the session in a new terminal.
{
  await menu("view.palette");
  await win.waitForSelector(".palette");
  await win.keyboard.type("?wiregaurd"); // typo on purpose
  await win.waitForSelector(".palette.searching");
  await win.waitForSelector(".palette-list li.rich", { timeout: 15000 });
  const label = await win.locator(".palette-list li.rich .palette-label").first().textContent();
  const snippet = await win.locator(".palette-snippet mark").first().textContent();
  check(label === "VPN auto reconnect" && /wireguard/i.test(snippet ?? ""), `session search finds past sessions, typo-tolerant (${label}: ${snippet})`);
  await win.screenshot({ path: path.join(shots, "4b-search.png") });
  const before = await panes();
  await win.keyboard.press("Enter");
  await win.waitForTimeout(1500);
  const agents = await win.evaluate(() => window.cmd.call("agent.list", {}));
  check((await panes()) === before + 1 && agents.some((a) => a.native.claudeSessionId === "e2e-session-1"), "Enter resumes the session in a new terminal");
  // the resumed "agent" is just echo; close its terminal directly (no confirmation sheet)
  const resumed = agents.find((a) => a.native.claudeSessionId === "e2e-session-1");
  await win.evaluate((id) => window.cmd.call("pane.kill", { paneId: id }), resumed.paneId);
  await win.waitForTimeout(600);
}

// Sidebar search (⇧⌘F): filters open windows and searches past sessions; Esc leaves.
{
  await menu("view.search");
  check(await win.evaluate(() => document.activeElement?.closest(".sb-search") !== null), "⇧⌘F focuses the sidebar search");
  await win.keyboard.type("wiregaurd");
  await win.waitForSelector(".sidebar-scroll .row.history", { timeout: 15000 });
  const label = await win.locator(".sidebar-scroll .row.history .row-name").first().textContent();
  check(label === "VPN auto reconnect", `sidebar search finds past sessions (${label})`);
  await win.screenshot({ path: path.join(shots, "4c-sidebar-search.png") });
  await win.keyboard.press("Escape");
  check((await win.locator(".sb-search input").inputValue()) === "", "Esc clears the sidebar search");
  await win.keyboard.press("Escape");
  await win.waitForSelector(".sb-recent .row.history", { timeout: 5000 }).catch(() => {});
  check((await win.locator(".sb-recent .row.history").count()) > 0, "Recent lists past sessions from the index");
}

// Browser and file windows
{
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<title>E2E Page</title><body style='font:20px sans-serif;padding:20px'>Hello from a cmd browser window</body>");
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  await menu("view.palette");
  await win.waitForSelector(".palette");
  await win.keyboard.type(`localhost:${port}`);
  await win.waitForTimeout(200);
  const offer = await win.locator(".palette-list li").first().textContent();
  check(offer.includes(`Open localhost:${port}`), `typing a URL offers to open it (${offer.trim()})`);
  await win.keyboard.press("Enter");
  let browserWin = null;
  for (let i = 0; i < 50 && !browserWin; i++) {
    await win.waitForTimeout(200);
    const all = await win.evaluate(() => window.cmd.call("window.list", {}));
    browserWin = all.find((w) => w.kind === "browser" && w.title === "E2E Page");
  }
  check(!!browserWin && browserWin.state.url.startsWith(`http://localhost:${port}`), "browser window loads the page and reports its title");

  fs.mkdirSync(path.join(home, "files-fixture", "sub-folder"), { recursive: true });
  fs.writeFileSync(path.join(home, "files-fixture", "notes.txt"), "# hi");
  fs.writeFileSync(path.join(home, "files-fixture", "sub-folder", "inner.txt"), "inside");
  const fw = await win.evaluate((p) => window.cmd.call("window.open", { kind: "files", input: { path: p } }), path.join(home, "files-fixture"));
  await win.waitForTimeout(200);
  await win.evaluate((id) => window.__cmdSelect(id), fw.id);
  await win.waitForSelector(".tile.kind-files .file-row");
  const rowsNow = () => win.locator(".tile.kind-files .file-row .file-name").allTextContents();
  const selName = () => win.locator(".tile.kind-files .file-row.sel .file-name").textContent();
  const filesPath = () => win.evaluate(() => window.cmd.call("window.list", {})).then((l) => l.find((w) => w.kind === "files").state.path);
  check(JSON.stringify(await rowsNow()) === JSON.stringify(["sub-folder", "notes.txt"]), "file tree lists the folder, folders first");

  await win.locator(".tile.kind-files .file-row", { hasText: "sub-folder" }).dblclick();
  await win.waitForTimeout(400);
  check(JSON.stringify(await rowsNow()) === JSON.stringify(["sub-folder", "inner.txt", "notes.txt"]), "double-clicking a folder expands it in place");

  // Keyboard: come from a terminal, then select the file window — arrows drive the tree.
  await win.evaluate(() => window.cmd.call("pane.list", {}).then((p) => window.__cmdSelect(p[0].id)));
  await win.waitForTimeout(300);
  await win.evaluate((id) => window.__cmdSelect(id), fw.id);
  await win.waitForTimeout(400);
  await win.keyboard.press("Home");
  await win.keyboard.press("ArrowLeft"); // collapse
  await win.waitForTimeout(200);
  check(JSON.stringify(await rowsNow()) === JSON.stringify(["sub-folder", "notes.txt"]), "← collapses the selected folder (focus moved here from a terminal)");
  await win.keyboard.press("ArrowRight"); // expand
  await win.waitForTimeout(300);
  await win.keyboard.press("ArrowRight"); // into first child
  await win.waitForTimeout(150);
  check((await selName()) === "inner.txt", "→ expands, then steps into the folder");
  await win.keyboard.press("ArrowLeft");
  await win.waitForTimeout(150);
  check((await selName()) === "sub-folder", "← on a child jumps to its folder");
  await win.keyboard.type("n");
  await win.waitForTimeout(150);
  check((await selName()) === "notes.txt", "typing selects by name");
  await win.keyboard.press("Home");
  if (mac) {
    await win.keyboard.press("Meta+ArrowDown");
    await win.waitForTimeout(500);
    check((await filesPath()).endsWith("sub-folder"), "⌘↓ makes the folder the root");
    await win.keyboard.press("Meta+ArrowUp");
    await win.waitForTimeout(500);
    const fp = await filesPath(); const sn = await selName();
    check(fp.endsWith("files-fixture") && sn === "sub-folder", `⌘↑ goes back up and re-selects where you were (${path.basename(fp)}, ${sn})`);
  } else macOnly("⌘↓/⌘↑ in the file tree");

  // Files open in the window that suits them: notes.txt → text window; edit and ⌘S.
  await win.locator(".tile.kind-files .file-row", { hasText: "notes.txt" }).dblclick();
  await win.waitForSelector(".tile.kind-text .cm-content");
  await win.waitForTimeout(500);
  check((await win.locator(".tile.kind-text .cm-content").textContent()) === "# hi", "double-clicking a text file opens it in a text window (CodeMirror)");
  await win.locator(".tile.kind-text .cm-content").click();
  await win.keyboard.press("End");
  await win.keyboard.type(" there");
  await menu("file.save");
  await win.waitForTimeout(400);
  check(fs.readFileSync(path.join(home, "files-fixture", "notes.txt"), "utf8") === "# hi there", "⌘S saves the text window");

  // Live: outside edits show up in the editor; new files show up in the tree.
  fs.writeFileSync(path.join(home, "files-fixture", "notes.txt"), "# changed by an agent\n");
  let live = "";
  for (let i = 0; i < 30 && !live.includes("changed by an agent"); i++) {
    await win.waitForTimeout(100);
    live = (await win.locator(".tile.kind-text .cm-content").textContent()) ?? "";
  }
  check(live.includes("changed by an agent"), "the text window reloads live when the file changes on disk");
  fs.writeFileSync(path.join(home, "files-fixture", "zz-new-file.txt"), "new");
  let rows = [];
  for (let i = 0; i < 30 && !rows.includes("zz-new-file.txt"); i++) {
    await win.waitForTimeout(100);
    rows = await win.locator(".tile.kind-files .file-row .file-name").allTextContents();
  }
  check(rows.includes("zz-new-file.txt"), "the file tree shows new files live");

  // Markdown window: rendered, highlighted code, local image, live, ⌘E ⇄ editor.
  const mdDir = path.join(home, "md-fixture");
  fs.mkdirSync(mdDir, { recursive: true });
  // 1×1 PNG
  fs.writeFileSync(path.join(mdDir, "dot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  fs.writeFileSync(path.join(mdDir, "README.md"), "# Hello cmd\n\nSome **bold** text and a [link](https://example.com).\n\n- [x] done\n- [ ] todo\n\n![dot](dot.png)\n\n```ts\nconst answer: number = 42;\n```\n");
  const md = await win.evaluate((p) => window.cmd.call("window.openTarget", { target: p }), path.join(mdDir, "README.md"));
  check(md.kind === "markdown", "README.md opens in a Markdown window");
  await win.evaluate((id) => window.__cmdSelect(id), md.id);
  await win.waitForSelector(".tile.kind-markdown .markdown h1");
  // Code highlighting waits for the language parser to load on demand.
  await win.waitForSelector(".tile.kind-markdown pre code span[class]", { timeout: 5000 }).catch(() => {});
  const h1 = await win.locator(".tile.kind-markdown .markdown h1").textContent();
  const tokens = await win.locator(".tile.kind-markdown pre code span[class]").count();
  const imgOk = await win.locator(".tile.kind-markdown .markdown img").evaluate((img) => img.complete && img.naturalWidth === 1);
  check(h1 === "Hello cmd" && tokens > 0, `Markdown renders with highlighted code (${tokens} tokens)`);
  check(imgOk, "relative images load through cmd-file:");
  fs.appendFileSync(path.join(mdDir, "README.md"), "\n## Added live\n");
  await win.waitForSelector(".tile.kind-markdown .markdown h2", { timeout: 3000 });
  check(true, "Markdown re-renders live when the file changes");
  await menu("view.toggleEdit");
  await win.waitForSelector(`.tile.kind-text[data-pane="${md.id}"] .cm-content`, { timeout: 3000 });
  check(true, "⌘E switches the same window to the editor");
  await menu("view.toggleEdit");
  await win.waitForSelector(`.tile.kind-markdown[data-pane="${md.id}"] .markdown h1`, { timeout: 3000 });
  check(true, "⌘E switches back to the preview");

  await menu("view.grid");
  await win.waitForTimeout(800);
  await win.screenshot({ path: path.join(shots, "10-window-kinds.png") });
  check((await win.locator(".tile.kind-browser").count()) === 1 && (await win.locator(".tile.kind-files").count()) === 1 && (await win.locator(".tile.kind-text").count()) === 1 && (await win.locator(".tile.kind-markdown").count()) === 1, "browser, file, text and Markdown windows take part in the grid");
  server.close();
}

// Embedded pages: browser pages and Magic widgets run in their own process, so
// they report presses and sideways scrolls (renderer/src/embed.ts; browser pages
// through preload/guest.ts, widgets by postMessage). Magic windows are staged
// with a widget and its data, so no model runs.
{
  const call = (m, p = {}) => win.evaluate(([m, p]) => window.cmd.call(m, p), [m, p]);
  const magic = [];
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
  await win.waitForTimeout(1200);
  const widgetText = await win.frameLocator(`.tile[data-pane="${magic[0]}"] iframe.magic-frame`).locator("#v").textContent({ timeout: 5000 });
  check(widgetText === "Alpha data", "a Magic widget renders its data in its sandboxed frame");

  // A theme change reaches widgets live: CSS variables, and colours drawn from JavaScript (cmd.onTheme).
  const themed = await call("window.open", { kind: "magic", input: {} });
  await call("window.update", {
    id: themed.id,
    title: "Themed",
    state: { prompt: "themed", phase: "ready", kind: "widget", html: '<canvas id="c"></canvas><script>cmd.onTheme(() => (c.dataset.bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()))</script>', source: null, refresh: 0, size: "s", lastData: null },
  });
  await win.waitForTimeout(1000);
  const themedFrame = win.frameLocator(`.tile[data-pane="${themed.id}"] iframe.magic-frame`);
  const readTheme = () => themedFrame.locator("body").evaluate(() => ({ css: getComputedStyle(document.body).backgroundColor, js: document.getElementById("c").dataset.bg }));
  const beforeTheme = await readTheme();
  const appearance = (await call("settings.get")).settings["theme.appearance"];
  await call("settings.set", { key: "theme.appearance", value: appearance === "light" ? "dark" : "light" });
  await win.waitForTimeout(1000);
  const afterTheme = await readTheme();
  await call("settings.set", { key: "theme.appearance", value: appearance });
  check(!!beforeTheme.js && afterTheme.css !== beforeTheme.css && afterTheme.js !== beforeTheme.js, `a theme change reaches a widget live, CSS and cmd.onTheme (${beforeTheme.js} → ${afterTheme.js})`);

  // Media: a widget's media origins are blocked by the frame's CSP until the person allows them.
  const radio = await call("window.open", { kind: "magic", input: {} });
  const radioHtml = '<div id="r">–</div><script>document.addEventListener("securitypolicyviolation",()=>r.textContent="blocked");const a=new Audio();a.onerror=()=>r.textContent==="–"&&(r.textContent="loaded");a.src="https://radio.invalid/live.aacp"</script>';
  await call("window.update", { id: radio.id, title: "Radio", state: { prompt: "radio", phase: "ready", kind: "widget", html: radioHtml, media: ["https://radio.invalid"], source: null, refresh: 0, size: "s", lastData: null } });
  await win.waitForTimeout(1500);
  const radioTile = win.locator(`.tile[data-pane="${radio.id}"]`);
  const radioText = () => win.frameLocator(`.tile[data-pane="${radio.id}"] iframe.magic-frame`).locator("#r").textContent({ timeout: 5000 });
  const asked = await radioTile.locator(".magic-media").isVisible();
  const before = await radioText();
  await radioTile.locator(".magic-media .btn.primary").click();
  await win.waitForTimeout(2500);
  const after = await radioText();
  const stored = (await call("window.list")).find((x) => x.id === radio.id).state.mediaAllowed;
  check(asked && before === "blocked" && after === "loaded" && !(await radioTile.locator(".magic-media").count()) && stored?.[0] === "https://radio.invalid", `a widget's media origins are asked for and then allowed by the frame's CSP (${asked}, ${before} → ${after})`);
  await call("window.close", { id: themed.id });
  await win.waitForTimeout(600);

  const selected = () => win.evaluate(() => document.querySelector(".tile.sel")?.dataset.pane);
  const clickIn = async (loc) => {
    const b = await loc.boundingBox();
    await win.mouse.click(b.x + b.width / 2, b.y + b.height * 0.6);
    await win.waitForTimeout(400);
  };
  const frame = (id) => win.locator(`.tile[data-pane="${id}"] iframe.magic-frame`);
  const page = win.locator(".tile.kind-browser webview");
  const pageId = await win.locator(".tile.kind-browser").getAttribute("data-pane");
  const term = win.locator(".tile.kind-terminal .xterm").first();
  const termId = await win.locator(".tile.kind-terminal").first().getAttribute("data-pane");
  const order = [];
  for (const [loc, id] of [[term, termId], [frame(magic[0]), magic[0]], [frame(magic[1]), magic[1]], [page, pageId], [frame(magic[0]), magic[0]]]) {
    await clickIn(loc);
    order.push((await selected()) === id);
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
  await titleInput.waitFor({ timeout: 3000 });
  const menuItems = await app.evaluate(() => globalThis.__lastMenu);
  check(menuItems[0] === "Change…" && menuItems.includes("Copy Request") && (await selected()) === magic[0], `right-click in a Magic widget opens its window's menu, Change first (${menuItems.slice(0, 3).join(", ")}…)`);
  check(await titleInput.evaluate((el) => el === document.activeElement), "Change from that menu edits the title bar, focused");
  await win.keyboard.press("Escape");
  check(!(await titleInput.count()), "Esc puts the title back");
  await app.evaluate(({ Menu }) => (Menu.prototype.popup = globalThis.__menuPopup));

  await clickIn(frame(magic[0]));
  await menu("view.magicChange");
  const input = win.locator(`.tile[data-pane="${magic[0]}"] .tile-title-input`);
  await input.waitFor({ timeout: 3000 });
  check(await input.evaluate((el) => el === document.activeElement), "⌘L (a menu command) opens Change in the selected Magic window's title bar, even with the widget focused");
  await win.keyboard.press("Escape");

  await menu("view.strip");
  await win.waitForTimeout(800);
  const offset = () => win.evaluate(() => document.querySelector(".windows-scroller").scrollLeft);
  const scrolls = async (loc, id) => {
    await win.evaluate((id) => window.__cmdSelect(id), id); // the strip reveals it
    await win.waitForTimeout(700);
    const b = await loc.boundingBox();
    await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    for (const dx of [60, -60]) {
      const before = await offset();
      for (let i = 0; i < 3; i++) await win.mouse.wheel(dx, 0), await win.waitForTimeout(16);
      const moved = (await offset()) !== before;
      await win.waitForTimeout(500); // let it snap back to a window
      if (moved) return true;
    }
    return false;
  };
  check(await scrolls(frame(magic[0]), magic[0]), "sideways scrolling over a Magic widget scrolls the strip");
  check(await scrolls(page, pageId), "sideways scrolling over a browser page scrolls the strip");
  await menu("view.grid");
  for (const id of magic) await call("window.close", { id });
}

// Settings: its own native window (⌘,), generated from the schema; changes apply live.
{
  const opened = app.waitForEvent("window");
  await menu("app.settings");
  const sw = await opened;
  sw.on("pageerror", (e) => console.log("settings pageerror:", e.message));
  await sw.waitForSelector(".sw-nav-item");
  const pages = await sw.locator(".sw-nav-label").allTextContents();
  check(["Fonts", "Terminal", "Shell", "Opening Files", "Interface", "Canvas", "Search", "Agents", "Keyboard Shortcuts"].every((p) => pages.includes(p)), `settings has a page per group (${pages.join(", ")})`);
  await sw.screenshot({ path: path.join(shots, "5-settings-terminal.png") });
  const page = (name) => sw.locator(".sw-nav-item", { hasText: name }).click();
  const row = (title) => sw.locator(".sw-row", { has: sw.locator(".sw-row-title", { hasText: title }) });
  const saved = () => JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8").replace(/^\/\/.*$/gm, ""));
  const waitFor = async (fn, what) => {
    for (let i = 0; i < 40 && !fn(); i++) await sw.waitForTimeout(50);
    check(fn(), what);
  };

  await page("About");
  await sw.waitForSelector(".sw-row:has-text('Status') .sw-value");
  const status = await row("Status").locator(".sw-value").textContent();
  check(/^pid \d+$/.test(status ?? ""), `About shows the running core (${status})`);

  await page("Shell");
  const tags = await sw.locator(".sw-tag").allTextContents();
  check(tags.filter((t) => t === "new terminals only").length === 3, `settings that don't apply live are tagged (${tags.join(", ")})`);

  await page("Interface");
  await row("Show resource usage").locator(".sw-switch").click();
  await waitFor(() => saved()["ui.showResources"] === false, "a switch saves to settings.json");
  await row("Window corner radius").locator(".nf button[aria-label=Increase]").click();
  await waitFor(() => saved()["ui.windowRadius"] === 9, "+ steps a number field and saves");
  const radius = () => win.evaluate(() => document.querySelector(".app")?.style.getPropertyValue("--window-radius"));
  for (let i = 0; i < 40 && (await radius()) !== "9px"; i++) await win.waitForTimeout(50);
  check((await radius()) === "9px", "the app window applies it live");
  await row("Window corner radius").locator(".sw-reset").click();
  await sw.screenshot({ path: path.join(shots, "5-settings-interface.png") });
  await row("Show resource usage").locator(".sw-reset").click();
  await waitFor(() => !("ui.showResources" in saved()), "restore default removes the override");

  await page("Fonts");
  const fontSize = row("Code font size").locator("input");
  await fontSize.fill("16");
  await fontSize.press("Enter");
  await waitFor(() => saved()["font.codeSize"] === 16, "the code font size saves");
  const codePx = () => win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-code-size").trim());
  for (let i = 0; i < 40 && (await codePx()) !== "16px"; i++) await win.waitForTimeout(50);
  check((await codePx()) === "16px", "the app's file and Markdown windows get the code font size live (--font-code-size)");
  const fonts = await win.evaluate(() =>
    [".file-row", ".markdown", ".markdown code"].map((sel) => {
      const el = document.querySelector(sel);
      return el ? [sel, getComputedStyle(el).fontFamily, getComputedStyle(el).fontSize] : null;
    }),
  );
  check(fonts[0] && /Monaspace/.test(fonts[0][1]) && fonts[0][2] === `${16 * 0.9}px`, `file browser rows use the code font (${fonts[0]})`);
  check(fonts[1] && /system-ui|-apple-system/.test(fonts[1][1]), `Markdown prose uses the text font (${fonts[1]})`);
  check(!fonts[2] || /Monaspace/.test(fonts[2][1]), `Markdown code uses the code font (${fonts[2]})`);
  await row("Code font size").locator(".sw-reset").click();

  await page("Terminal");
  await row("Renderer").locator(".sw-seg button", { hasText: "WebGL" }).click();
  await waitFor(() => saved()["terminal.renderer"] === "webgl", "a segmented control saves its option");
  await page("Fonts");
  const size = row("Code font size").locator("input");
  await size.fill("");
  await size.press("Enter");
  check((await size.inputValue()) === "14" && !("font.codeSize" in saved()), "an emptied number field reverts instead of saving 0");
  await size.fill("99");
  await size.press("Enter");
  await waitFor(() => saved()["font.codeSize"] === 32, "a number field clamps to the setting's range");
  await row("Code font size").locator(".sw-reset").click();
  await page("Terminal");
  await row("Line height").locator(".nf input").focus();
  await row("Line height").locator(".nf input").press("ArrowUp");
  await waitFor(() => saved()["terminal.lineHeight"] === 1.2, "↑ steps a number field by its step");
  await sw.locator(".sw-page-foot .sw-button").click();
  await waitFor(() => !("terminal.lineHeight" in saved()) && !("terminal.renderer" in saved()), "Restore Defaults resets the page");

  await sw.locator(".sw-search input").fill("zoom");
  const found = await sw.locator(".sw-row-title").allTextContents();
  check(["Minimum zoom", "Maximum zoom"].every((t) => found.some((f) => f.startsWith(t))), `search finds settings across pages (${found.join(", ")})`);
  await sw.locator(".sw-search input").fill("");

  await page("Keyboard Shortcuts");
  check((await sw.locator(".sw-row.shortcut kbd").count()) > 10, "keyboard shortcuts are listed");
  await sw.screenshot({ path: path.join(shots, "5-settings-shortcuts.png") });
  await sw.close();
}

// Live remap via keybindings.json
fs.writeFileSync(path.join(home, "keybindings.json"), '// test\n{ "session.next": ["Ctrl+Tab"], "edit.clear": null }');
let remapped = null;
for (let i = 0; i < 30 && remapped !== "Ctrl+Tab"; i++) {
  await win.waitForTimeout(100);
  remapped = await accel("session.next");
}
check(remapped === "Ctrl+Tab", "keybindings.json remaps live");
check((await accel("edit.clear")) === null, "null unbinds a shortcut");

// Closing the focused terminal returns to the previously used one (MRU), not a sidebar neighbour.
{
  await menu("file.newTerminal");
  await win.waitForTimeout(800);
  const list = await win.evaluate(() => window.cmd.call("pane.list", {}).then((p) => p.sort((a, b) => a.createdAt - b.createdAt).map((x) => x.id)));
  const [first, , newest] = [list[0], list[1], list[list.length - 1]];
  const selectPane = (id) => win.evaluate((id) => window.__cmdSelect?.(id), id);
  await selectPane(first);
  await win.waitForTimeout(200);
  await selectPane(newest);
  await win.waitForTimeout(200);
  await menu("file.close");
  await win.waitForTimeout(700);
  const sel = (await homeView())["selection.pane"];
  check(sel === first, "closing a terminal focuses the previously used one");
}

// ⌘W on an idle shell closes it without asking
await menu("file.close");
await win.waitForTimeout(600);
check((await panes()) === 1, "⌘W closes an idle terminal");

// ── PaperWM-style strip ──
{
  for (let i = 0; i < 3; i++) {
    await menu("file.newTerminal");
    await win.waitForTimeout(500);
  }
  await menu("view.strip");
  await win.waitForSelector(".main.mode-strip");
  await win.waitForTimeout(500);
  const pane = await win.locator(".main.mode-strip").boundingBox();
  const tiles = win.locator(".windows-track > .tile");
  const n = await tiles.count();
  const heights = await tiles.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  check(n >= 4 && heights.every((h) => Math.abs(h - heights[0]) < 1 && h > pane.height - 40), `strip: ${n} windows, all full height`);
  // The strip is a native scroller: its content sits at -scrollLeft.
  const trackX = () => win.locator(".windows-scroller").evaluate((e) => -e.scrollLeft);

  // keyboard: walk to the last window; it must end up fully visible
  for (let i = 0; i < n; i++) await menu("session.next");
  await win.waitForTimeout(500);
  const sel = await win.locator(".windows-track > .tile.sel").boundingBox();
  check(sel && sel.x >= pane.x - 1 && sel.x + sel.width <= pane.x + pane.width + 1 && (await trackX()) < 0,
    "⌥⌘→ scrolls the strip to reveal the selected window");

  // trackpad: a horizontal swipe left stays where it stopped (no snapping)
  await win.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  const before = -(await trackX());
  await win.mouse.wheel(-37, 0);
  await win.waitForTimeout(700);
  check(Math.abs(-(await trackX()) - (before - 37)) < 1, "horizontal scroll moves freely and stays put");

  // scrollbar: dragging the thumb scrolls the strip
  const thumb = await win.locator(".strip-thumb").boundingBox();
  const o0 = -(await trackX());
  await win.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await win.mouse.down();
  await win.mouse.move(thumb.x + thumb.width / 2 - 40, thumb.y + thumb.height / 2, { steps: 4 });
  await win.mouse.up();
  check(-(await trackX()) < o0 - 1, "dragging the scrollbar thumb scrolls the strip");

  // ⌘↩ into focus and back: the strip returns to exactly where it was
  await win.waitForTimeout(300);
  const scrolled = await trackX();
  const selX = (await win.locator(".windows-track > .tile.sel").boundingBox()).x;
  await menu("view.toggleFocus");
  await win.waitForSelector(".main.mode-focus");
  await win.waitForTimeout(500);
  await menu("view.toggleFocus");
  await win.waitForSelector(".main.mode-strip");
  await win.waitForTimeout(600);
  const selX2 = (await win.locator(".windows-track > .tile.sel").boundingBox()).x;
  check(Math.abs((await trackX()) - scrolled) < 1 && Math.abs(selX2 - selX) < 1,
    `toggling focus returns the strip to its scroll position (${Math.round(scrolled)} → ${Math.round(await trackX())})`);

  // resize by the right edge, capped at the pane width
  await win.evaluate((id) => window.__cmdSelect(id), await (await visualTiles())[0].getAttribute("data-pane"));
  await win.waitForTimeout(500);
  const first = (await visualTiles())[0];
  await win.evaluate((id) => window.__cmdSelect(id), await first.getAttribute("data-pane"));
  await win.waitForTimeout(500);
  const fb = await first.boundingBox();
  const handle = await first.locator(".strip-resize").boundingBox();
  await win.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await win.mouse.down();
  await win.mouse.move(pane.x + pane.width - 2, handle.y + handle.height / 2, { steps: 8 });
  await win.mouse.up();
  await win.waitForTimeout(400);
  const fb2 = await first.boundingBox();
  check(fb2.width > fb.width && fb2.width <= pane.width - 16 + 1, `resizing is capped at the pane width (${Math.round(fb.width)} → ${Math.round(fb2.width)})`);
  await menu("view.cycleWidth");
  await win.waitForTimeout(400);
  const fb3 = await first.boundingBox();
  check(fb3.width < fb2.width, `⌃⌘R cycles width presets (${Math.round(fb2.width)} → ${Math.round(fb3.width)})`);
  // drag a window along the strip: the others make room (insert-style)
  {
    await win.evaluate((id) => window.__cmdSelect(id), await (await visualTiles())[0].getAttribute("data-pane"));
    await win.waitForTimeout(500);
    const vt = await visualTiles();
    const movedId = await vt[0].getAttribute("data-pane");
    const nextId = await vt[1].getAttribute("data-pane");
    const s0 = await vt[0].locator(".tile-title").boundingBox();
    const d1 = await vt[1].boundingBox();
    await win.mouse.move(s0.x + 30, s0.y + 10);
    await win.mouse.down();
    await win.mouse.move(s0.x + 60, s0.y + 20, { steps: 3 });
    await win.mouse.move(Math.min(d1.x + d1.width / 2, pane.x + pane.width - 80), d1.y + 100, { steps: 12 });
    await win.waitForTimeout(300);
    check((await win.locator(".tile.lifted").count()) === 1, "dragging in the strip lifts the window");
    await win.screenshot({ path: path.join(shots, "8b-strip-drag.png") });
    await win.mouse.up();
    await win.waitForTimeout(500);
    const order = (await homeView())["grid.order"];
    check(order.indexOf(movedId) === order.indexOf(nextId) + 1, "dropping on the next window swaps their places along the strip");
  }
  await menu("session.next");
  await win.waitForTimeout(500);
  await win.screenshot({ path: path.join(shots, "8-strip.png") });
  const widths = (await homeView())["strip.widths"];
  check(widths && Object.keys(widths).length >= 1, "strip widths are remembered");
  await menu("view.grid");
}

// Terminal content must survive re-attaching exactly once (no replayed duplicates).
const markerPane = (await win.evaluate(() => window.cmd.call("pane.list", {})))[0].id;
// Mouse reporting on, then off, then a marker computed by the shell (PowerShell on Windows).
const markerCmd = process.platform !== "win32"
  ? "printf '\\033[?1000h\\033[?1000l'; echo MARKER-$((40+2))\r"
  : 'Write-Host -NoNewline "`e[?1000h`e[?1000l"; echo "MARKER-$(40+2)"\r';
step("typing the re-attach marker");
await win.evaluate(([id, data]) => window.cmd.call("pane.write", { paneId: id, data }), [markerPane, markerCmd]);
await win.waitForTimeout(800);

// ── remembered UI state across an app restart (the core keeps running) ──
await menu("view.grid");
await win.click(".sb-windows .sb-heading"); // collapse a sidebar section
await menu("view.zoomIn");
await menu("view.zoomIn");
{
  // Drag the sidebar's edge; the width is UI state.
  const edge = await win.locator(".sidebar-resize").boundingBox();
  await win.mouse.move(edge.x + edge.width / 2, 300);
  await win.mouse.down();
  await win.mouse.move(300, 300, { steps: 4 });
  await win.mouse.move(340, 300, { steps: 4 });
  await win.mouse.up();
}
await win.waitForTimeout(400); // debounced writes reach the core before we read them back
step("reading the UI state before the restart");
const selectedBefore = (await homeView())["selection.pane"];
step("closing the app");
await closeApp();
step("relaunching the app");

({ app, win } = await launch());
await win.waitForSelector(".sidebar-status");
await win.waitForTimeout(800);
check((await win.locator(".main.mode-grid").count()) === 1, "view mode restored (grid)");
{
  const w = (await win.locator(".sidebar").boundingBox()).width;
  check(Math.abs(w - 340) <= 1, `dragged sidebar width restored (${w})`);
  await win.locator(".sidebar-resize").dblclick();
  await win.waitForTimeout(100);
  const reset = (await win.locator(".sidebar").boundingBox()).width;
  check(Math.abs(reset - 280) <= 1, `double-clicking the edge resets the width (${reset})`);
}
check((await win.locator('.sb-windows .sb-heading[aria-expanded="false"]').count()) === 1, "collapsed sidebar section restored");
const ui = await win.evaluate(() => window.cmd.call("ui.get", {}));
check(ui["terminal.zoom"] === 2, "terminal zoom restored (+2)");
const restored = (await homeView())["selection.pane"];
check(restored === selectedBefore && !!selectedBefore, `selected terminal restored (${selectedBefore} → ${restored})`);
{
  const text = await win.evaluate((id) => window.cmd.call("pane.read", { paneId: id, lines: 500 }).then((r) => r.text), markerPane);
  await win.evaluate((id) => window.__cmdSelect(id), markerPane);
  await menu("view.focus");
  await win.waitForTimeout(600);
  const shown = await win.locator(`.tile[data-pane="${markerPane}"] .xterm-rows`).textContent();
  const count = (shown.match(/MARKER-42/g) ?? []).length;
  check((text.match(/MARKER-42/g) ?? []).length === 1 && count === 1, `re-attached terminal shows its output exactly once (${count}×)`);
  check(!/\[<\d+;\d+;\d+[mM]/.test(shown), "no stray mouse escape codes after re-attaching");
  await menu("view.grid");
}
check((await win.locator(".tile.kind-browser").count()) === 1 && (await win.locator(".tile.kind-files").count()) === 1, "browser and file windows survive an app restart");
await win.screenshot({ path: path.join(shots, "7-restored.png") });

// Spaces: `cmd .` (space.open with show) switches the window to a new, empty
// Space; new terminals start at its root; ⌃⌘[ goes back; closing ends its terminals.
{
  const proj = path.join(home, "proj");
  fs.mkdirSync(proj, { recursive: true });
  const tilesInHome = await win.locator(".windows-track > .tile").count();
  const chip = () => win.locator(".space-chip.on .space-name").textContent();
  const sp = await win.evaluate((p) => window.cmd.call("space.open", { path: p, show: true }).then((r) => r.space), proj);
  await win.waitForTimeout(700);
  check((await chip()) === "proj", "space.open shows the new Space in the switcher");
  check((await win.locator(".windows-track > .tile").count()) === 0, "a new Space starts empty");
  await menu("file.newTerminal");
  await win.waitForTimeout(800);
  const inSpace = () => win.evaluate((id) => window.cmd.call("pane.list", {}).then((l) => l.filter((x) => x.spaceId === id)), sp.id);
  const p = await inSpace();
  check(p.length === 1 && p[0].cwd === fs.realpathSync.native(proj), `new terminals start at the Space's root (${p[0]?.cwd})`);
  check((await win.title()) === "proj", "the app window is titled after its Space");
  await win.screenshot({ path: path.join(shots, "8-space.png") });
  await menu("space.prev");
  await win.waitForTimeout(600);
  const backTiles = await win.locator(".windows-track > .tile").count();
  check((await chip()) === "Home" && backTiles === tilesInHome, `⌃⌘[ switches back to Home and its windows (${await chip()}, ${backTiles}/${tilesInHome})`);
  const again = await win.evaluate((p) => window.cmd.call("space.open", { path: p + "/" }), proj);
  check(again.created === false && again.space.id === sp.id, "opening the folder again returns the same Space");
  await win.evaluate((id) => window.cmd.call("space.close", { id }), sp.id);
  await win.waitForTimeout(500);
  check((await inSpace()).length === 0 && (await win.locator(".space-chip").count()) === 1, "closing a Space ends its terminals and leaves the switcher");
}

await closeApp();
await stopCore(home);
console.log("all checks passed; screenshots in", shots);
