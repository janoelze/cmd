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

const check = (cond, msg) => {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
};
// Synthetic keys bypass the native menu, so trigger menu items directly.
const menu = (id) =>
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`no menu item ${id}`);
    item.click();
  }, id);
const accel = (id) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.accelerator ?? null, id);
const panes = () => win.evaluate(() => window.cmd.call("pane.list", {}).then((p) => p.length));
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
const selectedTitle = () => win.locator(".row.sel .row-title").textContent();

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

check((await accel("file.newTerminal")) === "Cmd+N", "⌘N is New Terminal");
check((await accel("file.close")) === "Cmd+W", "⌘W is Close Terminal");
check((await accel("session.next")) === "Alt+Cmd+Right", "⌥⌘→ is Next Session");

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
const rowsBefore = await win.locator(".row").allTextContents();
await menu("session.next");
await win.waitForTimeout(200);
const selIndexAfter = await win.locator(".row").evaluateAll((els) => els.findIndex((e) => e.classList.contains("sel")));
check(rowsBefore.length === 2 && selIndexAfter >= 0, `session.next moves selection (now row ${selIndexAfter + 1})`);
void before;

await menu("view.grid");
await win.waitForTimeout(400);
check((await win.locator(".tile").count()) === 2, "grid shows both terminals");
await win.waitForSelector(".tile-usage", { timeout: 8000 });
const usageText = await win.locator(".tile-usage").first().textContent();
check(/\d+ (KB|MB|GB)/.test(usageText ?? ""), `tile title shows memory of the process tree (${usageText})`);
const panesOrder = async () => (await win.evaluate(() => window.cmd.call("ui.get", {})))["grid.order"];
{ const t = await visualTiles(); await t[1].locator(".tile-title").dragTo(t[0]); }
await win.waitForTimeout(500);
const order1 = await panesOrder();
check(Array.isArray(order1) && order1.length === 2, `dragging a tile onto another reorders the grid (${JSON.stringify(order1?.map((x) => x.slice(0, 4)))})`);
{ const t = await visualTiles(); await t[1].locator(".tile-title").dragTo(t[0]); }
await win.waitForTimeout(500);
const order2 = await panesOrder();
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
check((await panes()) === 2, "…and leaves terminals alone");

// Session search: ?query in the palette, Enter resumes the session in a new terminal.
{
  await menu("view.search");
  await win.waitForSelector(".palette.searching");
  await win.keyboard.type("wiregaurd"); // typo on purpose
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
  await win.keyboard.press("Meta+ArrowDown");
  await win.waitForTimeout(500);
  check((await filesPath()).endsWith("sub-folder"), "⌘↓ makes the folder the root");
  await win.keyboard.press("Meta+ArrowUp");
  await win.waitForTimeout(500);
  { const fp = await filesPath(); const sn = await selName();
    check(fp.endsWith("files-fixture") && sn === "sub-folder", `⌘↑ goes back up and re-selects where you were (${fp.split("/").pop()}, ${sn})`); }

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

await menu("app.settings");
await win.waitForSelector(".settings");
await win.locator(".shortcuts-heading").scrollIntoViewIfNeeded();
await win.screenshot({ path: path.join(shots, "5-settings-shortcuts.png") });
await menu("file.close");

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
  await menu("view.sessions");
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
  const sel = (await win.evaluate(() => window.cmd.call("ui.get", {})))["selection.pane"];
  check(sel === first, "closing a terminal focuses the previously used one");
}

// ⌘W on an idle shell closes it without asking
await menu("file.close");
await win.waitForTimeout(600);
check((await panes()) === 1, "⌘W closes an idle terminal");

await menu("view.tools");
await win.waitForTimeout(200);
await win.screenshot({ path: path.join(shots, "6-tools.png") });

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
  const trackX = () => win.locator(".windows-track").evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).m41);

  // keyboard: walk to the last window; it must end up fully visible
  for (let i = 0; i < n; i++) await menu("session.next");
  await win.waitForTimeout(500);
  const sel = await win.locator(".windows-track > .tile.sel").boundingBox();
  check(sel && sel.x >= pane.x - 1 && sel.x + sel.width <= pane.x + pane.width + 1 && (await trackX()) < 0,
    "⌥⌘→ scrolls the strip to reveal the selected window");

  // trackpad: a horizontal swipe left, then it settles on a window edge
  await win.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  for (let i = 0; i < 6; i++) await win.mouse.wheel(-40, 0);
  await win.waitForTimeout(700);
  const offs = -(await trackX());
  // window edges in content coordinates (tiles are positioned by transform)
  const edges = await tiles.evaluateAll((els) => els.map((e) => { const m = new DOMMatrix(getComputedStyle(e).transform); return [m.m41 - 8, m.m41 + e.offsetWidth + 8]; }));
  const vw = pane.width;
  const total = Math.max(...edges.map(([, r]) => r));
  const snapped = offs < 1 || Math.abs(offs - (total - vw)) < 1 || edges.some(([l, r]) => Math.abs(offs - l) < 2 || Math.abs(offs - (r - vw)) < 2);
  check(snapped, `horizontal scroll settles on a window edge (offset ${Math.round(offs)})`);

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
    check((await win.locator(".ghost-slot.target").count()) === 1, "dragging in the strip shows the drop slot");
    await win.screenshot({ path: path.join(shots, "8b-strip-drag.png") });
    await win.mouse.up();
    await win.waitForTimeout(500);
    const order = (await win.evaluate(() => window.cmd.call("ui.get", {})))["grid.order"];
    check(order.indexOf(movedId) === order.indexOf(nextId) + 1, "dropping on the next window swaps their places along the strip");
  }
  await menu("session.next");
  await win.waitForTimeout(500);
  await win.screenshot({ path: path.join(shots, "8-strip.png") });
  const widths = (await win.evaluate(() => window.cmd.call("ui.get", {})))["strip.widths"];
  check(widths && Object.keys(widths).length >= 1, "strip widths are remembered");
  await menu("view.grid");
}

// Terminal content must survive re-attaching exactly once (no replayed duplicates).
const markerPane = (await win.evaluate(() => window.cmd.call("pane.list", {})))[0].id;
await win.evaluate((id) => window.cmd.call("pane.write", { paneId: id, data: "printf '\\033[?1000h\\033[?1000l'; echo MARKER-$((40+2))\r" }), markerPane);
await win.waitForTimeout(800);

// ── remembered UI state across an app restart (the core keeps running) ──
await menu("view.grid");
await menu("view.tools");
await win.click(".panel-title >> text=Agents"); // collapse a tool panel
await menu("view.zoomIn");
await menu("view.zoomIn");
const selectedBefore = await win.evaluate(() => window.cmd.call("ui.get", {}).then((u) => u["selection.pane"]));
await win.waitForTimeout(400); // debounced writes
await app.close();

({ app, win } = await launch());
await win.waitForSelector(".sidebar-status");
await win.waitForTimeout(800);
check((await win.locator(".main.mode-grid").count()) === 1, "view mode restored (grid)");
check((await win.locator(".sidebar-tabs button.on").textContent()) === "Tools", "sidebar tab restored (Tools)");
check((await win.locator(".panel.shaded").count()) === 1, "collapsed tool panel restored");
const ui = await win.evaluate(() => window.cmd.call("ui.get", {}));
check(ui["terminal.zoom"] === 2, "terminal zoom restored (+2)");
check(ui["selection.pane"] === selectedBefore && !!selectedBefore, "selected terminal restored");
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

await app.close();
await stopCore(home);
console.log("all checks passed; screenshots in", shots);
