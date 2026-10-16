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
// effect without restarting anything.

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

/** An upgrade handler for an http.Server; true when the request was one of ours. */
export function phoneProxy(o: ProxyOptions): (req: http.IncomingMessage, socket: Duplex, head: Buffer) => boolean {
  const info = o.info ?? ((t: TargetName) => coreInfo(resolveTarget(t)));
  const log = o.log ?? (() => {});
  const hosts = new Set(o.hosts.map((h) => h.toLowerCase()));
  return (req, socket, head) => {
    const split = splitPath(req.url ?? "");
    if (!split) return false;
    socket.on("error", () => {});
    const refuse = (status: string, why: string) => {
      log(`/c/${split.target}: ${why}`);
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
    };
    if (!ownPage(req, hosts)) return refuse("403 Forbidden", "refused a socket from another page"), true;
    if (!split.rest.startsWith("/r/")) return refuse("404 Not Found", `nothing at ${split.rest}`), true;
    void info(split.target).then(
      (core) => {
        if (!core.origin) return refuse("503 Service Unavailable", `the ${split.target} core can't take phones: ${core.error ?? "remote access isn't ready"}`);
        forward(req, socket, head, split.rest, core.port, core.origin, () => refuse("502 Bad Gateway", `nothing listens on 127.0.0.1:${core.port}`));
      },
      (err: Error) => refuse("502 Bad Gateway", `the ${split.target} core isn't running (${err.message})`),
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

function forward(req: http.IncomingMessage, socket: Duplex, head: Buffer, path: string, port: number, origin: string, unreachable: () => void): void {
  const up = net.connect(port, "127.0.0.1");
  let connected = false;
  up.on("connect", () => {
    connected = true;
    up.write(upgradeHead(req, path, port, origin));
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => (connected ? socket.destroy() : unreachable()));
  up.on("close", () => connected && socket.destroy());
  socket.on("close", () => up.destroy());
}
