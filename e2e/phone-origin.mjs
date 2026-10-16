// The phone origin on this Mac, without a phone (docs/56-phone-development.md):
// `pnpm phone:serve` (no Tailscale) on a free port and the phone's dev core,
// started by `pnpm phone:core` from this checkout in its fixed state dir (a
// throwaway CMD_PHONE_DIR, never ~/.cmd-phone). An emulated iPhone (Chromium)
// opens `phone:pair dev --json`'s link and pairs through Vite's /c/dev proxy;
// the Mac approves over the core's socket (as `cmd remote pair` does). Then
// `phone:core` runs it from another checkout (a throwaway git worktree of HEAD
// that borrows this one's node_modules): the core restarts on that code, and a
// reload is connected again with no pairing. `pnpm e2e:phone-origin`.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { chromium, devices } from "playwright";
import { stopCore } from "../scripts/stop-core.mjs";
import { connect } from "../packages/protocol/src/node.ts";

const root = path.resolve(import.meta.dirname, "..");
// Short paths: the core's socket lives in its state dir.
const base = path.join(root, ".cmd-dev", "e2e-phone");
const phoneDir = path.join(base, "p");
const home = path.join(phoneDir, "home");
const other = path.join(base, "wt");
const dropOther = () => {
  if (fs.existsSync(other)) execFileSync("git", ["-C", root, "worktree", "remove", "--force", other], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "worktree", "prune"], { stdio: "ignore" });
};
await stopCore(home, { terminals: true });
dropOther();
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(phoneDir, { recursive: true });

const check = (cond, msg) => {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
};
const until = async (fn, msg, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return check(true, msg);
    await new Promise((r) => setTimeout(r, 150));
  }
  check(false, msg);
};
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// The scripts as a developer runs them, with their state in the throwaway folder; no pane context.
const env = { ...process.env, CMD_PHONE_DIR: phoneDir };
for (const k of ["CMD_SOCKET", "CMD_PANE_ID", "CMD_HOME"]) delete env[k];
const script = (name, args) => execFileSync(process.execPath, ["--no-warnings", path.join(root, "scripts/phone-origin", name), ...args], { env, encoding: "utf8" });

const vitePort = await freePort();
const serve = spawn(process.execPath, ["--no-warnings", path.join(root, "scripts/phone-origin/serve.ts"), "--no-tailscale", "--port", String(vitePort)], { env, stdio: ["ignore", "pipe", "inherit"] });
let serveOut = "";
serve.stdout.on("data", (d) => (serveOut += d));

let mac;
const browser = await chromium.launch();
try {
  const origin = `http://127.0.0.1:${vitePort}`;
  await until(async () => serveOut.includes(origin) && fs.existsSync(path.join(phoneDir, "serve.json")), "phone:serve serves on localhost");
  check(/on this Mac only/.test(serveOut), "without Tailscale it says it's on this Mac only");

  const here = fs.realpathSync(root);
  const started = script("core.ts", []);
  check(started.includes(`now runs ${here}`) && started.includes(`/c/dev → ${home}`), "phone:core runs the phone's dev core from this checkout");

  const { link } = JSON.parse(script("pair.ts", ["dev", "--json"]).trim().split("\n").at(-1));
  check(link.startsWith(`${origin}/pair#`), "phone:pair's link opens at the phone origin");

  mac = await connect(path.join(home, "core.sock"));
  const call = (m, p = {}) => mac.client.call(m, p);
  check((await call("remote.status")).access === "url", "its remote access is on, on its own loopback port");
  const requests = [];
  mac.client.onEvent((e) => e.type === "remote.pairRequest" && requests.push(e.request));
  await call("events.subscribe", { types: ["remote.pairRequest"] });

  const phone = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await phone.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(link);
  await page.getByRole("button", { name: "Pair This Browser" }).click();
  await page.getByText("Approve on your Mac").waitFor();
  await until(async () => requests.length === 1, "the Mac is asked, through the proxy");
  const words = await page.locator(".words span").allInnerTexts();
  check(requests[0].words.join(" ") === words.join(" "), `both screens show the same words (${words.join(" ")})`);
  await call("remote.approve", { requestId: requests[0].requestId, allow: true, scope: "view" });
  await page.locator(".ui-empty").waitFor();
  check(true, "approved: the phone lands on Now");
  await until(async () => (await call("remote.status")).sessions[0]?.ip === "127.0.0.1", "the core sees the address the proxy saw");
  await page.reload();
  await page.locator(".ui-empty").waitFor();
  await until(async () => (await call("remote.status")).sessions.length === 1, "after a reload it's still paired");
  mac.close();
  mac = null;

  // Another checkout: a worktree of HEAD, with this checkout's node_modules.
  execFileSync("git", ["-C", root, "worktree", "add", "--detach", other, "HEAD"], { stdio: "ignore" });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(other, "node_modules"));
  for (const dir of ["packages", "apps"])
    for (const p of fs.readdirSync(path.join(root, dir))) {
      const nm = path.join(root, dir, p, "node_modules");
      if (fs.existsSync(nm) && fs.existsSync(path.join(other, dir, p))) fs.symlinkSync(nm, path.join(other, dir, p, "node_modules"));
    }
  const moved = script("core.ts", [other]);
  const there = fs.realpathSync(other);
  check(moved.includes(`now runs ${there}`) && moved.includes(`was ${here}`), "phone:core restarts it on the other checkout's code");
  mac = await connect(path.join(home, "core.sock"));
  check(fs.realpathSync(mac.hello.root) === there, "the core that answers runs the other checkout");
  const call2 = (m, p = {}) => mac.client.call(m, p);
  await page.reload();
  await page.locator(".ui-empty").waitFor();
  check(!(await page.getByText("Pair with Your Mac").isVisible()) && !(await page.getByText("Approve on your Mac").isVisible()), "a reload asks for no pairing");
  await until(async () => (await call2("remote.status")).sessions.length === 1, "the phone is connected to the restarted core");
  check((await call2("remote.devices")).length === 1, "it still lists the one device");
  console.log("\nphone origin: all checks passed");
} finally {
  await browser.close();
  mac?.close();
  serve.kill("SIGTERM");
  await stopCore(home, { terminals: true });
  dropOther();
}
process.exit(0);
