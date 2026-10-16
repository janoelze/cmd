// The phone origin's WebSocket hop (docs/56-phone-development.md): a device
// socket to /c/<target>/r/<route> goes to that core's direct listener on
// loopback as /r/<route>, byte for byte after the upgrade (the bytes are Noise,
// opaque here). What the listener checks still holds:
// - Origin: it takes upgrades only from its own public origin. The proxy takes
//   them only from its own page, then says the core's origin in its place. Its
//   own page: a Host it serves (127.0.0.1 or localhost on Vite's port, the
//   tailnet name), so a site rebound to 127.0.0.1 (DNS rebinding), whose Origin
//   and Host agree, is still refused; and an Origin on that same host.
// - X-Forwarded-For: the listener rate-limits and lists sessions by the
//   rightmost entry, the address its trusted proxy saw. Tailscale Serve in
//   front of Vite appended the phone's tailnet address, so that goes through
//   untouched; without a proxy in front (localhost), this hop adds the address
//   it saw, as the listener would have used.
// - Tailscale-User-Login: Serve sets it and strips what clients send; passed on
//   as is, so a core in Tailscale mode still shows who's connecting.
// The target is looked up on every connection, so `pnpm phone:use` takes
// effect without restarting anything. No socket is left hanging: every upgrade
// that isn't ours or Vite's HMR gets a 404 at once (phoneUpgrades), a refused one
// is destroyed after its answer, and a forwarded pair goes when either side
// closes, errs or ends. Each forwarded socket is logged as it opens and closes.

import type http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { coreInfo, resolveTarget, splitPath, type CoreInfo, type TargetName } from "./targets.ts";

export interface ProxyOptions {
  /** The Host values this server answers to ("127.0.0.1:5190", "mac.tailnet.ts.net:5443"); upgrades for any other are refused. */
  hosts: string[];
  /** Where the target's listener is and the origin it wants (default: asks its core). */
  info?: (target: TargetName) => Promise<CoreInfo>;
  log?: (msg: string) => void;
}

/** Headers this hop sets itself rather than passing on. */
const OWN = new Set(["host", "origin", "x-forwarded-for", "x-forwarded-host"]);

/** The Hosts phone:serve answers to: Vite's loopback port by both names, and the tailnet name (bare on 443). */
export function phoneHosts(vitePort: number, tailnet: { host: string; port: number } | null): string[] {
  const hosts = [`127.0.0.1:${vitePort}`, `localhost:${vitePort}`];
  if (tailnet) hosts.push(tailnet.port === 443 ? tailnet.host : `${tailnet.host}:${tailnet.port}`);
  return hosts;
}

/** How long finding the core may take before the phone is told 504, and how long a refusal may take to send. */
const LOOKUP_MS = 10_000;
const REFUSE_MS = 2000;

/** Vite's own HMR socket (its client asks with one of these subprotocols): Vite's listener answers it. */
export function isViteUpgrade(req: http.IncomingMessage): boolean {
  return String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .some((p) => ["vite-hmr", "vite-ping"].includes(p.trim()));
}

/** Answer an upgrade nobody takes, now: left alone it hangs (and, behind Tailscale Serve, holds one of the phone's few connections). */
export function noUpgrade(socket: Duplex): void {
  socket.on("error", () => {});
  socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
  setTimeout(() => socket.destroy(), REFUSE_MS).unref();
}

/**
 * The one 'upgrade' listener a server needs: the proxy's paths, Vite's HMR socket left to
 * Vite (only when `hmr`: without it nothing would answer), and a 404 for everything else.
 * Node calls every 'upgrade' listener in turn, so this decides from the request alone.
 */
export function phoneUpgrades(proxy: ReturnType<typeof phoneProxy>, o: { hmr: boolean }): (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    if (proxy(req, socket, head)) return;
    if (o.hmr && isViteUpgrade(req)) return;
    noUpgrade(socket);
  };
}

/** An upgrade handler for an http.Server; true when the request was one of ours. */
export function phoneProxy(o: ProxyOptions): (req: http.IncomingMessage, socket: Duplex, head: Buffer) => boolean {
  const info = o.info ?? ((t: TargetName) => coreInfo(resolveTarget(t)));
  const log = o.log ?? (() => {});
  const hosts = new Set(o.hosts.map((h) => h.toLowerCase()));
  return (req, socket, head) => {
    const split = splitPath(req.url ?? "");
    if (!split) return false;
    socket.on("error", () => {});
    let answered = false;
    const refuse = (status: string, why: string) => {
      if (answered) return;
      answered = true;
      log(`/c/${split.target}: ${why}`);
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
      setTimeout(() => socket.destroy(), REFUSE_MS).unref();
    };
    if (!ownPage(req, hosts)) return refuse("403 Forbidden", "refused a socket from another page"), true;
    if (!split.rest.startsWith("/r/")) return refuse("404 Not Found", `nothing at ${split.rest}`), true;
    const slow = setTimeout(() => refuse("504 Gateway Timeout", `the ${split.target} core didn't say where it listens in time`), LOOKUP_MS);
    slow.unref();
    void info(split.target).then(
      (core) => {
        clearTimeout(slow);
        if (answered) return;
        if (!core.origin) return refuse("503 Service Unavailable", `the ${split.target} core can't take phones: ${core.error ?? "remote access isn't ready"}`);
        answered = true;
        forward(req, socket, head, split.rest, core.port, core.origin, () => ((answered = false), refuse("502 Bad Gateway", `nothing listens on 127.0.0.1:${core.port}`)), (m) => log(`/c/${split.target}: ${m}`));
      },
      (err: Error) => (clearTimeout(slow), refuse("502 Bad Gateway", `the ${split.target} core isn't running (${err.message})`)),
    );
    return true;
  };
}

/** The socket comes from this server's own page: a Host it serves, and an Origin on that host. */
function ownPage(req: http.IncomingMessage, hosts: Set<string>): boolean {
  const host = req.headers.host?.toLowerCase();
  if (!host || !hosts.has(host)) return false;
  try {
    return !!req.headers.origin && new URL(req.headers.origin).host === host;
  } catch {
    return false;
  }
}

/** The upgrade request as the listener should see it. */
export function upgradeHead(req: http.IncomingMessage, path: string, port: number, origin: string): string {
  const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Origin: ${origin}`];
  const xff = req.headers["x-forwarded-for"];
  lines.push(`X-Forwarded-For: ${(Array.isArray(xff) ? xff.join(", ") : xff) || req.socket.remoteAddress || "?"}`);
  if (req.headers.host) lines.push(`X-Forwarded-Host: ${req.headers.host}`);
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) if (!OWN.has(raw[i]!.toLowerCase())) lines.push(`${raw[i]}: ${raw[i + 1]}`);
  return lines.join("\r\n") + "\r\n\r\n";
}

function forward(req: http.IncomingMessage, socket: Duplex, head: Buffer, path: string, port: number, origin: string, unreachable: () => void, log: (m: string) => void): void {
  const up = net.connect(port, "127.0.0.1");
  const at = Date.now();
  const route = path.replace(/^\/r\//, "").slice(0, 8);
  let connected = false;
  let done = false;
  // Either side closing, failing or ending (a half-close) ends both: a WebSocket has no use for half a connection.
  const end = () => {
    if (done) return;
    done = true;
    up.destroy();
    socket.destroy();
    if (connected) log(`closed ${route}… after ${((Date.now() - at) / 1000).toFixed(1)} s`);
  };
  up.setKeepAlive(true, 30_000);
  if (socket instanceof net.Socket) socket.setKeepAlive(true, 30_000);
  up.on("connect", () => {
    connected = true;
    log(`open ${route}… → 127.0.0.1:${port}`);
    up.write(upgradeHead(req, path, port, origin));
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => {
    if (connected) return end();
    done = true;
    unreachable();
  });
  up.on("end", end);
  up.on("close", () => connected && end());
  socket.on("end", end);
  socket.on("close", () => (connected ? end() : up.destroy()));
}
