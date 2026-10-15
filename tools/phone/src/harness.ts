// What the phone's harnesses share (e2e/web.mjs, the phone driver): the web client
// on Vite, a core on a throwaway CMD_HOME with remote access on, the Mac's side of
// pairing over the core's socket (as `cmd remote pair` does), the iPhones we
// emulate and a browser to emulate them in. Runs on Node directly, like the tools.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { BrowserType } from "playwright";
import type { RemotePairRequest } from "../../../packages/protocol/src/model.ts";
import { connect, type Connection } from "../../../packages/protocol/src/node.ts";

export { startRelay, type Relay } from "../../../apps/relay/src/relay.ts";
export type { Connection };

export const root = path.resolve(import.meta.dirname, "../../..");

/** The phones we emulate: a short name → Playwright's device preset. */
export const DEVICES = { se: "iPhone SE (3rd gen)", "15": "iPhone 15", promax: "iPhone 15 Pro Max" } as const;
export type DeviceName = keyof typeof DEVICES;

/** The on-screen keyboard's height in points, suggestions bar included (iOS 17, portrait). */
export const KEYBOARD_HEIGHT: Record<DeviceName, number> = { se: 260, "15": 336, promax: 346 };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A port nobody listens on right now. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

/** Whether `port` on loopback is free to listen on. */
export const portFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.createServer().listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    s.on("error", () => resolve(false));
  });

/** Until fn() is truthy (errors count as no), or throw after `ms` saying what didn't happen. */
export async function waitFor<T>(fn: () => Promise<T> | T, what: string, ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve()
      .then(fn)
      .catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(150);
  }
}

export interface Web {
  url: string;
  close(): Promise<void>;
}

/** apps/web on Vite's dev server (HMR), on `port` (0: any; else exactly that one, or it throws). */
export async function startWeb(port = 0): Promise<Web> {
  // vite is apps/web's dependency, not the root's.
  const vite = await import(pathToFileURL(path.join(root, "apps/web/node_modules/vite/dist/node/index.js")).href);
  const server = await vite.createServer({
    root: path.join(root, "apps/web"),
    configFile: path.join(root, "apps/web/vite.config.ts"),
    server: { port, strictPort: port !== 0, host: "localhost" },
    logLevel: "error",
  });
  await server.listen();
  return { url: (server.resolvedUrls.local[0] as string).replace(/\/$/, ""), close: () => server.close() };
}

/** A core's remote settings for a local relay and web client. */
export const relaySettings = (relay: string, client: string) => ({ "remote.enabled": true, "remote.relay": relay, "remote.client": client });
/** … for the core's own listener on loopback (docs/38, "Your own URL"), serving the built client. */
export const directSettings = (port: number) => ({ "remote.enabled": true, "remote.access": "url", "remote.url": `http://127.0.0.1:${port}`, "remote.port": port });

/** Start a detached core on `home` with these settings (written to its settings.json; null: keep the ones it has). */
export function startCore(home: string, settings: Record<string, unknown> | null, env: Record<string, string> = {}): void {
  fs.mkdirSync(home, { recursive: true });
  if (settings) fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify(settings, null, 2));
  const child = spawn(process.execPath, ["--no-warnings", path.join(root, "packages/core/src/main.ts"), "--instance=dev"], {
    env: { ...process.env, CMD_HOME: home, ...env },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

/** Connect to the core on `home`, waiting for it to listen. */
export async function connectCore(home: string, ms = 20_000): Promise<Connection> {
  const sock = path.join(home, "core.sock");
  return waitFor(() => (fs.existsSync(sock) ? connect(sock) : null), `the core at ${home}`, ms);
}

/** Pairing requests to the core, as the Mac's app hears them. */
export async function pairRequests(conn: Connection): Promise<{ list: RemotePairRequest[]; next(ms?: number): Promise<RemotePairRequest> }> {
  const list: RemotePairRequest[] = [];
  conn.client.onEvent((e) => {
    if (e.type === "remote.pairRequest") list.push(e.request);
  });
  await conn.client.call("events.subscribe", { types: ["remote.pairRequest"] });
  const seen = list.length;
  return { list, next: (ms = 15_000) => waitFor(() => list[seen], "the Mac to be asked to pair", ms) };
}

/** Stop the core on `home` (and its PTY host with `terminals`): scripts/stop-core.mjs. */
export async function stopCore(home: string, o: { terminals?: boolean } = {}): Promise<void> {
  const mod = (await import(pathToFileURL(path.join(root, "scripts/stop-core.mjs")).href)) as { stopCore(home: string, o: { terminals?: boolean }): Promise<void> };
  await mod.stopCore(home, o);
}

export type BrowserName = "webkit" | "chromium";

/** Playwright's engine by name. */
export async function browserType(name: BrowserName): Promise<BrowserType> {
  const pw = await import("playwright");
  return name === "chromium" ? pw.chromium : pw.webkit;
}

/** Why WebKit didn't start, in a line: the sandbox, or its build isn't installed. */
export function webkitTrouble(err: unknown): string {
  const msg = String((err as Error)?.message ?? err);
  if (/Executable doesn't exist|npx playwright install/.test(msg)) return "WebKit isn't installed (npx playwright install webkit)";
  return "WebKit couldn't start (it can't in the Agent Safehouse sandbox)";
}
