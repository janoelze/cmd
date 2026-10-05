// Remote access through the real app (docs/13-remote-access.md, "Experience"):
// a local relay, the built app on a throwaway CMD_HOME, and a pretend phone
// (Node, the same @cmd/remote-crypto code the web client uses). Walks the
// journey: Pair a Device… → code in Settings → the phone scans → approve on the
// Mac → the status bar indicator, its popover, the watched window's badge and
// the typing marker. Screenshots in .cmd-dev/shots/remote-*.png. `pnpm e2e:remote`;
// E2E_VERBOSE=1 also prints Electron's output and the renderer's console.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright";
import { stopCore } from "../scripts/stop-core.mjs";
import { startRelay } from "../apps/relay/src/relay.ts";
import { RpcClient } from "../packages/protocol/src/index.ts";
import { decodePairing, generateKeyPair, openDeviceSession } from "../packages/remote-crypto/src/index.ts";

const root = path.resolve(import.meta.dirname, "..");
const home = path.join(root, ".cmd-dev", "e2e-remote");
const shots = path.join(root, ".cmd-dev", "shots");
await stopCore(home, { terminals: true });
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(shots, { recursive: true });

const relay = await startRelay({ log: () => {} });
fs.writeFileSync(
  path.join(home, "settings.json"),
  JSON.stringify({ "remote.enabled": true, "remote.relay": relay.url, "remote.client": "https://client.test", "agents.claude.command": "echo claude" }),
);

const require = createRequire(path.join(root, "apps/desktop/package.json"));
const app = await electron.launch({ executablePath: require("electron"), args: [path.join(root, "apps/desktop")], env: { ...process.env, CMD_HOME: home, CMD_NO_SANDBOX: "1", CMD_BACKGROUND: process.env.E2E_VISIBLE ? "" : "1" } });
const win = await app.firstWindow();
win.on("pageerror", (e) => console.log("pageerror:", e.message));
win.on("crash", () => console.log("main window crashed"));
win.on("console", (m) => process.env.E2E_VERBOSE && m.type() !== "debug" && console.log(`[console.${m.type()}] ${m.text()}`));
app.process().stderr?.on("data", (d) => process.env.E2E_VERBOSE && process.stdout.write(`[electron] ${d}`));
app.process().stdout?.on("data", (d) => process.env.E2E_VERBOSE && process.stdout.write(`[electron:out] ${d}`));

// Never hang: a stuck step fails the run with a screenshot.
setTimeout(async () => {
  console.log("HUNG");
  await win.screenshot({ path: path.join(shots, "remote-hung.png") }).catch(() => {});
  process.exit(1);
}, 100_000).unref();
const shot = (page, name) => page.screenshot({ path: path.join(shots, `remote-${name}.png`) });
const check = (cond, msg) => {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
};
const until = async (fn, msg, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return check(true, msg);
    await new Promise((r) => setTimeout(r, 100));
  }
  check(false, msg);
};
const menu = (id) =>
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`no menu item ${id}`);
    item.click();
  }, id);

let ws;
try {
  await win.waitForSelector(".statusbar .core-status");
  await until(() => win.evaluate(() => window.cmd.call("remote.status", {}).then((s) => s.state === "online")), "the core reaches the relay");
  await win.waitForSelector(".statusbar .remote-indicator.idle");
  check(true, "the status bar shows remote access is ready");


  // Pair a Device… opens Settings at a live code.
  const settingsOpened = app.waitForEvent("window");
  await menu("app.pairDevice");
  const settings = await settingsOpened;
  await settings.waitForSelector(".rm-qr svg");
  check(true, "Pair a Device… shows a pairing code in Settings");
  await shot(settings, "1-code");

  // The phone: a fresh link (the page's code is replaced, as a rotation would).
  const { url } = await win.evaluate(() => window.cmd.call("remote.pair", {}));
  const link = decodePairing(new URL(url).hash);
  ws = new WebSocket(`${link.relay}/r/${link.route}`);
  ws.binaryType = "arraybuffer";
  await new Promise((r) => (ws.onopen = r));
  let words = [];
  const device = openDeviceSession({
    socket: { send: (b) => ws.send(b), close: () => ws.close() },
    hostKey: link.hostKey,
    device: await generateKeyPair(),
    psk: link.psk,
    hello: { name: "iPhone" },
    onFingerprint: (w) => (words = w),
  });
  ws.onmessage = (e) => device.receive(new Uint8Array(e.data));
  ws.onclose = () => device.closed();

  await win.waitForSelector(".statusbar .remote-indicator.asking");
  check(true, "the indicator pulses while a device waits");
  await settings.waitForSelector(".rm-card .pair-prompt");
  const shown = await settings.locator(".rm-card .pair-words span").allInnerTexts();
  check(shown.join(" ") === words.join(" "), `Settings asks, with the phone's words (${shown.join(" ")})`);
  await win.waitForSelector(".pair-sheet");
  check(true, "the main window asks too");
  await shot(settings, "2-approve-settings");
  await shot(win, "3-approve-sheet");
  await settings.getByRole("button", { name: "Allow Control" }).click();
  const session = await device.session;
  check(session.host.scope === "control", "the phone is in, with control");
  await win.waitForSelector(".pair-sheet", { state: "detached" });
  check(true, "answering in Settings dismisses the main window's sheet");

  // The phone opens a terminal, looks at it and types: the Mac shows all three.
  const client = new RpcClient((line) => void session.send(line));
  session.onLine((l) => client.receive(l));
  await client.call("remote.bootstrap", {});
  const pane = await client.call("pane.create", {});
  await client.call("window.follow", { ids: [pane.id] });
  await win.waitForSelector(".statusbar .remote-indicator.connected");
  check(true, "the indicator turns to connected");
  await client.call("pane.write", { paneId: pane.id, data: "echo hello from the phone\r" });

  // Focus view: the status bar stands in for the title bar.
  await win.waitForSelector(".statusbar .remote-badge.typed");
  check(true, "the watched terminal shows who typed");
  await win.waitForSelector(".sidebar .row .remote-badge");
  check(true, "its sidebar row shows it's watched");
  await shot(win, "4-connected");
  // The phone sizes the terminal to its screen: the Mac says so and can take it back.
  await client.call("pane.fitOverride", { paneId: pane.id, cols: 48, rows: 30 });
  await win.waitForSelector(".term-sized");
  check((await win.locator(".term-sized").innerText()).includes("iPhone"), "the Mac shows the phone sizes the terminal");
  await shot(win, "4b-sized");
  await win.getByRole("button", { name: "Take Back" }).click();
  await win.waitForSelector(".term-sized", { state: "detached" });
  const back = (await win.evaluate(() => window.cmd.call("pane.list", {}))).find((p) => p.id === pane.id);
  check(back.sizedBy === null && back.cols > 48, `Take Back gives the Mac its size (${back.cols}×${back.rows})`);
  await win.locator(".remote-indicator").click();
  await win.waitForSelector(".remote-popover");
  const pop = await win.locator(".remote-popover").innerText();
  check(pop.includes("iPhone") && pop.includes("watching"), "the popover says who is in and what they watch");
  await shot(win, "5-popover");

  await settings.bringToFront();
  await settings.waitForSelector("text=Connected Now");
  await shot(settings, "6-settings");

  // Disconnect from the popover: the indicator goes, the device stays paired.
  await win.bringToFront();
  await win.getByRole("button", { name: "Disconnect All" }).click();
  await win.waitForSelector(".statusbar .remote-indicator.idle");
  const devices = await win.evaluate(() => window.cmd.call("remote.devices", {}));
  check(devices.length === 1, "Disconnect All keeps the device paired");
  console.log(`screenshots: ${shots}/remote-*.png`);
} catch (err) {
  console.log(err.message);
  await shot(win, "failed").catch(() => {});
  process.exitCode = 1;
} finally {
  ws?.close();
  const within = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 10_000))]);
  await within(app.close().catch(() => {}));
  await within(stopCore(home, { terminals: true }));
  await within(relay.close());
}
process.exit(process.exitCode ?? 0); // the phone's WebSocket would keep Node alive
