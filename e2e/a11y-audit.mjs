// Accessibility audit: launches the built app against a throwaway core, opens
// the main views and records what a script (or a screen reader) can find by
// role and name. For each view it writes Playwright's ARIA snapshot and lists
// the controls without a name, then drives a short tour by role and name only,
// the way a scripted demo video will. Fails on an unnamed control or a failed
// check. usage: pnpm e2e:a11y  → .cmd-dev/a11y/
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright";
import { corePid, stopCore } from "../scripts/stop-core.mjs";

const root = path.resolve(import.meta.dirname, "..");
const home = path.join(root, ".cmd-dev", "a11y-home");
const out = path.join(root, ".cmd-dev", "a11y");
await stopCore(home, { terminals: true });
process.on("exit", () => {
  for (const pid of [corePid(home), corePid(home, "ptyhost")]) {
    try {
      if (pid) process.kill(pid, "SIGTERM");
    } catch {}
  }
});
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(out, { recursive: true });
// A fixture home: terminals start in it and the Files window shows it, so the output never has your files.
const fakeHome = path.join(home, "home");
for (const d of ["Desktop", "Documents", "src/website", "src/website/assets"]) fs.mkdirSync(path.join(fakeHome, d), { recursive: true });
fs.writeFileSync(path.join(fakeHome, "src/website/index.html"), "<h1>hi</h1>\n");
fs.writeFileSync(path.join(fakeHome, "notes.md"), "# Notes\n\nSome *text* and a [link](https://example.com).\n");
// A repository with a change, for the Live Diff widget.
const repo = path.join(fakeHome, "src/website");
const git = (...a) => execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.com", ...a], { cwd: repo, stdio: "ignore" });
git("init", "-q");
git("add", "-A");
git("commit", "-qm", "first");
fs.writeFileSync(path.join(repo, "index.html"), "<h1>hello</h1>\n");
// The smallest PDF pdf.js opens (it rebuilds the cross-reference table).
fs.writeFileSync(
  path.join(fakeHome, "Documents/guide.pdf"),
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 40 100 Td (Hello PDF) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);
fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ "agents.claude.command": "echo claude" }));

const require = createRequire(path.join(root, "apps/desktop/package.json"));
const app = await electron.launch({
  executablePath: require("electron"),
  args: [path.join(root, "apps/desktop")],
  env: { ...process.env, HOME: fakeHome, CMD_HOME: home, CMD_USAGE_URL: "off", CMD_DEV_KEYS: "off", CMD_NO_SANDBOX: "1", CMD_BACKGROUND: "1", CMD_MAGIC_UNSANDBOXED: "1", CMD_TRANSCRIPTS_HOME: path.join(home, "transcripts") },
});
const win = await app.firstWindow();
win.setDefaultTimeout(10_000);
console.log("launched");
const menu = (id) =>
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`no menu item ${id}`);
    item.click();
  }, id);
const settle = (ms = 600) => win.waitForTimeout(ms);

// Roles a script clicks, types into or picks from: each needs a name.
const CONTROLS = new Set(["button", "link", "textbox", "searchbox", "combobox", "listbox", "option", "tree", "treeitem", "tab", "tablist", "radio", "radiogroup", "switch", "checkbox", "menuitem", "menuitemradio", "slider", "spinbutton", "PopUpButton", "toggleButton"]);

/**
 * Every control in Chromium's accessibility tree that has no name, and the
 * names with digits in them: a count or a live value in a name ("Windows 2",
 * "Core 87 MB") changes under a script that looks for it.
 */
async function unnamed(page) {
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  await cdp.detach();
  const controls = nodes.filter((n) => !n.ignored && CONTROLS.has(n.role?.value));
  return {
    missing: controls.filter((n) => !n.name?.value?.trim()).map((n) => ({ role: n.role.value, value: n.value?.value, backend: n.backendDOMNodeId })),
    numeric: controls.filter((n) => /\d/.test(n.name?.value ?? "") && !["option", "treeitem", "radio"].includes(n.role.value)).map((n) => `${n.role.value} "${n.name.value}"`),
  };
}

const summary = [];
async function audit(name, page = win) {
  console.log(`… ${name}`);
  const tree = await page.locator("body").ariaSnapshot();
  fs.writeFileSync(path.join(out, `${name}.aria.yml`), tree);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  const { missing, numeric } = await unnamed(page);
  // Where each one is: its class, for fixing it.
  const cdp = await page.context().newCDPSession(page);
  for (const m of missing) {
    const { node } = await cdp.send("DOM.describeNode", { backendNodeId: m.backend }).catch(() => ({ node: null }));
    const attrs = node?.attributes ?? [];
    m.at = `${node?.localName ?? "?"}.${(attrs[attrs.indexOf("class") + 1] ?? "").split(/\s+/).slice(0, 2).join(".")}`;
  }
  await cdp.detach();
  const controls = (tree.match(/^\s*- (button|textbox|combobox|option|treeitem|tab|radio|switch|checkbox|menuitem)\b/gm) ?? []).length;
  summary.push({ view: name, controls, unnamed: missing.length });
  failed += missing.length;
  console.log(`\n## ${name}: ${missing.length} unnamed control${missing.length === 1 ? "" : "s"}`);
  for (const m of missing) console.log(`    ${m.role} ${m.at}${m.value ? ` value="${String(m.value).slice(0, 30)}"` : ""}`);
  for (const n of numeric) if (!seenNumeric.has(n)) (seenNumeric.add(n), console.log(`    (a number in its name) ${n}`));
}
const seenNumeric = new Set();

/**
 * Opens something (a sheet, a popover, a picker or a window of its own),
 * audits it and closes it again (Escape, or closing the new window).
 */
async function popup(name, open, close = () => win.keyboard.press("Escape")) {
  const before = new Set(app.windows());
  await open();
  await settle(900);
  const added = app.windows().filter((p) => !before.has(p));
  if (added.length) {
    for (const p of added) {
      await p.waitForLoadState();
      await p.waitForTimeout(600);
      await audit(name, p);
      await p.close();
    }
  } else {
    await audit(name);
    await close();
    await settle(300);
  }
}

let failed = 0;
const ok = (cond, msg) => (cond || failed++, console.log(`${cond ? "ok" : "FAIL"} - ${msg}`));

await win.waitForSelector(".statusbar .core-status");
await win.waitForSelector(".onboarding");
await audit("onboarding");
await win.locator(".onboarding button", { hasText: "Get Started" }).click();
await settle(300);
await audit("onboarding-ai");
await win.locator(".onboarding button", { hasText: "Set Up Later" }).click();
await win.waitForSelector(".onboarding", { state: "detached" });

await menu("file.newTerminal");
await win.locator(".xterm:visible").first().waitFor();
await menu("file.newTerminal");
await settle();
await audit("focus-two-terminals");

await menu("view.grid");
await settle();
await audit("grid");

await menu("view.palette");
await win.locator(".palette").waitFor();
await win.keyboard.type("new");
await settle(300);
await audit("palette");
await win.keyboard.press("Escape");

await menu("view.search");
await win.locator(".palette").waitFor();
await win.keyboard.type("vpn");
await settle(300);
await audit("palette-search");
await win.keyboard.press("Escape");

await menu("file.newFiles");
await win.locator(".tile.kind-files").first().waitFor();
await settle();
await audit("files");

await menu("file.newText");
await settle();
await audit("text");

await menu("view.canvas");
await settle();
await audit("canvas");

await menu("view.strip");
await settle();
await audit("strip");

// Docked: the selected window in the left sidebar, then the right sidebar.
await menu("view.grid");
await win.getByRole("main").getByRole("group").first().click({ position: { x: 40, y: 10 } });
await menu("window.dockLeft");
await settle();
await menu("view.rightSidebar");
await settle();
await audit("docked");
await menu("view.rightSidebar");
await menu("window.undock");
await settle();

// Every window type, one at a time, then closed again. In Grid: a window opened
// over the API isn't selected, so Focus would keep showing the last one.
await menu("view.grid");
const call = (m, p = {}) => win.evaluate(([m, p]) => window.cmd.call(m, p), [m, p]);
const INPUT = {
  markdown: { path: path.join(fakeHome, "notes.md") },
  pdf: { path: path.join(fakeHome, "Documents/guide.pdf") },
  diff: { path: repo },
};
const DONE = new Set(["terminal", "files", "text", "youtube"]); // audited above; YouTube needs the network
const types = await call("window.types");
for (const t of types) {
  if (DONE.has(t.kind)) continue;
  const w = await call("window.open", { kind: t.kind, input: INPUT[t.kind] ?? {} }).catch((e) => (console.log(`    (can't open ${t.kind}: ${e.message})`), null));
  if (!w) continue;
  // A Magic widget staged with its code and data, so no model runs.
  if (t.kind === "magic")
    await call("window.update", {
      id: w.id,
      title: "Open PRs",
      state: { prompt: "Open PRs", phase: "ready", kind: "widget", html: '<div class="k-big" id="v">–</div><script>cmd.onData((d) => (v.textContent = d.text))</script>', source: null, refresh: 0, size: "m", lastData: { data: { text: "3 open" }, at: Date.now() } },
    });
  await settle(1200);
  const tile = win.getByRole("main").locator(`[data-pane="${w.id}"]`);
  ok(await tile.isVisible(), `${t.kind}: the window is on screen, named "${await tile.getAttribute("aria-label")}"`);
  await audit(`window-${t.kind}`);
  await call("window.close", { id: w.id });
  await settle(300);
}

// Sheets, popovers, pickers and the windows of their own.
await popup("new-picker", () => menu("file.new"));
await popup("space-picker", () => menu("file.openSpace"));
await popup("space-menu", () => win.getByRole("banner").getByRole("button").first().click());
await popup("space-rename", () => menu("space.rename"));
await popup("space-icon", () => menu("space.icon"));
await popup("move-window", () => menu("space.moveWindow"));
await popup("widget-library", () => menu("widget.library"));
await popup("whats-new", () => menu("help.whatsNew"));
await popup("core-status", () => win.getByRole("contentinfo").getByRole("button").first().click());
await popup("remote-access", () => menu("app.remoteAccess"));
await popup("pair-device", () => menu("app.pairDevice"));
await popup("setup", () => menu("app.setup"));
await popup("task-manager", () => menu("app.taskManager"));
await menu("file.newTerminal");
await settle();
await popup("terminal-find", () => menu("edit.find"));


// The tour: find things the way a scripted video would, by role and name only.
await menu("view.grid");
await settle();
const tiles = win.getByRole("main").getByRole("group", { name: /zsh/ });
ok((await tiles.count()) >= 2, `the terminal windows by name (${await tiles.count()})`);
const rows = win.getByRole("tree", { name: "Windows" }).getByRole("treeitem");
ok((await rows.count()) >= 2, `the sidebar's Windows section lists them (${(await rows.allInnerTexts()).length} rows)`);
const files = win.getByRole("tree", { name: "Files" }).getByRole("treeitem", { name: "notes.md", exact: true });
ok((await files.count()) === 1, "the Files window lists notes.md by name");
await rows.first().click();
ok((await rows.first().getAttribute("aria-selected")) === "true", "clicking a row selects it (aria-selected)");
ok((await win.locator('[role=group][aria-current="true"]').count()) === 1, "one window is current");
await win.getByRole("button", { name: "Focus" }).click();
await settle(300);
ok((await win.getByRole("button", { name: "Focus" }).getAttribute("aria-pressed")) === "true", "the Focus view button is pressed");
await menu("view.palette");
await win.getByRole("combobox").fill("new term");
const option = win.getByRole("option", { name: "New Terminal", exact: true });
ok((await option.count()) === 1 && (await option.getAttribute("aria-selected")) === "true", "the palette offers New Terminal, highlighted");
await win.keyboard.press("Escape");

await menu("app.settings");
const settings = await app.waitForEvent("window", { predicate: (p) => p.url().includes("settings") });
await settings.waitForLoadState();
await settle();
// Remote Access above left Settings on its page; go back by role, like a tour would.
await settings.getByRole("navigation").getByRole("button", { name: "Appearance" }).click();
await settings.waitForTimeout(300);
await audit("settings", settings);
ok((await settings.getByRole("combobox", { name: "Dark theme" }).count()) === 1, "Settings: the Dark theme menu by name");
ok((await settings.getByRole("textbox", { name: "Code font", exact: true }).count()) === 1, "Settings: the Code font field by name");

console.log("\n" + ["view".padEnd(22) + "controls  unnamed", ...summary.map((s) => s.view.padEnd(22) + String(s.controls).padStart(8) + String(s.unnamed).padStart(9))].join("\n"));
console.log(`\nsnapshots and screenshots: ${path.relative(process.cwd(), out)}`);
// app.close() can wait for good on pipes the detached core inherited; give it a few seconds.
await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]);
process.exit(failed ? 1 : 0);
