// Drag and drop against the built app (docs/22-drag-and-drop.md): files and
// links dragged in from outside (CDP's Input.dispatchDragEvent delivers trusted
// drags with real file paths, like a drag from Finder) onto terminals, file
// browsers and other windows; and drags out of rows and title icons (the main
// process's startDrag is stubbed: a native drag session can't be scripted).
// usage: pnpm e2e:drops
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright";
import { corePid, stopCore } from "../scripts/stop-core.mjs";
import { fitScreen, screenEnv } from "./screen.mjs";

const root = path.resolve(import.meta.dirname, "..");
const home = path.join(root, ".cmd-dev", "e2e-drops");
await stopCore(home, { terminals: true });
process.on("exit", () => {
  for (const pid of [corePid(home), corePid(home, "ptyhost")]) {
    try {
      if (pid) process.kill(pid, "SIGTERM");
    } catch {}
  }
});
fs.rmSync(home, { recursive: true, force: true });
const fixture = path.join(home, "fixture");
fs.mkdirSync(path.join(fixture, "box", "inner"), { recursive: true });
fs.mkdirSync(path.join(fixture, "outside"), { recursive: true });
for (const f of ["dropped file.txt", "moved.txt", "copied.txt", "opened.md", "page.txt"]) fs.writeFileSync(path.join(fixture, "outside", f), "hello");
fs.mkdirSync(path.join(home, "ui")); // an existing install: no onboarding sheet over the windows
fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ "agents.claude.command": "echo claude" }));
const shots = path.join(root, ".cmd-dev", "shots");
fs.mkdirSync(shots, { recursive: true });

const require = createRequire(path.join(root, "apps/desktop/package.json"));
const app = await electron.launch({
  executablePath: require("electron"),
  args: [path.join(root, "apps/desktop")],
  env: { ...process.env, CMD_HOME: home, CMD_USAGE_URL: "off", CMD_DEV_KEYS: "off", CMD_NO_SANDBOX: "1", CMD_BACKGROUND: process.env.E2E_VISIBLE ? "" : "1", ...screenEnv() },
});
const win = await app.firstWindow();
await fitScreen(app, win);
win.on("pageerror", (e) => console.log("pageerror:", e.message));
setTimeout(() => (console.log("HUNG"), process.exit(1)), 120_000).unref();

let failed = false;
const check = (cond, msg) => {
  console.log(`${cond ? "ok" : "FAIL"} - ${msg}`);
  if (!cond) failed = true;
};
const cdp = await win.context().newCDPSession(win);
const startUrl = win.url();

/** A whole drag from outside the app onto an element (its centre, or `at` as fractions of its box): enter, over, drop. */
async function dropOn(selector, { files = [], items = [], modifiers = 0, at = [0.5, 0.5] } = {}) {
  const box = await win.locator(selector).first().boundingBox();
  if (!box) throw new Error(`nothing at ${selector}`);
  const x = box.x + box.width * at[0];
  const y = box.y + box.height * at[1];
  const data = { items, files, dragOperationsMask: 1 | 2 | 16 }; // copy | link | move
  for (const type of ["dragEnter", "dragOver", "drop"]) await cdp.send("Input.dispatchDragEvent", { type, x, y, data, modifiers });
  await win.waitForTimeout(500);
}
const ALT = 1;
const META = 4;
// A long path wraps in a narrow terminal (CI's smaller screen): compare without line breaks and spaces.
const squash = (s) => s.replace(/\s+/g, "");
const screen = (paneId) => win.evaluate((id) => window.cmd.call("pane.read", { paneId: id, lines: 30 }).then((r) => r.text), paneId);
const openWin = (kind, input) => win.evaluate(([kind, input]) => window.cmd.call("window.open", { kind, input }), [kind, input]);
const windows = () => win.evaluate(() => window.cmd.call("window.list", {}));
const select = async (id) => (await win.evaluate((id) => window.__cmdSelect(id), id), await win.waitForTimeout(400));
const out = (f) => path.join(fixture, "outside", f);
const inBox = (f) => path.join(fixture, "box", f);
const waitFor = async (cond) => {
  for (let i = 0; i < 30 && !(await cond()); i++) await win.waitForTimeout(100);
  return cond();
};

// Get past onboarding (whichever steps a new install is shown).
await win.waitForTimeout(1000);
for (const label of ["Get Started", "Set Up Later"]) {
  const b = win.locator(".onboarding button", { hasText: label });
  if (await b.count()) await b.click();
}
await win.waitForSelector(".onboarding", { state: "detached" });

// ── into terminals ──
const term = await openWin("terminal", { cwd: fixture });
await select(term.id);
const xterm = `.tile[data-pane="${term.id}"] .xterm`;
await win.locator(xterm).waitFor();
await win.waitForTimeout(1500);
await dropOn(xterm, { files: [out("dropped file.txt")] });
const escaped = out("dropped file.txt").replace(/ /g, "\\ ");
check(await waitFor(async () => squash(await screen(term.id)).includes(squash(escaped))), "a file dropped on a terminal types its path, escaped like Terminal.app");
await win.keyboard.press("Control+C");
await dropOn(xterm, { items: [{ mimeType: "text/uri-list", data: "https://example.com/dropped" }] });
check(await waitFor(async () => (await screen(term.id)).includes("https://example.com/dropped")), "a link dropped on a terminal types the URL");
await win.keyboard.press("Control+C");
await dropOn(xterm, { files: [path.join(fixture, "box")], modifiers: META });
check(await waitFor(async () => squash(await screen(term.id)).includes(squash(`cd ${path.join(fixture, "box")}`))), "⌘-dropping a folder on a terminal types cd and its path");
await win.keyboard.press("Control+C");

// ── into a file browser ──
const files = await openWin("files", { path: path.join(fixture, "box") });
await select(files.id);
const list = `.tile[data-pane="${files.id}"] .ui-tree`;
await win.locator(`${list} .ui-tree-row`).first().waitFor();
await dropOn(list, { files: [out("moved.txt")], at: [0.5, 0.8] });
check(win.url() === startUrl, "a file dropped on a file browser leaves the app in place");
check(fs.existsSync(inBox("moved.txt")) && !fs.existsSync(out("moved.txt")), "a file dropped on a file browser's empty space moves into its folder");
await dropOn(`${list} .ui-tree-row[data-path="${inBox("inner")}"]`, { files: [out("dropped file.txt")] });
check(fs.existsSync(inBox("inner/dropped file.txt")), "a file dropped on a folder's row moves into that folder");
await dropOn(list, { files: [out("copied.txt")], modifiers: ALT, at: [0.5, 0.8] });
check(fs.existsSync(inBox("copied.txt")) && fs.existsSync(out("copied.txt")), "⌥-dropping copies instead");
check(await waitFor(() => win.locator(`${list} .ui-tree-row[data-path="${inBox("copied.txt")}"][data-selected]`).count()), "the dropped file shows and is selected");
{
  // Mid-drag over a folder: the window's ring and the folder's row are marked.
  const box = await win.locator(`${list} .ui-tree-row[data-path="${inBox("inner")}"]`).boundingBox();
  const data = { items: [], files: [out("page.txt")], dragOperationsMask: 1 | 16 };
  for (const type of ["dragEnter", "dragOver"]) await cdp.send("Input.dispatchDragEvent", { type, x: box.x + 40, y: box.y + box.height / 2, data });
  await win.waitForTimeout(200);
  check((await win.locator(`.tile[data-pane="${files.id}"].drop-over .ui-tree-row[data-dropping]`).count()) === 1, "a drag over a folder marks the window and the folder");
  await win.screenshot({ path: path.join(shots, "drops-files.png") });
  await cdp.send("Input.dispatchDragEvent", { type: "dragCancel", x: 0, y: 0, data });
  await win.waitForTimeout(200);
  check((await win.locator(".drop-over, [data-dropping]").count()) === 0, "a cancelled drag leaves no marks");
}

// ── a window without a target of its own opens what's dropped ──
const text = await openWin("text", { path: out("page.txt") });
await select(text.id);
await win.locator(`.tile[data-pane="${text.id}"] .cm-content`).waitFor();
const before = (await windows()).length;
await dropOn(`.tile[data-pane="${text.id}"] .cm-content`, { files: [out("opened.md")] });
check(await waitFor(async () => (await windows()).some((w) => w.state.path === out("opened.md"))), "a file dropped on a text window opens in a window of its own");
const after = (await windows()).length;
check(after === before + 1, "only one window opened");
await dropOn(".statusbar", { files: [out("page.txt")] });
check(win.url() === startUrl && (await windows()).length === after, "a file dropped outside the board (the status bar) is refused");

// ── guards: native alerts and confirmations (dialogs stubbed: record, answer with __answer) ──
await app.evaluate(({ dialog }) => {
  globalThis.__dialogs = [];
  dialog.showMessageBox = async (...args) => {
    const o = args.at(-1);
    globalThis.__dialogs.push({ message: o.message, detail: o.detail, buttons: o.buttons });
    return { response: globalThis.__answer ?? 0, checkboxChecked: false };
  };
});
const dialogs = () => app.evaluate(() => globalThis.__dialogs.splice(0));
const answer = (n) => app.evaluate((_e, n) => (globalThis.__answer = n), n);
await select(files.id);
{
  // A file that's gone by the time it's dropped.
  fs.writeFileSync(out("ghost.txt"), "boo");
  const box = await win.locator(list).boundingBox();
  const at = { x: box.x + box.width / 2, y: box.y + box.height * 0.8, data: { items: [], files: [out("ghost.txt")], dragOperationsMask: 1 | 16 } };
  for (const type of ["dragEnter", "dragOver"]) await cdp.send("Input.dispatchDragEvent", { type, ...at });
  fs.rmSync(out("ghost.txt"));
  await cdp.send("Input.dispatchDragEvent", { type: "drop", ...at });
  await win.waitForTimeout(500);
}
let shown = await dialogs();
check(shown.length === 1 && shown[0].message === "Couldn't move “ghost.txt”" && /isn't there anymore/.test(shown[0].detail), `a move the core refuses explains why in an alert (${JSON.stringify(shown)})`);
// page.txt is open in the text window: moving it asks first.
await answer(1);
await dropOn(list, { files: [out("page.txt")], at: [0.5, 0.8] });
shown = await dialogs();
check(shown.length === 1 && /^Move “page.txt” into “box”\?$/.test(shown[0].message) && /page\.txt/.test(shown[0].detail) && shown[0].buttons[0] === "Move", `moving a file an open window shows asks first (${JSON.stringify(shown)})`);
check(fs.existsSync(out("page.txt")) && !fs.existsSync(inBox("page.txt")), "Cancel leaves it where it was");
await answer(0);
await dropOn(list, { files: [out("page.txt")], at: [0.5, 0.8] });
check(await waitFor(() => fs.existsSync(inBox("page.txt"))), "Move moves it");
await dialogs();
// Every move can be undone from its toast.
const undo = win.locator(".ui-toast", { hasText: "Moved “page.txt” to “box”" }).locator("button", { hasText: "Undo" });
check(await waitFor(() => undo.count()), "a move shows a toast with Undo");
await undo.click();
check(await waitFor(() => fs.existsSync(out("page.txt")) && !fs.existsSync(inBox("page.txt"))), "Undo puts it back");

// ── out of cmd: native drags (startDrag stubbed to record) ──
await app.evaluate(({ webContents }) => {
  globalThis.__startDrags = [];
  for (const wc of webContents.getAllWebContents()) wc.startDrag = (item) => globalThis.__startDrags.push(item.files);
});
const startDrags = () => app.evaluate(() => globalThis.__startDrags);
await select(files.id);
await win.locator(`${list} .ui-tree-row[data-path="${inBox("moved.txt")}"]`).dispatchEvent("dragstart");
check(await waitFor(async () => JSON.stringify(await startDrags()) === JSON.stringify([[inBox("moved.txt")]])), "dragging a file browser's row starts a native drag of that file");
await win.locator(`.tile[data-pane="${files.id}"] .tile-title .mark-drag`).dispatchEvent("dragstart");
check(await waitFor(async () => JSON.stringify((await startDrags())[1]) === JSON.stringify([path.join(fixture, "box")])), "dragging a file browser's title icon drags its folder");

app.process().kill();
await stopCore(home, { terminals: true });
process.exit(failed ? 1 : 0);
