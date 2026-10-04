// The phone's side of remote access (docs/13-remote-access.md): the web client
// (apps/web, Vite dev server) in an emulated iPhone, a local relay and a core on
// a throwaway CMD_HOME; the Mac's approval comes over the core's socket, as
// `cmd remote pair` does. Pairs, opens a terminal from Now, types from the key
// row and the compose bar, checks the text reached the PTY and that the Mac's
// terminal is sized for the phone while it shows it, then has the Mac unpair it. Screenshots in .cmd-dev/shots/web-*.png. `pnpm e2e:web`;
// E2E_HOSTED=1 runs it against the deployed relay and client instead.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium, devices } from "playwright";
import { pathToFileURL } from "node:url";
import { stopCore } from "../scripts/stop-core.mjs";
import { startRelay } from "../apps/relay/src/relay.ts";
import { connect } from "../packages/protocol/src/node.ts";

const root = path.resolve(import.meta.dirname, "..");
// vite is apps/web's dependency, not the root's.
const { createServer } = await import(pathToFileURL(path.join(root, "apps/web/node_modules/vite/dist/node/index.js")).href);
const home = path.join(root, ".cmd-dev", "e2e-web");
const shots = path.join(root, ".cmd-dev", "shots");
await stopCore(home, { terminals: true });
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(shots, { recursive: true });

const check = (cond, msg) => {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
};
const until = async (fn, msg, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return check(true, msg);
    await new Promise((r) => setTimeout(r, 150));
  }
  check(false, msg);
};

// E2E_HOSTED=1: the deployed relay and client, with the core on its default settings.
const hosted = !!process.env.E2E_HOSTED;
const relay = hosted ? null : await startRelay({ log: () => {} });
const web = hosted ? null : await createServer({ root: path.join(root, "apps/web"), configFile: path.join(root, "apps/web/vite.config.ts"), server: { port: 0 }, logLevel: "error" });
await web?.listen();
const client = hosted ? "https://cmd.endtime-instruments.org" : web.resolvedUrls.local[0].replace(/\/$/, "");
fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify(hosted ? { "remote.enabled": true } : { "remote.enabled": true, "remote.relay": relay.url, "remote.client": client }));
const core = spawn(process.execPath, ["--no-warnings", path.join(root, "packages/core/src/main.ts"), "--instance=dev"], { env: { ...process.env, CMD_HOME: home }, stdio: "ignore", detached: true });
core.unref();

let mac;
const browser = await chromium.launch();
try {
  const sock = path.join(home, "core.sock");
  await until(async () => fs.existsSync(sock), "the core starts");
  mac = await connect(sock);
  const call = (m, p = {}) => mac.client.call(m, p);
  await until(async () => (await call("remote.status")).state === "online", "the core reaches the relay");
  const requests = [];
  mac.client.onEvent((e) => e.type === "remote.pairRequest" && requests.push(e.request));
  await call("events.subscribe", { types: ["remote.pairRequest"] });

  const phone = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await phone.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  const shot = (name) => page.screenshot({ path: path.join(shots, `web-${name}.png`) });

  await page.goto(client);
  await page.getByText("Not paired yet").waitFor();
  check(true, "an unpaired browser says how to pair");

  const { url } = await call("remote.pair", { scope: "control" });
  await page.goto(url);
  await page.getByText("Approve on your Mac").waitFor();
  check(!page.url().includes("#"), "the one-time key leaves the address bar at once");
  const words = await page.locator(".words span").allInnerTexts();
  await until(async () => requests.length === 1, "the Mac is asked");
  check(requests[0].words.join(" ") === words.join(" "), `both screens show the same words (${words.join(" ")})`);
  check(/iPhone/.test(requests[0].name), `the Mac sees the device's name (${requests[0].name})`);
  await shot("1-approve");
  await call("remote.approve", { requestId: requests[0].requestId, allow: true, scope: "control" });
  await page.getByText("Nothing running").waitFor();
  check(true, "approved: the phone lands on Now");

  const pane = await call("pane.create", {});
  await page.locator(".row").first().waitFor();
  check(true, "a new terminal shows up in Now");
  await shot("2-now");
  await page.locator(".row").first().click();
  await page.locator(".term .xterm-rows").waitFor();
  await until(async () => (await call("remote.status")).sessions[0]?.watching.includes(pane.id), "opening it follows it on the Mac");
  // Control: the Mac's terminal takes the phone's size; the page itself doesn't scroll.
  await until(async () => /iPhone/.test((await call("pane.list")).find((p) => p.id === pane.id).sizedBy ?? ""), "the Mac's terminal is sized for the phone");
  const fitted = (await call("pane.list")).find((p) => p.id === pane.id);
  check(fitted.cols < 70 && fitted.rows > 10, `it fits the phone (${fitted.cols}×${fitted.rows})`);
  check(await page.evaluate(() => document.scrollingElement.scrollHeight <= innerHeight + 1), "the page doesn't scroll, only the terminal");
  // Less room (the keyboard opening): fewer rows.
  const vp = page.viewportSize();
  await page.setViewportSize({ width: vp.width, height: vp.height - 300 });
  await until(async () => (await call("pane.list")).find((p) => p.id === pane.id).rows < fitted.rows, "a smaller viewport (keyboard) refits the rows");
  await page.setViewportSize(vp);
  await page.locator(".compose input").fill("echo phone-was-here");
  await page.locator(".compose button").click();
  await until(async () => (await call("pane.read", { paneId: pane.id })).text.includes("phone-was-here\n"), "the compose bar types into the terminal");
  await until(async () => (await page.locator(".term").innerText()).includes("phone-was-here"), "the output comes back to the phone");
  await page.getByRole("button", { name: "^C" }).click();
  await shot("3-terminal");

  // Back to Now: the Mac gets its size back.
  await page.getByRole("button", { name: "‹ Now" }).click();
  await until(async () => (await call("pane.list")).find((p) => p.id === pane.id).sizedBy === null, "leaving the terminal gives the Mac its size back");

  // The phone comes back after a reload: it remembers the Mac, no pairing.
  await page.reload();
  await page.locator(".row").first().waitFor();
  check(true, "a reload reconnects without pairing again");

  const [device] = await call("remote.devices");
  await call("remote.revoke", { id: device.id });
  await page.reload();
  await page.getByText("Not paired anymore").waitFor();
  check(true, "an unpaired phone says so");
  await shot("4-revoked");
  console.log(`screenshots: ${shots}/web-*.png`);
} catch (err) {
  console.log(err.message);
  process.exitCode = 1;
} finally {
  mac?.close();
  await browser.close();
  await web?.close();
  await stopCore(home, { terminals: true });
  await relay?.close();
}
process.exit(process.exitCode ?? 0);
