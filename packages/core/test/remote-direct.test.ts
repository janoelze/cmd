// Direct remote access end to end (docs/38): a core with remote.access "url",
// its loopback listener serving a stand-in web client, and a device speaking
// Noise over a real WebSocket to it, as a proxy in front would pass it on.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RpcClient, type CoreEvent, type RemotePairRequest } from "@cmd/protocol";
import { decodePairing, generateKeyPair, openDeviceSession, type Bytes, type KeyPair } from "@cmd/remote-crypto";
import { publicOrigin } from "../src/remote/access/url.ts";
import { defaultDirectPort, DirectListener, type DirectListenerOptions } from "../src/remote/direct.ts";
import { Core } from "../src/core.ts";
import { fakeFactory } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

const ORIGIN = "https://mac.example.test";
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-remote-direct-")));
const web = path.join(dir, "web");
let core: Core;
let port: number;
let base: string;
const events: CoreEvent[] = [];

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

beforeAll(async () => {
  fs.mkdirSync(path.join(web, "assets"), { recursive: true });
  fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>cmd</title>");
  fs.writeFileSync(path.join(web, "assets", "app.js"), "console.log(1)");
  fs.writeFileSync(path.join(web, ".htaccess"), "secret");
  process.env.CMD_WEB_DIR = web;
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  core = new Core({ socketPath: path.join(dir, "core.sock"), dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, home: dir });
  core.serve({ access: "local", send: () => {}, event: (e) => events.push(e), close: () => {} }).receive(JSON.stringify({ id: 1, method: "events.subscribe", params: {} }));
  core.settings.set("remote.access", "url");
  core.settings.set("remote.url", `${ORIGIN}/`);
  core.settings.set("remote.port", port);
  await core.call("remote.enable", {});
  await core.remote.ready();
  for (let i = 0; i < 100 && core.remote.status().state !== "online"; i++) await new Promise((r) => setTimeout(r, 20));
  expect(core.remote.status()).toMatchObject({ state: "online", error: null });
});

afterAll(async () => {
  delete process.env.CMD_WEB_DIR;
  await core?.close();
  rmTemp(dir);
});

/** A device's WebSocket as the proxy forwards it: Origin and X-Forwarded-For set. */
function socket(route: string, origin = ORIGIN): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/r/${route}`, { origin, headers: { "x-forwarded-for": "100.64.0.7" } });
}

async function connect(route: string, o: { hostKey: Bytes; device: KeyPair; psk?: Bytes }) {
  const ws = socket(route);
  ws.binaryType = "arraybuffer";
  let closed = false;
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  const { receive, closed: onClosed, session } = openDeviceSession({ ...o, hello: { name: "Tailnet Phone" }, socket: { send: (b) => ws.send(b), close: () => ws.close() } });
  ws.on("message", (d) => receive(new Uint8Array(d as ArrayBuffer)));
  ws.on("close", () => {
    closed = true;
    onClosed();
  });
  session.catch(() => {});
  return { session, ws, closed: () => closed };
}

/** The status code an upgrade is refused with. */
const refused = (ws: WebSocket) => new Promise<number>((resolve) => ws.on("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0)).on("error", () => {}));

const pairRequest = () => events.findLast((e): e is Extract<CoreEvent, { type: "remote.pairRequest" }> => e.type === "remote.pairRequest")?.request;

describe("direct remote access", () => {
  let device: KeyPair;
  let hostKey: Bytes;
  let route: string;

  it("says where phones open cmd", () => {
    expect(core.remote.status()).toMatchObject({ access: "url", address: ORIGIN, state: "online" });
  });

  it("serves the web client with its headers, and the app for every other path", async () => {
    const page = await fetch(`${base}/pair`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>cmd</title>");
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect(await js.text()).toBe("console.log(1)");
    expect(await (await fetch(`${base}/.htaccess`)).text()).not.toContain("secret");
    expect(await (await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).text()).toContain("<title>cmd</title>");
    expect((await fetch(base, { method: "POST" })).status).toBe(405);
  });

  it("pairs a device through a link to this Mac's own address", async () => {
    const url = new URL((await core.call("remote.pair", { scope: "control" })).url);
    expect(url.origin).toBe(ORIGIN);
    const link = decodePairing(url.hash);
    expect(link.relay).toBe("wss://mac.example.test");
    ({ hostKey, route } = link);
    device = await generateKeyPair();
    const c = await connect(route, { hostKey, device, psk: link.psk });
    await expect.poll(pairRequest).toBeTruthy();
    await core.call("remote.approve", { requestId: (pairRequest() as RemotePairRequest).requestId, allow: true });
    const s = await c.session;
    expect(s.host).toMatchObject({ scope: "control" });
    c.ws.close();
  });

  it("runs a session, with the device's address from the proxy", async () => {
    const c = await connect(route, { hostKey, device });
    const s = await c.session;
    const client = new RpcClient((line) => void s.send(line));
    s.onLine((l) => client.receive(l));
    expect((await client.call("remote.bootstrap", {})).device).toMatchObject({ scope: "control" });
    const pane = await client.call("pane.create", {});
    expect(core.panes.get(pane.id)).toBeTruthy();
    expect(core.remote.status().sessions).toMatchObject([{ name: "Tailnet Phone", ip: "100.64.0.7" }]);
    c.ws.close();
    await expect.poll(() => core.remote.status().sessions).toEqual([]);
  });

  it("refuses a key it never paired", async () => {
    const c = await connect(route, { hostKey, device: await generateKeyPair() });
    await expect.poll(c.closed).toBe(true);
    expect((await core.call("remote.log", {})).map((e) => e.kind)).toContain("handshake-failed");
  });

  it("refuses upgrades from another origin, without one, or to another route", async () => {
    expect(await refused(socket(route, "https://evil.example"))).toBe(403);
    expect(await refused(new WebSocket(`ws://127.0.0.1:${port}/r/${route}`))).toBe(403);
    expect(await refused(socket("A".repeat(22)))).toBe(403);
  });

  it("stops listening when turned off, and keeps its route when turned on again", async () => {
    await core.call("remote.disable", {});
    await expect(fetch(base)).rejects.toThrow();
    await core.call("remote.enable", {});
    await expect.poll(() => core.remote.status().state).toBe("online");
    expect(decodePairing(new URL((await core.call("remote.pair", {})).url).hash).route).toBe(route);
  });

  it("lists the url mode's checks", async () => {
    core.settings.set("remote.url", "http://mac.example.test");
    expect((await core.call("remote.checks", { access: "url" })).map((c) => `${c.id}:${c.state}`)).toEqual(["url:todo", "page:todo", "socket:todo"]);
    expect(await core.call("remote.checks", { access: "relay" })).toEqual([]);
    await expect(core.call("remote.checks", { access: "nope" })).rejects.toThrow("No access mode “nope”. Pick one of relay, tailscale, url.");
  });
});

describe("publicOrigin", () => {
  it("takes an https origin and nothing else", () => {
    expect(publicOrigin(" https://Mac.example.com/ ")).toEqual({ url: "https://mac.example.com" });
    expect(publicOrigin("https://mac.example.com:8443")).toEqual({ url: "https://mac.example.com:8443" });
    expect(publicOrigin("")).toHaveProperty("error");
    expect(publicOrigin("http://mac.example.com")).toHaveProperty("error");
    expect(publicOrigin("http://127.0.0.1:47392")).toEqual({ url: "http://127.0.0.1:47392" });
    expect(publicOrigin("https://mac.example.com/cmd")).toHaveProperty("error");
    expect(publicOrigin("mac")).toHaveProperty("error");
  });
});

describe("DirectListener", () => {
  const root = path.join(dir, "listener");
  const site = path.join(root, "site");
  let open: DirectListener[] = [];

  beforeAll(() => {
    fs.mkdirSync(path.join(site, "assets"), { recursive: true });
    fs.mkdirSync(path.join(site, ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(site, "index.html"), "<!doctype html><title>app</title>");
    fs.writeFileSync(path.join(site, "assets", "a.js"), "a()");
    fs.writeFileSync(path.join(site, ".hidden", "b.js"), "hidden");
    fs.writeFileSync(path.join(root, "outside.txt"), "outside");
  });

  afterAll(() => {
    for (const l of open) l.close();
  });

  async function listen(o: Partial<DirectListenerOptions> = {}): Promise<{ l: DirectListener; url: string }> {
    const l = new DirectListener({ port: 0, route: "R".repeat(22), webDir: site, ...o });
    open.push(l);
    l.setOrigin(ORIGIN);
    l.start();
    await expect.poll(() => l.port).toBeTruthy();
    return { l, url: `127.0.0.1:${l.port}` };
  }

  /** A raw GET, so the path reaches the server unnormalized. */
  const raw = (url: string, p: string) =>
    new Promise<string>((resolve, reject) => {
      const [host, port] = url.split(":");
      http.get({ host, port, path: p }, (res) => {
        let b = "";
        res.on("data", (d) => (b += d)).on("end", () => resolve(b));
      }).on("error", reject);
    });

  /** Opens a device socket and resolves with what the listener's "open" reported. */
  const opened = (l: DirectListener, url: string, headers: Record<string, string>) =>
    new Promise<{ ip: string; user: string | null | undefined }>((resolve, reject) => {
      l.once("open", (_ch, ip, user) => resolve({ ip, user }));
      const ws = new WebSocket(`ws://${url}/r/${l.route}`, { origin: ORIGIN, headers });
      ws.on("unexpected-response", () => reject(new Error("refused"))).on("error", () => {});
      ws.on("open", () => ws.close());
    });

  it("serves from memory with an ETag, a 304 and HEAD", async () => {
    const { url } = await listen();
    const js = await fetch(`http://${url}/assets/a.js`);
    expect(await js.text()).toBe("a()");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const etag = js.headers.get("etag")!;
    expect(etag).toMatch(/^".+"$/);
    expect((await fetch(`http://${url}/assets/a.js`, { headers: { "if-none-match": etag } })).status).toBe(304);
    const head = await fetch(`http://${url}/assets/a.js`, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe("3");
    expect(await head.text()).toBe("");
  });

  it("never leaves the build or serves dot folders", async () => {
    const { url } = await listen();
    expect(await raw(url, "/../outside.txt")).toContain("<title>app</title>");
    expect(await raw(url, "/%2e%2e/outside.txt")).toContain("<title>app</title>");
    expect(await raw(url, "/assets/..%2f..%2foutside.txt")).toContain("<title>app</title>");
    expect(await raw(url, "/.hidden/b.js")).toContain("<title>app</title>");
    expect(await raw(url, "/%")).toContain("<title>app</title>");
  });

  it("answers 503 without a build", async () => {
    const { url } = await listen({ webDir: null });
    expect((await fetch(`http://${url}/`)).status).toBe(503);
    const { url: empty } = await listen({ webDir: path.join(root, "nope") });
    expect((await fetch(`http://${empty}/`)).status).toBe(503);
  });

  it("takes the rightmost X-Forwarded-For entry, the one the proxy added", async () => {
    const { l, url } = await listen();
    expect((await opened(l, url, { "x-forwarded-for": "6.6.6.6, 100.64.0.9" })).ip).toBe("100.64.0.9");
    expect((await opened(l, url, { "x-forwarded-for": "100.64.0.8" })).ip).toBe("100.64.0.8");
  });

  it("rate-limits by the proxy's entry, whatever the client puts left of it", async () => {
    const { l, url } = await listen({ limits: { connectsPerIpPerMinute: 2 } });
    for (const spoof of ["1.1.1.1", "2.2.2.2"]) await opened(l, url, { "x-forwarded-for": `${spoof}, 100.64.0.5` });
    await expect(opened(l, url, { "x-forwarded-for": "3.3.3.3, 100.64.0.5" })).rejects.toThrow("refused");
  });

  it("knows who is on the other end only through identify", async () => {
    const header = { "tailscale-user-login": "me@example.com" };
    const plain = await listen();
    expect((await opened(plain.l, plain.url, header)).user).toBeNull();
    const id = await listen({ identify: (req) => String(req.headers["tailscale-user-login"] ?? "") || null });
    expect((await opened(id.l, id.url, header)).user).toBe("me@example.com");
    expect((await opened(id.l, id.url, {})).user).toBeNull();
  });
});

describe("defaultDirectPort", () => {
  const saved = { home: process.env.CMD_HOME, instance: process.env.CMD_INSTANCE };
  const env = (instance: string | undefined, home: string | undefined) => {
    for (const [k, v] of [["CMD_INSTANCE", instance], ["CMD_HOME", home]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  afterAll(() => env(saved.instance, saved.home));

  it("keeps release and the default dev instance apart, and gives each CMD_HOME its own stable port", () => {
    env("release", undefined);
    expect(defaultDirectPort()).toBe(47391);
    env("dev", undefined);
    expect(defaultDirectPort()).toBe(47392);
    env("dev", "/tmp/wt-a/.cmd-dev");
    const a = defaultDirectPort();
    expect(a).toBeGreaterThanOrEqual(47400);
    expect(a).toBeLessThanOrEqual(48399);
    env("dev", "/tmp/wt-a/sub/../.cmd-dev");
    expect(defaultDirectPort()).toBe(a);
    const ports = new Set(["a", "b", "c", "d", "e"].map((w) => (env("dev", `/tmp/wt-${w}/.cmd-dev`), defaultDirectPort())));
    expect(ports.size).toBeGreaterThan(1);
  });
});
