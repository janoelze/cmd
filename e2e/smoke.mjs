// Launches the built app against an isolated core, drives it through the real
// menu bar, takes screenshots. usage: pnpm e2e
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const home = path.join(root, ".cmd-dev", "e2e");
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
await win.screenshot({ path: path.join(shots, "7-restored.png") });

await app.close();
// The core outlives the UI by design; stop the isolated test core.
process.kill(Number(fs.readFileSync(path.join(home, "core.pid"), "utf8")), "SIGTERM");
console.log("all checks passed; screenshots in", shots);
