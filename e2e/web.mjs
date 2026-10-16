// The phone's side of remote access (docs/13-remote-access.md): the web client
// (apps/web, Vite dev server) in an emulated iPhone (WebKit), a local relay and a core on
// a throwaway CMD_HOME; the Mac's approval comes over the core's socket, as
// `cmd remote pair` does. Opens the pairing link in a browser tab (iOS asks to
// pair from the Home Screen app, and pairs only when told to), opens a terminal
// from Now, types from the key row and the compose bar, checks the text reached
// the PTY, that opening it leaves the Mac's size alone and Fit to This Phone sizes
// it for the phone while it shows it,
// shows the Mac's notifications as toasts that open their terminal (push itself
// needs a real push service: core tests, and a phone by hand), pairs a second
// Mac (a second core) from a pasted link and switches between
// them (direct: the link opens at that Mac's own address), then has the first
// Mac unpair it. Screenshots in .cmd-dev/shots/web-*.png. `pnpm e2e:web`;
// E2E_HOSTED=1 runs it against the deployed relay and client instead;
// E2E_DIRECT=1 has the core serve the built client and take the phone's socket
// itself (docs/38, "Your own URL" on loopback, which browsers treat as secure).
// E2E_BROWSER=chromium emulates the iPhone in Chromium (WebKit can't start in the
// Agent Safehouse sandbox); WebKit is the real check.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, devices, webkit } from "playwright";
import { stopCore } from "../scripts/stop-core.mjs";
import { connect } from "../packages/protocol/src/node.ts";
// Shared with the phone driver (pnpm phone): Vite, relay, cores, ports.
import { directSettings, freePort, relaySettings, root, startCore as startCoreWith, startRelay, startWeb } from "../tools/phone/src/harness.ts";
const home = path.join(root, ".cmd-dev", "e2e-web");
// The second Mac: another core, so another host key and route.
const home2 = path.join(root, ".cmd-dev", "e2e-web-2");
const shots = path.join(root, ".cmd-dev", "shots");
for (const h of [home, home2]) {
  await stopCore(h, { terminals: true });
  fs.rmSync(h, { recursive: true, force: true });
  fs.mkdirSync(h, { recursive: true });
}
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
const direct = !hosted && !!process.env.E2E_DIRECT;
const port = direct ? await freePort() : 0;
const port2 = direct ? await freePort() : 0;
// Direct: the client as it ships, so build it (Vite is quick).
if (direct) execFileSync(process.execPath, [path.join(root, "scripts/build-web.mjs")], { stdio: "ignore" });
const relay = hosted || direct ? null : await startRelay({ log: () => {} });
const web = hosted || direct ? null : await startWeb();
const client = hosted ? "https://cmd.endtime-instruments.org" : direct ? `http://127.0.0.1:${port}` : web.url;
const settingsFor = (p) => (hosted ? { "remote.enabled": true } : direct ? directSettings(p) : relaySettings(relay.url, client));
const startCore = (h, p) => startCoreWith(h, settingsFor(p));
startCore(home, port);
startCore(home2, port2);

let mac, mac2;
// WebKit, as on an iPhone: it differs where it matters (an X25519 CryptoKey in IndexedDB reads back as null).
const browser = await (process.env.E2E_BROWSER === "chromium" ? chromium : webkit).launch();
try {
  const sock = path.join(home, "core.sock");
  await until(async () => fs.existsSync(sock), "the core starts");
  mac = await connect(sock);
  const call = (m, p = {}) => mac.client.call(m, p);
  await until(async () => (await call("remote.status")).state === "online", direct ? "the core listens" : "the core reaches the relay");
  const requests = [];
  mac.client.onEvent((e) => e.type === "remote.pairRequest" && requests.push(e.request));
  await call("events.subscribe", { types: ["remote.pairRequest"] });

  const phone = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await phone.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  const shot = (name) => page.screenshot({ path: path.join(shots, `web${direct ? "-direct" : ""}-${name}.png`) });

  await page.goto(client);
  await page.getByText("Pair with Your Mac").waitFor();
  await page.getByRole("button", { name: "Scan Code" }).waitFor();
  check(true, "an unpaired browser says how to pair");

  // A link never pairs on load: it asks, and on iOS says how to pair the Home Screen app instead.
  const { url } = await call("remote.pair", { scope: "control" });
  await page.goto(url);
  await page.getByText("Where do you want to use cmd?").waitFor();
  check(!page.url().includes("#"), "the one-time key leaves the address bar at once");
  check(requests.length === 0 && (await call("remote.status")).requests.length === 0, "a pairing link asks before pairing");
  check(await page.getByText("Add to Home Screen").isVisible(), "on iOS it says how to pair from the Home Screen");
  await shot("0-link");
  // The code is still good: pairing starts only now.
  await page.getByRole("button", { name: "Pair This Browser" }).click();
  await page.getByText("Approve on your Mac").waitFor();
  const words = await page.locator(".words span").allInnerTexts();
  await until(async () => requests.length === 1, "the Mac is asked");
  check(requests[0].words.join(" ") === words.join(" "), `both screens show the same words (${words.join(" ")})`);
  check(/iPhone/.test(requests[0].name), `the Mac sees the device's name (${requests[0].name})`);
  await shot("1-approve");
  await call("remote.approve", { requestId: requests[0].requestId, allow: true, scope: "control" });
  await page.locator(".ui-empty").waitFor();
  check(true, "approved: the phone lands on Now");

  const pane = await call("pane.create", {});
  await page.locator(".now .ui-list-row").first().waitFor();
  check(true, "a new terminal shows up in Now");
  await page.locator(".now .ui-list-row").first().click();
  await page.locator(".term .xterm-rows").waitFor();
  await until(async () => (await call("remote.status")).sessions[0]?.watching.includes(pane.id), "opening it follows it on the Mac");
  // Opening it leaves the Mac's terminal at its size: the phone shows it scaled, and the page itself doesn't scroll.
  const opened = (await call("pane.list")).find((p) => p.id === pane.id);
  // Its snapshot is drawn: the old client fitted the Mac's terminal by then.
  await until(async () => (await page.locator(".term .xterm-rows").innerText()).trim().length > 0, "the terminal shows the Mac's screen");
  const kept = (await call("pane.list")).find((p) => p.id === pane.id);
  check(kept.sizedBy === null && kept.cols === opened.cols && kept.rows === opened.rows, `opening it keeps the Mac's size (${kept.cols}×${kept.rows})`);
  check(await page.evaluate(() => document.scrollingElement.scrollHeight <= innerHeight + 1), "the page doesn't scroll, only the terminal");
  // The keyboard opening on a fresh shell: its prompt (the top row) stays in view, not the blank rows under it.
  const full = page.viewportSize();
  const tall = await page.evaluate(() => document.querySelector(".term-view").clientHeight);
  await page.setViewportSize({ width: full.width, height: full.height - 300 });
  await until(
    () =>
      page.evaluate((tall) => {
        const v = document.querySelector(".term-view").getBoundingClientRect();
        const r = document.querySelector(".term .xterm-rows > div").getBoundingClientRect();
        return v.height < tall - 200 && r.top >= v.top - 1 && r.bottom <= v.bottom + 1;
      }, tall),
    "with the keyboard up, a fresh shell's prompt stays in view",
  );
  await page.setViewportSize(full);
  // Fit to This Phone (the menu): the Mac's terminal takes the phone's size.
  await page.getByRole("button", { name: "More" }).click();
  await page.getByText("Fit to This Phone").click();
  await until(async () => /iPhone/.test((await call("pane.list")).find((p) => p.id === pane.id).sizedBy ?? ""), "Fit to This Phone sizes the Mac's terminal for the phone");
  const fitted = (await call("pane.list")).find((p) => p.id === pane.id);
  check(fitted.cols < 70 && fitted.rows > 10, `it fits the phone (${fitted.cols}×${fitted.rows})`);
  // Less room (the keyboard opening): fewer rows.
  const vp = page.viewportSize();
  await page.setViewportSize({ width: vp.width, height: vp.height - 300 });
  await until(async () => (await call("pane.list")).find((p) => p.id === pane.id).rows < fitted.rows, "a smaller viewport (keyboard) refits the rows");
  await page.setViewportSize(vp);
  await until(async () => (await call("pane.list")).find((p) => p.id === pane.id).rows === fitted.rows, "the keyboard closing refits it again");
  await page.locator(".compose input").fill("echo phone-was-here");
  await page.locator(".compose").getByRole("button", { name: "Send", exact: true }).click();
  await until(async () => (await call("pane.read", { paneId: pane.id })).text.includes("phone-was-here\n"), "the compose bar types into the terminal");
  await until(async () => (await page.locator(".term").innerText()).includes("phone-was-here"), "the output comes back to the phone");
  await page.getByRole("button", { name: "^C" }).click();
  await shot("3-terminal");

  // Back to Now: the Mac gets its size back.
  await page.getByRole("button", { name: "Back to Now" }).click();
  await until(async () => (await call("pane.list")).find((p) => p.id === pane.id).sizedBy === null, "leaving the terminal gives the Mac its size back");

  // A reload (iOS reloads a background tab or the Home Screen app on its own) lands on the terminal that was open.
  await page.locator(".now .ui-list-row").first().click();
  await page.locator(".term .xterm-rows").waitFor();
  check(new URL(page.url()).searchParams.get("pane") === pane.id, "the open terminal is in the address");
  await page.reload();
  await page.locator(".term .xterm-rows").waitFor();
  await until(async () => (await page.locator(".term").innerText()).includes("phone-was-here"), "a reload lands on the same terminal");
  await page.getByRole("button", { name: "Back to Now" }).click();
  check(new URL(page.url()).search === "", "back on Now, the address is plain again");

  // The phone starts a terminal of its own, in Now's bottom bar, and lands in it.
  const before = (await call("pane.list")).length;
  await page.locator(".actions").getByRole("button", { name: "Terminal" }).click();
  await page.locator(".term .xterm-rows").waitFor();
  await until(async () => (await call("pane.list")).length === before + 1, "the phone starts a terminal on the Mac");
  await page.getByRole("button", { name: "Back to Now" }).click();
  // Settings: which Mac, what access, forget.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("dialog").getByText("Control: can type and change files").waitFor();
  check(true, "Settings says what this device may do");
  // An iOS tab gets no push (only the Home Screen app does): Settings says so, Now doesn't ask.
  await page.getByRole("dialog").getByText("Add cmd to your Home Screen first").waitFor();
  check(!(await page.getByText("Get notified on this device").isVisible()), "in an iOS tab, notifications wait for the Home Screen app");
  await page.waitForTimeout(300); // the sheet's rise (fixed-wait: a screenshot of it in place)
  await shot("2b-settings");
  await page.keyboard.press("Escape");

  // A busy Mac: two workspaces, Claude sessions waiting, working and done (the hook
  // events Claude Code sends), and a shell. Now sorts them; the chips filter.
  const workspace = async (name) => {
    fs.mkdirSync(path.join(home, "work", name), { recursive: true });
    return (await call("workspace.open", { path: path.join(home, "work", name) })).workspace;
  };
  const [api, site] = [await workspace("api"), await workspace("site")];
  // A stand-in Claude: a process really named claude (node, sleeping) that sets its
  // title, so the core detects it as Claude does; then the hook events it would send.
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, "claude"));
  const claude = async (sp, title, events) => {
    const command = `printf '\\033]0;${title}\\007'; clear; exec ${bin}/claude -e 'setInterval(() => {}, 1e9)'`;
    const p = await call("pane.create", { workspaceId: sp.id, command });
    await until(async () => (await call("agent.list")).some((a) => a.paneId === p.id), `the core detects Claude in “${title}”`);
    for (const [event, payload] of events) await call("hook.ingest", { paneId: p.id, agent: "claude", event, payload });
    return p;
  };
  const waiting = await claude(api, "Webhook retries", [
    ["UserPromptSubmit", { prompt: "add retries with backoff to the webhook sender" }],
    ["PermissionRequest", { tool_name: "Bash", message: "Allow Bash: pnpm test --filter api?" }],
  ]);
  await claude(site, "Pricing page", [
    ["UserPromptSubmit", { prompt: "make the pricing table responsive" }],
    ["PreToolUse", { tool_name: "Edit", tool_input: { file_path: path.join(home, "work/site/src/Pricing.tsx") } }],
  ]);
  await claude(api, "Rate limiter", [
    ["UserPromptSubmit", { prompt: "rate limit the public endpoints" }],
    ["Stop", { last_assistant_message: "Added a token-bucket limiter to /v1/*; 42 tests pass." }],
  ]);
  await page.locator('.ui-list-row[data-group="needs"]').waitFor();
  check(/^needs you/i.test((await page.locator(".ui-list-heading-title").allInnerTexts())[0] ?? ""), "Now puts what needs you first");
  await shot("2-now");

  // The Mac's theme: its picks (not the rest of its settings), live; Auto follows the phone.
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const themeBg = { "pastel-dark": "rgb(10, 11, 12)", nord: "rgb(39, 44, 54)", "github-light": "rgb(246, 248, 250)" }; // themes/*.ts: colors.bg
  await call("settings.set", { key: "theme.appearance", value: "dark" });
  await until(async () => (await bg()) === themeBg["pastel-dark"], "the phone draws in the Mac's dark theme");
  await call("settings.set", { key: "theme.dark", value: "nord" });
  await until(async () => (await bg()) === themeBg.nord, "a new theme on the Mac reaches the phone at once");
  await shot("2d-now-dark");
  await call("settings.set", { key: "theme.appearance", value: "auto" });
  await call("settings.set", { key: "theme.light", value: "github-light" });
  await page.emulateMedia({ colorScheme: "light" });
  await until(async () => (await bg()) === themeBg["github-light"], "Auto: a light phone gets the Mac's light theme");
  await page.emulateMedia({ colorScheme: "dark" });
  await until(async () => (await bg()) === themeBg.nord, "Auto: a dark phone gets the Mac's dark theme");
  await page.emulateMedia({ colorScheme: "light" });

  await page.locator(".filters .ui-button", { hasText: "site" }).click();
  // Its title, or the name cmd gives the session from its prompt ("Pricing table") once it has one.
  await page.locator(".now .ui-list-row", { hasText: "Pricing" }).waitFor();
  check((await page.locator(".now .ui-list-row").count()) === 1, "a workspace chip filters Now");
  await shot("2c-workspace");
  await page.locator(".filters .ui-button", { hasText: "All" }).click();
  await page.locator(".actions").getByRole("button", { name: "Next" }).click();
  await page.locator(".term-state", { hasText: "Needs you" }).waitFor();
  check(true, "Next opens the oldest thing that needs you");
  await shot("3b-agent");
  await page.getByRole("button", { name: "Back to Now" }).click();

  // The Mac's notifications while the client is open: a toast that opens its terminal.
  await call("notify.send", { paneId: waiting.id, title: "api · needs you", body: "Allow “pnpm test”?" });
  const toastEl = page.locator(".ui-toast", { hasText: "api · needs you" });
  await toastEl.waitFor();
  check(true, "a notification on the Mac shows as a toast");
  await toastEl.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  await shot("2e-toast");
  await toastEl.getByRole("button", { name: "Open" }).click();
  await page.locator(".term-state", { hasText: "Needs you" }).waitFor();
  check(true, "its Open button opens the terminal");
  // Nothing about the terminal on screen: it's already in front of you.
  await call("notify.send", { paneId: waiting.id, title: "api · bell", body: "Bell" });
  await call("notify.send", { title: "Build", body: "Done in 4 min" });
  await page.locator(".ui-toast", { hasText: "Build" }).waitFor();
  check(!(await page.locator(".ui-toast", { hasText: "api · bell" }).isVisible()), "no toast about the terminal on screen");
  await page.getByRole("button", { name: "Back to Now" }).click();

  // The phone comes back after a reload: it remembers the Mac, no pairing.
  await page.reload();
  await page.locator(".now .ui-list-row").first().waitFor();
  check(true, "a reload reconnects without pairing again");

  // A second Mac, from its link pasted into Add a Mac: no terminals there, so Now is empty.
  const sock2 = path.join(home2, "core.sock");
  await until(async () => fs.existsSync(sock2), "the second Mac's core starts");
  mac2 = await connect(sock2);
  const call2 = (m, p = {}) => mac2.client.call(m, p);
  await until(async () => (await call2("remote.status")).state === "online", "the second Mac is ready");
  const requests2 = [];
  mac2.client.onEvent((e) => e.type === "remote.pairRequest" && requests2.push(e.request));
  await call2("events.subscribe", { types: ["remote.pairRequest"] });
  const { url: url2 } = await call2("remote.pair", { scope: "view" });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("dialog").locator(".ui-list-row", { hasText: "Add a Mac" }).click();
  await page.getByText("Add a Mac").first().waitFor();
  await page.getByRole("button", { name: "Paste Link" }).click();
  await page.getByLabel("Pairing link").fill("https://example.com/not-a-code");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await page.getByText("That isn't a cmd pairing link.").waitFor();
  check(true, "a pasted link that isn't cmd's says so");
  await page.getByLabel("Pairing link").fill(url2);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  if (direct) {
    // Direct: the second Mac serves its own client and takes sockets only from it, so the code opens there.
    await page.getByText("This code is for cmd at").waitFor();
    check(requests2.length === 0, "a code for another Mac's address says so instead of pairing here");
    await page.getByRole("button", { name: "Open There" }).click();
    await page.getByRole("button", { name: "Pair This Browser" }).click();
  }
  await page.getByText("Approve on your Mac").waitFor();
  await until(async () => requests2.length === 1, "the second Mac is asked");
  await call2("remote.approve", { requestId: requests2[0].requestId, allow: true, scope: "view" });
  await page.locator(".now .ui-empty").waitFor();
  check((await page.locator(".now .ui-list-row").count()) === 0, "a pasted link pairs a second Mac and switches to it");
  await page.reload();
  await page.locator(".now .ui-empty").waitFor();
  check((await page.locator(".now .ui-list-row").count()) === 0, "a reload opens the Mac used last");
  if (direct) {
    // Each address keeps its own pairings: back to the first Mac's.
    await page.goto(client);
    await page.locator(".now .ui-list-row").first().waitFor();
    check(true, "the first Mac's address still opens the first Mac");
  } else {
    await page.getByRole("button", { name: "Settings" }).click();
    await until(async () => (await page.locator(".macs .ui-list-row.sel").count()) === 1 && (await page.locator(".macs .ui-list-row").count()) === 3, "Settings lists both Macs, this one ticked");
    await shot("5-macs");
    await page.locator(".macs .ui-list-row:not(.sel)").first().click();
    await page.locator(".now .ui-list-row").first().waitFor();
    check(true, "switching Macs in Settings opens the other");
  }

  const [device] = await call("remote.devices");
  await call("remote.revoke", { id: device.id });
  await page.reload();
  await page.getByText("Not paired anymore").waitFor();
  check(true, "an unpaired phone says so");
  await shot("4-revoked");
  await page.getByRole("button", { name: "Forget This Mac" }).click();
  if (direct) {
    await page.getByText("Pair with Your Mac").waitFor();
    check(true, "forgetting the only Mac at this address asks to pair again");
  } else {
    await page.locator(".now .ui-empty").waitFor();
    check((await page.locator(".now .ui-list-row").count()) === 0, "forgetting it opens the other Mac");
  }
  console.log(`screenshots: ${shots}/web${direct ? "-direct" : ""}-*.png`);
} catch (err) {
  console.log(err.message);
  process.exitCode = 1;
} finally {
  mac?.close();
  mac2?.close();
  await browser.close();
  await web?.close();
  await stopCore(home, { terminals: true });
  await stopCore(home2, { terminals: true });
  await relay?.close();
}
process.exit(process.exitCode ?? 0);
