// The phone driver's long-lived side (`pnpm phone start` runs it in the background):
// the web client on Vite (HMR) on a port it keeps, a core (a scenario's throwaway
// one, or this worktree's own dev core), and an emulated iPhone in a persistent browser profile, so
// the pairing in its IndexedDB survives restarts. Paired with that core already: it
// opens the client. Not: it pairs, approving on the core's socket as the Mac's app
// would. Then it takes commands (shot, tap, type, key, goto, eval, ls, logs) on a
// control port on loopback; cli.ts sends them.
//
// The phone reaches the core as on the phone origin (docs/56-phone-development.md):
// Vite carries scripts/phone-origin's proxy, the core is made reachable on its own
// loopback listener (Your own URL, reachable()), and the client dials /c/dev on
// Vite, which here always means the driver's core. So the client stays on Vite (an
// edit to apps/web is in the next shot) and no core changes its access mode beyond
// what phone:use does. The Vite port is kept in ports.json: IndexedDB is per origin.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { devices, type BrowserContext, type Page } from "playwright";
import type { PaneId } from "../../../packages/protocol/src/model.ts";
import { connect } from "../../../packages/protocol/src/node.ts";
import { rewriteLink } from "../../../scripts/phone-origin/link.ts";
import { phoneHosts, phoneProxy, phoneUpgrades } from "../../../scripts/phone-origin/proxy.ts";
import { coreInfo, devTarget, reachable, type TargetName } from "../../../scripts/phone-origin/targets.ts";
import { parseCore, deviceName, browserName, keyName, isSelector, type CoreChoice } from "./args.ts";
import {
  DEVICES,
  KEYBOARD_HEIGHT,
  browserType,
  connectCore,
  freePort,
  pairRequests,
  portFree,
  startCore,
  startWeb,
  stopCore,
  waitFor,
  webkitTrouble,
  type BrowserName,
  type Connection,
  type DeviceName,
} from "./harness.ts";
import { loadScenario, scenarioContext, seed, type Seeded } from "./scenario.ts";
import { devCoreHome, driverHome, forgetReplaced, readPorts, shotsDir, stateFile, writePorts, type PhoneState } from "./state.ts";

const opts = JSON.parse(process.argv[2] ?? "{}") as { core?: string; browser?: string; device?: string };
const core: CoreChoice = parseCore(opts.core);
const device: DeviceName = deviceName(opts.device ?? "15");
const asked: BrowserName | null = browserName(opts.browser);
const home = driverHome();
fs.mkdirSync(home, { recursive: true });

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
const notes: string[] = [];
// --core dev: this worktree's own core, never the phone's or the main checkout's (devCoreHome).
const devHome = core.kind === "dev" ? devCoreHome() : null;
const coreTarget = devTarget(core.kind === "dev" ? devHome : path.join(home, `scenario-${core.name}`));
const coreHome = coreTarget.home;
const coreLog = path.join(coreHome ? path.join(coreHome, "logs") : path.join(os.homedir(), "Library/Logs/cmd-dev"), "core.log");
/** Which core this is, for the pairings kept per core (state.ts). */
const label = core.kind === "dev" ? `dev:${coreHome}` : `scenario:${core.name}`;

// Failing to start: say why in the log (cli.ts prints it) and leave no scenario core behind.
let failedPage: Page | null = null;
const fatal = async (err: unknown) => {
  log(`failed: ${(err as Error)?.stack ?? err}`);
  // What the phone showed then.
  const shot = path.join(home, "failed.png");
  if (failedPage && (await failedPage.screenshot({ path: shot }).then(() => true, () => false))) log(`the phone's screen then: ${shot}`);
  if (core.kind === "scenario" && coreHome) await stopCore(coreHome, { terminals: true }).catch(() => {});
  process.exit(1);
};
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

// ── the web client, on the port kept from last time, with the phone origin's proxy ──
let ports = readPorts();
if (ports && !(await portFree(ports.web))) {
  notes.push(`Port ${ports.web} is taken now, so the phone moved and pairs again.`);
  ports = null;
}
ports ??= { web: await freePort() };
writePorts(ports);
// /c/dev is the driver's core, whatever phone:use says; /c/release isn't reachable from here.
const proxy = phoneProxy({
  hosts: phoneHosts(ports.web, null),
  info: (t: TargetName) => (t === "dev" ? coreInfo(coreTarget) : Promise.reject(new Error("the phone driver reaches only its own core, at /c/dev"))),
  log: (m) => log(`proxy: ${m}`),
});
const web = await startWeb(ports.web, [
  {
    name: "cmd-phone-proxy",
    configureServer(s: { httpServer: http.Server | null }) {
      s.httpServer?.on("upgrade", phoneUpgrades(proxy, { hmr: true }));
    },
  },
]);
/** Where the client dials, as the pairing link says: /c/dev on Vite. */
const socketUrl = `${web.url.replace(/^http/, "ws")}/c/dev`;
log(`web client ${web.url}, cores at ${socketUrl}`);

// ── the core ──
let conn: Connection;
let seeded: Seeded[] = [];
if (core.kind === "scenario") {
  // Its host key and paired devices stay in its folder across starts (only its terminals are seeded afresh).
  await stopCore(coreHome!, { terminals: true });
  const ctx = await scenarioContext(coreHome!);
  const scenario = await loadScenario(core.name, ctx);
  const zdotdir = path.join(coreHome!, "zsh");
  fs.mkdirSync(zdotdir, { recursive: true });
  fs.writeFileSync(path.join(zdotdir, ".zshrc"), [`path=(${ctx.bin} $path)`, "unset HISTFILE", "PROMPT='%F{blue}%~%f %F{magenta}❯%f '", "RPROMPT=''"].join("\n") + "\n");
  startCore(
    coreHome!,
    {
      // Seeded afresh each start; nothing of the user's touched (hooks, AI calls).
      "restore.terminals": false,
      "agents.hooks.auto": false,
      "agents.names.ai": false,
      "notifications.ai": false,
      "shell.program": "/bin/zsh",
      // The phone's own appearance picks light or dark (shot --theme).
      "theme.appearance": "auto",
      ...scenario.settings,
    },
    { ZDOTDIR: zdotdir, CMD_TRANSCRIPTS_HOME: path.join(coreHome!, "transcripts"), CMD_USAGE_URL: "off" },
  );
  conn = await connectCore(coreHome!);
  log(`scenario ${core.name}: ${scenario.description}`);
  seeded = await seed(conn, scenario, ctx, log);
} else {
  // Running already (pnpm dev, pnpm core, phone:core): used as it is, and never stopped from here.
  let running = await connectSocket(coreTarget.socket, 1500);
  if (!running) {
    // As pnpm core starts it; left running after stop, like that one.
    startCore(coreHome!, null);
    notes.push(`Started this worktree's dev core. It keeps running after pnpm phone stop; CMD_HOME=${coreHome} pnpm core:stop stops it.`);
    running = await connectSocket(coreTarget.socket, 20_000);
    if (!running) throw new Error(`The dev core didn't start. Its log: ${coreLog}`);
  }
  conn = running;
  log(`dev core at ${coreHome}`);
}
const call = conn.client.call.bind(conn.client);
// Its own listener on loopback (Your own URL), as phone:use makes a dev core reachable.
const { info, changed } = await reachable(coreTarget, conn);
if (!info.origin) throw new Error(`The core's remote access isn't ready: ${info.error}`);
if (changed && core.kind === "dev") notes.push(`Turned on the dev core's remote access (Your own URL, 127.0.0.1:${info.port}), as pnpm phone:use does.`);
log(`core listens on 127.0.0.1:${info.port} (${info.origin})`);

async function connectSocket(sock: string, ms: number): Promise<Connection | null> {
  return waitFor(() => connect(sock), `the core at ${sock}`, ms).catch(() => null);
}

// ── the phone ──
const preset = devices[DEVICES[device]]!;
let context: BrowserContext;
let engine: BrowserName = asked ?? "webkit";
const launch = (b: BrowserName) =>
  browserType(b).then((t) => t.launchPersistentContext(path.join(home, "profile", b), { ...preset, colorScheme: "light" }));
try {
  context = await launch(engine);
} catch (err) {
  if (asked) throw err;
  notes.push(`${webkitTrouble(err)}; using Chromium. Pass --browser chromium to skip trying.`);
  engine = "chromium";
  context = await launch(engine);
}
const page: Page = context.pages()[0] ?? (await context.newPage());
failedPage = page;
let scheme: "light" | "dark" = "light";

const consoleLines: string[] = [];
const keep = (line: string) => {
  consoleLines.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (consoleLines.length > 500) consoleLines.shift();
};
page.on("console", (m) => keep(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => keep(`[pageerror] ${e.message}`));
page.on("crash", () => keep("[crash] the page crashed"));

/** This browser's pairings (the web client's IndexedDB store): keyed by the Mac's host key, with the device id and where it dials. */
const pairings = () =>
  page.evaluate(
    () =>
      new Promise<{ key: string; deviceId: string; socket: string }[]>((resolve, reject) => {
        const req = indexedDB.open("cmd-remote", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("identity");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const store = db.transaction("identity", "readonly").objectStore("identity");
          const keys = store.getAllKeys();
          const vals = store.getAll();
          vals.onsuccess = () => {
            db.close();
            resolve(keys.result.map((k, i) => ({ key: String(k), deviceId: vals.result[i]?.deviceId ?? "", socket: vals.result[i]?.socket ?? vals.result[i]?.relay ?? "" })));
          };
        };
      }),
  );
const forget = (keys: string[]) =>
  page.evaluate(
    (keys) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("cmd-remote", 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction("identity", "readwrite");
          for (const k of keys) tx.objectStore("identity").delete(k);
          tx.oncomplete = () => (req.result.close(), resolve());
          tx.onerror = () => reject(tx.error);
        };
      }),
    keys,
  );
const onNow = () => page.locator("header.bar h1", { hasText: "Now" }).waitFor({ timeout: 20_000 });

// The pairings are read and dropped on a page of the origin that doesn't run the app
// (it would write the one it opens back, with its last use).
const offApp = `${web.url}/favicon.svg`;
await page.goto(offApp);
// Pairings this profile can't use: another address (the driver only dials /c/dev here).
const elsewhere = (await pairings()).filter((p) => p.socket !== socketUrl).map((p) => p.key);
if (elsewhere.length) (await forget(elsewhere), log(`pairing: forgot ${elsewhere.length} for other addresses`));
const known = await call("remote.devices", {});
let mine = (await pairings()).find((p) => known.some((d) => d.id === p.deviceId));
let pairing: PhoneState["pairing"];
if (mine) {
  pairing = "kept";
  const d = known.find((k) => k.id === mine!.deviceId)!;
  log(`pairing: kept, no pairing ran (device ${d.id}, paired ${new Date(d.pairedAt).toISOString()})`);
} else {
  pairing = "new";
  const requests = await pairRequests(conn);
  const { url } = await call("remote.pair", { scope: "control" });
  // As phone:pair does: the page opens on Vite and dials /c/dev there.
  await page.goto(rewriteLink(url, web.url, "dev"));
  await page.getByRole("button", { name: "Pair This Browser" }).click({ timeout: 20_000 });
  const request = await requests.next(20_000);
  await call("remote.approve", { requestId: request.requestId, allow: true, scope: "control" });
  await onNow();
  // This core's: the profile may hold pairings with other cores (another --core).
  mine = await waitFor(async () => {
    const ids = (await call("remote.devices", {})).map((d) => d.id);
    return (await pairings()).find((p) => ids.includes(p.deviceId));
  }, "the pairing to be saved");
  log(`pairing: paired this browser now (device ${mine.deviceId}, words ${request.words.join(" ")})`);
  // The device this browser's profile paired with this core before (the profile was lost) goes, so they don't pile up there either.
  const before = forgetReplaced(`${label}/${engine}`, mine.deviceId, path.join(home, "devices.json"));
  if (before && (await call("remote.devices", {})).some((d) => d.id === before)) await call("remote.revoke", { id: before });
}
const mac = mine.key;
// The pairing this core had before, under another host key (its folder was deleted): gone, so they don't pile up.
const stale = forgetReplaced(label, mac);
if (stale) {
  await page.goto(offApp);
  await forget([stale]);
  log("pairing: forgot this core's earlier one");
}
await page.goto(`${web.url}/?mac=${encodeURIComponent(mac)}`);
await onNow();

// ── commands ──
type Flags = Record<string, string | true>;
type Handler = (args: string[], flags: Flags) => Promise<string>;

const view = () => page.evaluate(() => (document.querySelector(".term-screen") ? "terminal" : document.querySelector("header.bar h1")?.textContent === "Now" ? "now" : "screen"));

/** Fonts in, finite animations done (spinners aside), two frames drawn. */
const settle = () =>
  page.evaluate(async () => {
    await document.fonts.ready;
    const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.race([Promise.all(finite.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 1500))]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // A terminal refits to a new size through the Mac (its program redraws): until its rows hold still for 300 ms, at most 3 s.
    const rows = document.querySelector(".term .xterm-rows");
    if (!rows) return;
    const look = () => `${rows.childElementCount}:${(rows as HTMLElement).innerText}`;
    let last = look();
    for (let still = 0, t = 0; still < 300 && t < 3000; t += 100) {
      await new Promise((r) => setTimeout(r, 100));
      const now = look();
      still = now === last ? still + 100 : 0;
      last = now;
    }
  });

/**
 * The on-screen keyboard as the page sees it: iOS shrinks the visual viewport (not
 * the layout one) and main.tsx sizes the app to it. A drawn keyboard covers the rest.
 */
const keyboard = (height: number, dark: boolean) =>
  page.evaluate(
    ({ height, dark }) => {
      const vv = window.visualViewport!;
      const full = window.innerHeight;
      Object.defineProperty(vv, "height", { configurable: true, get: () => full - height });
      vv.dispatchEvent(new Event("resize"));
      const kb = document.createElement("div");
      kb.id = "phone-keyboard";
      const bg = dark ? "#2b2b2d" : "#d1d4d9";
      const key = dark ? "#68686b" : "#fff";
      const ink = dark ? "#fff" : "#000";
      kb.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${height}px;background:${bg};z-index:2147483647;display:flex;flex-direction:column;gap:11px;padding:44px 3px 8px;box-sizing:border-box;font:22px -apple-system,system-ui,sans-serif;color:${ink}`;
      for (const row of ["qwertyuiop", "asdfghjkl", "⇧zxcvbnm⌫", ["123", "space", "return"]]) {
        const r = document.createElement("div");
        r.style.cssText = "display:flex;gap:6px;justify-content:center;flex:1";
        for (const label of typeof row === "string" ? [...row] : row) {
          const k = document.createElement("div");
          k.textContent = label;
          const wide = label === "space" ? 5 : label.length > 1 ? 2 : 1;
          k.style.cssText = `flex:${wide} 1 0;max-width:${wide * 34}px;border-radius:5px;background:${key};display:flex;align-items:center;justify-content:center;font-size:${label.length > 1 ? 15 : 22}px;box-shadow:0 1px 0 rgba(0,0,0,.3)`;
          r.append(k);
        }
        kb.append(r);
      }
      document.body.append(kb);
    },
    { height, dark },
  );
const noKeyboard = () =>
  page.evaluate(() => {
    const vv = window.visualViewport! as unknown as Record<string, unknown>;
    delete vv.height;
    window.visualViewport!.dispatchEvent(new Event("resize"));
    document.getElementById("phone-keyboard")?.remove();
  });

const shot: Handler = async (_args, flags) => {
  const on = typeof flags.device === "string" ? deviceName(flags.device) : device;
  const themes: ("light" | "dark")[] = flags.theme === "all" ? ["light", "dark"] : flags.theme === "dark" || flags.theme === "light" ? [flags.theme] : [scheme];
  const dir = typeof flags.out === "string" ? path.resolve(flags.out) : shotsDir;
  fs.mkdirSync(dir, { recursive: true });
  const before = page.viewportSize();
  const was = scheme;
  const files: string[] = [];
  try {
    if (on !== device) await page.setViewportSize(devices[DEVICES[on]]!.viewport);
    for (const t of themes) {
      await page.emulateMedia({ colorScheme: t });
      scheme = t;
      if (flags.keyboard) await keyboard(KEYBOARD_HEIGHT[on], t === "dark");
      await settle();
      const file = path.join(dir, `phone-${await view()}-${on}-${t}${flags.keyboard ? "-keyboard" : ""}.png`);
      await page.screenshot({ path: file });
      files.push(file);
      if (flags.keyboard) await noKeyboard();
    }
  } finally {
    if (on !== device && before) await page.setViewportSize(before);
    if (flags.theme === "all") {
      await page.emulateMedia({ colorScheme: was });
      scheme = was;
    }
  }
  return files.join("\n");
};

/** A button, row or field: by selector, else by its role's name, else by its text. */
const target = (what: string) => (isSelector(what) ? page.locator(what) : page.getByRole("button", { name: what }).or(page.getByText(what))).first();

const tap: Handler = async ([what]) => {
  const el = target(what!);
  await el.waitFor({ state: "visible", timeout: 5000 }).catch(() => {
    throw new Error(`Nothing to tap that matches “${what}” on screen.`);
  });
  await el.tap({ timeout: 5000 });
  await settle();
  return `tapped ${what}`;
};

/** Typing goes to the focused field; with none, to the terminal on screen (as its keyboard button does); else nowhere (`quiet`: to the page). */
async function focusForTyping(quiet = false) {
  const focused = await page.evaluate(() => !!document.activeElement?.matches("input, textarea, [contenteditable=true]"));
  if (focused) return;
  const term = page.locator(".term textarea.xterm-helper-textarea");
  if (await term.count()) return term.focus();
  if (quiet) return;
  throw new Error("Nothing to type into. Tap a field first, or goto a terminal.");
}

const type: Handler = async (args) => {
  await focusForTyping();
  const text = args.join(" ");
  await page.keyboard.type(text);
  return `typed ${JSON.stringify(text)}`;
};

const key: Handler = async ([name]) => {
  const k = keyName(name!);
  await focusForTyping(true);
  await page.keyboard.press(k);
  await settle();
  return `pressed ${k}`;
};

/** A terminal by id (or its start), the name the scenario gave it, its title or its agent's name. */
async function findPane(what: string): Promise<{ id: PaneId; title: string }> {
  const [panes, agents] = await Promise.all([call("pane.list", {}), call("agent.list", {})]);
  const q = what.toLowerCase();
  const byId = panes.filter((p) => p.id.startsWith(what));
  if (byId.length === 1) return byId[0]!;
  const named = seeded.filter((s) => s.name.toLowerCase() === q).map((s) => panes.find((p) => p.id === s.paneId)).filter((p) => !!p);
  if (named.length === 1) return named[0]!;
  const nameOf = (id: PaneId) => agents.find((a) => a.paneId === id)?.name ?? "";
  const hits = panes.filter((p) => p.title.toLowerCase().includes(q) || nameOf(p.id).toLowerCase().includes(q) || seeded.some((s) => s.paneId === p.id && s.name.toLowerCase().includes(q)));
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) throw new Error(`No terminal matches “${what}”. ls lists them.`);
  throw new Error(`“${what}” matches ${hits.length} terminals: ${hits.map((p) => `${p.id.slice(0, 8)} ${p.title}`).join(", ")}. Use more of its id.`);
}

const goto: Handler = async ([what]) => {
  if (what === "now") {
    await page.goto(`${web.url}/?mac=${encodeURIComponent(mac)}`);
    await onNow();
    return "on Now";
  }
  const pane = await findPane(what!);
  // As a notification opens it: the Mac and the terminal in the address.
  await page.goto(`${web.url}/?mac=${encodeURIComponent(mac)}&pane=${encodeURIComponent(pane.id)}`);
  await page.locator(".term .xterm-rows").waitFor({ timeout: 20_000 });
  await settle();
  return `on ${pane.id.slice(0, 8)} ${pane.title}`;
};

const evaluate: Handler = async (args) => {
  const code = args.join(" ");
  const result = await page.evaluate(`(async () => { ${/\breturn\b|;/.test(code) ? code : `return (${code})`} })()`);
  return JSON.stringify(result, null, 2) ?? "undefined";
};

const ls: Handler = async () => {
  const [panes, agents, workspaces] = await Promise.all([call("pane.list", {}), call("agent.list", {}), call("workspace.list", {})]);
  const rows = panes.map((p) => {
    const a = agents.find((x) => x.paneId === p.id);
    const w = workspaces.find((x) => x.id === p.workspaceId)?.name ?? "";
    const named = seeded.find((s) => s.paneId === p.id)?.name;
    return [p.id.slice(0, 8), w, p.title || p.foreground, a ? `${a.kind} · ${a.state}` : "", named ? `(${named})` : ""];
  });
  const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => (i < 4 ? c.padEnd(widths[i]!) : c)).join("  ").trimEnd()).join("\n") || "No terminals.";
};

const logs: Handler = async (_args, flags) => {
  const n = Number(flags.lines ?? 40);
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(coreLog, "utf8").trimEnd().split("\n").slice(-n);
  } catch {}
  return [`Browser (${engine}):`, ...(consoleLines.slice(-n).length ? consoleLines.slice(-n) : ["  nothing yet"]), "", `Core (${coreLog}):`, ...lines].join("\n");
};

const handlers: Record<string, Handler> = { shot, tap, type, key, goto, eval: evaluate, ls, logs };

// One command at a time, in order.
let queue: Promise<unknown> = Promise.resolve();
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    queue = queue.then(async () => {
      let reply: { ok: boolean; out: string };
      try {
        const { command, args, flags } = JSON.parse(body) as { command: string; args: string[]; flags: Flags };
        const h = handlers[command];
        if (!h) throw new Error(`The phone doesn't know “${command}”.`);
        reply = { ok: true, out: await h(args, flags) };
      } catch (err) {
        reply = { ok: false, out: (err as Error).message };
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const control = (server.address() as { port: number }).port;

const state: PhoneState & { notes: string[] } = {
  pid: process.pid,
  control,
  ready: true,
  web: web.url,
  socket: socketUrl,
  core: core.kind === "dev" ? { kind: "dev", home: coreHome } : { kind: "scenario", name: core.name, home: coreHome },
  browser: engine,
  device,
  pairing,
  deviceId: mine.deviceId,
  notes,
};
fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
for (const n of notes) log(`note: ${n}`);
log(`ready: control port ${control}`);

let quitting = false;
async function quit() {
  if (quitting) return;
  quitting = true;
  log("stopping");
  server.close();
  // Closing the context writes the profile (the pairing) out.
  await context.close().catch(() => {});
  conn.close();
  await web.close().catch(() => {});
  if (core.kind === "scenario" && coreHome) await stopCore(coreHome, { terminals: true });
  try {
    if ((JSON.parse(fs.readFileSync(stateFile(), "utf8")) as PhoneState).pid === process.pid) fs.rmSync(stateFile(), { force: true });
  } catch {}
  log("stopped");
  process.exit(0);
}
// Vite's server exits on SIGTERM by itself, before the browser, the core and state.json are cleaned up: ours instead.
process.removeAllListeners("SIGTERM");
process.removeAllListeners("SIGINT");
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
context.on("close", () => void quit());
