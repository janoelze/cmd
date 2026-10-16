// The phone origin's dev tooling (scripts/phone-origin, docs/56-phone-development.md):
// pairing links pointed at it, where /c/<target> paths go, the ports it computes
// with the core's own function, the proxy following `phone:use` live, and no
// upgrade left unanswered (Vite's client socket with --no-hmr used to hang there).

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePairing, encodePairing, toBase64Url } from "../packages/remote-crypto/src/index.ts";
import { defaultDirectPort } from "../packages/core/src/remote/direct.ts";
import { rewriteLink } from "../scripts/phone-origin/link.ts";
import { isViteUpgrade, phoneHosts, phoneProxy, phoneUpgrades } from "../scripts/phone-origin/proxy.ts";
import { coreSocketPathOf } from "../packages/protocol/src/node.ts";
import { devTarget, homeFor, phoneHome, resolveTarget, splitPath, useDev } from "../scripts/phone-origin/targets.ts";

const bytes = (n: number, v: number) => new Uint8Array(n).fill(v);

describe("rewriteLink", () => {
  it("moves the client and socket to the phone origin, the rest as the core made it", () => {
    const route = toBase64Url(bytes(16, 7));
    const made = `https://mac.tailnet.ts.net:8443/pair#${encodePairing({ socket: "wss://mac.tailnet.ts.net:8443", route, hostKey: bytes(32, 1), psk: bytes(32, 2) })}`;
    const link = rewriteLink(made, "https://mac.tailnet.ts.net:5443", "release");
    const url = new URL(link);
    expect(url.origin).toBe("https://mac.tailnet.ts.net:5443");
    expect(url.pathname).toBe("/pair");
    const p = decodePairing(url.hash);
    expect(p.socket).toBe("wss://mac.tailnet.ts.net:5443/c/release");
    expect(p.route).toBe(route);
    expect(p.hostKey).toEqual(bytes(32, 1));
    expect(p.psk).toEqual(bytes(32, 2));
  });

  it("dials ws: on a localhost origin", () => {
    const made = `http://127.0.0.1:47400/pair#${encodePairing({ socket: "ws://127.0.0.1:47400", route: toBase64Url(bytes(16, 3)), hostKey: bytes(32, 1), psk: bytes(32, 2) })}`;
    expect(decodePairing(new URL(rewriteLink(made, "http://127.0.0.1:5190", "dev")).hash).socket).toBe("ws://127.0.0.1:5190/c/dev");
  });
});

describe("targets", () => {
  it("maps /c/<target>/… to the path the core sees", () => {
    expect(splitPath("/c/release/r/abc")).toEqual({ target: "release", rest: "/r/abc" });
    expect(splitPath("/c/dev/r/abc?x=1")).toEqual({ target: "dev", rest: "/r/abc?x=1" });
    expect(splitPath("/c/dev")).toEqual({ target: "dev", rest: "/" });
    expect(splitPath("/c/other/r/abc")).toBeNull();
    expect(splitPath("/r/abc")).toBeNull();
    expect(splitPath("/c/devx/r/abc")).toBeNull();
  });

  it("finds each core's port and socket with the core's and the protocol's own functions", () => {
    const before = { home: process.env.CMD_HOME, instance: process.env.CMD_INSTANCE };
    const home = path.join(os.tmpdir(), "phone-origin-home");
    expect(resolveTarget("release")).toMatchObject({ port: 47391, socket: coreSocketPathOf("release", null), home: null });
    expect(devTarget(null)).toMatchObject({ port: 47392, socket: coreSocketPathOf("dev", null) });
    const t = devTarget(home);
    expect(t.port).toBe(defaultDirectPort({ instance: "dev", home }));
    expect(t.port).toBeGreaterThanOrEqual(47400);
    expect(t.socket).toBe(path.join(home, "core.sock"));
    expect({ home: process.env.CMD_HOME, instance: process.env.CMD_INSTANCE }).toEqual(before);
  });

  it("points /c/dev at the phone's dev core unless phone:use says otherwise", () => {
    const saved = process.env.CMD_PHONE_DIR;
    process.env.CMD_PHONE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "phone-dir-"));
    try {
      expect(resolveTarget("dev")).toMatchObject({ home: phoneHome(), socket: path.join(phoneHome(), "core.sock") });
      useDev("/tmp/elsewhere/.cmd-dev");
      expect(resolveTarget("dev").home).toBe("/tmp/elsewhere/.cmd-dev");
      useDev(null);
      expect(resolveTarget("dev").home).toBe(phoneHome());
    } finally {
      fs.rmSync(process.env.CMD_PHONE_DIR, { recursive: true, force: true });
      if (saved === undefined) delete process.env.CMD_PHONE_DIR;
      else process.env.CMD_PHONE_DIR = saved;
    }
  });

  it("reads a worktree as its .cmd-dev, \"phone\" as the phone's dev core, the main checkout as none, anything else as a CMD_HOME", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-use-"));
    const wt = path.join(dir, "wt");
    const main = path.join(dir, "main");
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: /x\n");
    fs.mkdirSync(path.join(main, ".git"), { recursive: true });
    expect(homeFor(wt)).toBe(path.join(wt, ".cmd-dev"));
    expect(homeFor(main)).toBeNull();
    expect(homeFor("phone")).toBe(phoneHome());
    expect(homeFor(path.join(dir, "home"))).toBe(path.join(dir, "home"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/** A stand-in direct listener: records the upgrade, then echoes with its name. */
function listener(name: string) {
  const seen: http.IncomingMessage[] = [];
  const server = http.createServer();
  server.on("upgrade", (req, socket: Duplex) => {
    seen.push(req);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d: Buffer) => socket.write(`${name}:${d.toString()}`));
  });
  return { server, seen, port: () => (server.address() as AddressInfo).port };
}

const listen = (s: http.Server) => new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));

/** Opens a socket through the proxy and says what came back for "ping", or the status it was refused with. */
async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function dial(port: number, p: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, headers: { connection: "Upgrade", upgrade: "websocket", origin: `http://127.0.0.1:${port}`, ...headers } });
    req.on("upgrade", (_res, socket) => {
      socket.once("data", (d: Buffer) => (resolve(d.toString()), socket.destroy()));
      socket.write("ping");
    });
    req.on("response", (res) => resolve(`refused ${res.statusCode}`));
    req.on("error", reject);
    req.end();
  });
}

describe("phoneProxy", () => {
  const a = listener("a");
  const b = listener("b");
  const rel = listener("release");
  const front = http.createServer((_q, r) => r.writeHead(404).end());
  const phoneDir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-dir-"));
  const homeA = path.join(phoneDir, "a");
  const homeB = path.join(phoneDir, "b");
  const saved = process.env.CMD_PHONE_DIR;
  const logs: string[] = [];

  beforeAll(async () => {
    process.env.CMD_PHONE_DIR = phoneDir;
    await Promise.all([listen(a.server), listen(b.server), listen(rel.server), listen(front)]);
    // What each core would say: its listener's port, by the home the target file names.
    const proxy = phoneProxy({
      hosts: phoneHosts(port(), { host: "mac.tailnet.ts.net", port: 5443 }),
      info: async (name) => {
        const t = resolveTarget(name);
        const port = name === "release" ? rel.port() : t.home === homeA ? a.port() : t.home === homeB ? b.port() : 0;
        return { port, origin: `https://${name}.core.example`, error: null };
      },
      log: (m) => logs.push(m),
    });
    front.on("upgrade", phoneUpgrades(proxy, { hmr: false }));
  });

  afterAll(() => {
    for (const s of [a.server, b.server, rel.server, front]) s.close();
    if (saved === undefined) delete process.env.CMD_PHONE_DIR;
    else process.env.CMD_PHONE_DIR = saved;
    fs.rmSync(phoneDir, { recursive: true, force: true });
  });

  const port = () => (front.address() as AddressInfo).port;

  it("strips /c/<target> and says the core's origin", async () => {
    expect(await dial(port(), "/c/release/r/ROUTE")).toBe("release:ping");
    const req = rel.seen.at(-1)!;
    expect(req.url).toBe("/r/ROUTE");
    expect(req.headers.origin).toBe("https://release.core.example");
    expect(req.headers.host).toBe(`127.0.0.1:${rel.port()}`);
    // Nothing in front of it: the address this hop saw.
    expect(req.headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(req.headers["sec-websocket-key"]).toBeUndefined();
    expect(req.headers.upgrade).toBe("websocket");
  });

  it("passes on what Tailscale Serve said about the phone", async () => {
    await dial(port(), "/c/release/r/ROUTE", { "x-forwarded-for": "100.64.0.9", "tailscale-user-login": "me@example.com" });
    const req = rel.seen.at(-1)!;
    expect(req.headers["x-forwarded-for"]).toBe("100.64.0.9");
    expect(req.headers["tailscale-user-login"]).toBe("me@example.com");
  });

  it("follows the target file without restarting", async () => {
    useDev(homeA);
    expect(await dial(port(), "/c/dev/r/X")).toBe("a:ping");
    useDev(homeB);
    expect(await dial(port(), "/c/dev/r/X")).toBe("b:ping");
    expect(b.seen.at(-1)!.url).toBe("/r/X");
    expect(b.seen.at(-1)!.headers.origin).toBe("https://dev.core.example");
  });

  it("refuses sockets from another page, and paths that aren't a device's", async () => {
    expect(await dial(port(), "/c/release/r/X", { origin: "https://evil.example" })).toBe("refused 403");
    expect(await dial(port(), "/c/release/other")).toBe("refused 404");
  });

  it("refuses a page rebound to this Mac (Host and Origin agree, but it's not a host it serves)", async () => {
    expect(await dial(port(), "/c/release/r/X", { host: `evil.example:${port()}`, origin: `http://evil.example:${port()}` })).toBe("refused 403");
    expect(await dial(port(), "/c/release/r/X", { host: "evil.example", origin: "https://evil.example" })).toBe("refused 403");
  });

  it("takes the tailnet name and localhost as its own", async () => {
    expect(await dial(port(), "/c/release/r/X", { host: "mac.tailnet.ts.net:5443", origin: "https://mac.tailnet.ts.net:5443" })).toBe("release:ping");
    expect(await dial(port(), "/c/release/r/X", { host: `localhost:${port()}`, origin: `http://localhost:${port()}` })).toBe("release:ping");
    expect(phoneHosts(5190, { host: "mac.tailnet.ts.net", port: 443 })).toContain("mac.tailnet.ts.net");
  });

  it("answers an upgrade it doesn't take with 404 at once (Vite's client socket with --no-hmr), and logs a forwarded socket opening and closing", async () => {
    const t = Date.now();
    expect(await dial(port(), "/")).toBe("refused 404");
    expect(await dial(port(), "/?token=abc", { "sec-websocket-protocol": "vite-hmr" })).toBe("refused 404");
    expect(Date.now() - t).toBeLessThan(1000);
    expect(await dial(port(), "/c/release/r/ROUTE1234")).toBe("release:ping");
    await until(() => logs.some((l) => /release: closed ROUTE123… after \d+\.\d s$/.test(l)));
    expect(logs.some((l) => /release: open ROUTE123… → 127\.0\.0\.1:\d+/.test(l))).toBe(true);
  });

  it("with HMR on, leaves Vite's own socket to Vite", () => {
    const req = (protocol?: string) => ({ url: "/?token=x", headers: protocol ? { "sec-websocket-protocol": protocol } : {} }) as unknown as http.IncomingMessage;
    expect(isViteUpgrade(req("vite-hmr"))).toBe(true);
    expect(isViteUpgrade(req("x, vite-ping"))).toBe(true);
    expect(isViteUpgrade(req())).toBe(false);
    const written: string[] = [];
    const socket = { on: () => socket, end: (d: string) => written.push(d), destroy: () => {} } as unknown as Duplex;
    phoneUpgrades(() => false, { hmr: true })(req("vite-hmr"), socket, Buffer.alloc(0));
    expect(written).toEqual([]);
    phoneUpgrades(() => false, { hmr: true })(req(), socket, Buffer.alloc(0));
    expect(written[0]).toMatch(/^HTTP\/1\.1 404/);
  });

  it("says when nothing listens", async () => {
    useDev(path.join(phoneDir, "nobody"));
    expect(await dial(port(), "/c/dev/r/X")).toBe("refused 502");
    expect(logs.at(-1)).toMatch(/nothing listens/);
  });
});
