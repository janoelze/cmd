// Accessibility audit: launches the built app against a throwaway core, opens
// the main views and records what a script (or a screen reader) can find by
// role and name. For each view it writes Playwright's ARIA snapshot and lists
// the controls without a name, then drives a short tour by role and name only,
// the way a scripted demo video will. Fails on an unnamed control or a failed
// check. usage: pnpm e2e:a11y  → .cmd-dev/a11y/
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
fs.writeFileSync(path.join(fakeHome, "notes.md"), "# Notes\n");
fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ "agents.claude.command": "echo claude" }));

const require = createRequire(path.join(root, "apps/desktop/package.json"));
const app = await electron.launch({
  executablePath: require("electron"),
  args: [path.join(root, "apps/desktop")],
  env: { ...process.env, HOME: fakeHome, CMD_HOME: home, CMD_USAGE_URL: "off", CMD_NO_SANDBOX: "1", CMD_BACKGROUND: "1", CMD_MAGIC_UNSANDBOXED: "1", CMD_TRANSCRIPTS_HOME: path.join(home, "transcripts") },
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

/** Every control in Chromium's accessibility tree that has no name. */
async function unnamed(page) {
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  await cdp.detach();
  return nodes
    .filter((n) => !n.ignored && CONTROLS.has(n.role?.value) && !n.name?.value?.trim())
    .map((n) => ({ role: n.role.value, value: n.value?.value, backend: n.backendDOMNodeId }));
}

const summary = [];
async function audit(name, page = win) {
  console.log(`… ${name}`);
  const tree = await page.locator("body").ariaSnapshot();
  fs.writeFileSync(path.join(out, `${name}.aria.yml`), tree);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  const missing = await unnamed(page);
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
}

let failed = 0;
const ok = (cond, msg) => (cond || failed++, console.log(`${cond ? "ok" : "FAIL"} - ${msg}`));

await win.waitForSelector(".statusbar .core-status");
await win.waitForSelector(".onboarding");
await audit("onboarding");
await win.locator(".onboarding button", { hasText: "Get Started" }).click();
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
await settle(300);
await audit("sidebar-search");
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


// The tour: find things the way a scripted video would, by role and name only.
await menu("view.grid");
await settle();
const tiles = win.getByRole("main").getByRole("group", { name: /zsh/ });
ok((await tiles.count()) === 2, `two terminal windows by name (${await tiles.count()})`);
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
await audit("settings", settings);
ok((await settings.getByRole("combobox", { name: "Dark theme" }).count()) === 1, "Settings: the Dark theme menu by name");
ok((await settings.getByRole("textbox", { name: "Code font", exact: true }).count()) === 1, "Settings: the Code font field by name");

console.log("\n" + ["view".padEnd(22) + "controls  unnamed", ...summary.map((s) => s.view.padEnd(22) + String(s.controls).padStart(8) + String(s.unnamed).padStart(9))].join("\n"));
console.log(`\nsnapshots and screenshots: ${path.relative(process.cwd(), out)}`);
await app.close();
process.exit(failed ? 1 : 0);
