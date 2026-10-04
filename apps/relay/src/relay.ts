// The remote-access relay (docs/13-remote-access.md, "Relay"): a dumb forwarder
// between a Mac's core (one host link per route) and that route's devices. It
// keeps no state beyond route registrations, never sees plaintext (everything
// on a channel is Noise-encrypted end to end), never serves HTML and never logs
// payloads: only connection counts and byte totals per route.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { decodeRelayFrame, encodeRelayFrame, RELAY_LIMITS, RelayClose, RelayFrameType } from "@cmd/protocol";

export interface RelayOptions {
  port?: number;
  host?: string;
  /** Device links must come from this Origin (the web client's), when set. Defence in depth, not auth. */
  origin?: string | null;
  /** Use X-Forwarded-For for rate limits (behind the Uberspace frontend). */
  trustProxy?: boolean;
  /** JSON file that keeps route registrations across restarts; null: memory only. */
  stateFile?: string | null;
  log?: (msg: string) => void;
  limits?: Partial<Record<keyof typeof RELAY_LIMITS, number>>;
}

export interface Relay {
  port: number;
  url: string;
  close(): Promise<void>;
}

interface Route {
  /** sha256(secret), hex. */
  secretHash: string;
  host: WebSocket | null;
  channels: Map<number, WebSocket>;
  nextChannel: number;
  bytesIn: number;
  bytesOut: number;
  connects: number;
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const randomId = (n: number) => crypto.randomBytes(n).toString("base64url");

export async function startRelay(o: RelayOptions = {}): Promise<Relay> {
  const limits = { ...RELAY_LIMITS, ...o.limits };
  const log = o.log ?? ((m: string) => console.log(`[relay] ${m}`));
  const routes = new Map<string, Route>();
  const route = (id: string, secretHash: string): Route => {
    const r: Route = { secretHash, host: null, channels: new Map(), nextChannel: 1, bytesIn: 0, bytesOut: 0, connects: 0 };
    routes.set(id, r);
    return r;
  };
  if (o.stateFile && fs.existsSync(o.stateFile)) {
    for (const [id, hash] of Object.entries(JSON.parse(fs.readFileSync(o.stateFile, "utf8")) as Record<string, string>)) route(id, hash);
  }
  const save = () => {
    if (!o.stateFile) return;
    const doc = Object.fromEntries([...routes].map(([id, r]) => [id, r.secretHash]));
    fs.writeFileSync(o.stateFile, JSON.stringify(doc), { mode: 0o600 });
  };

  const connectsByIp = new Map<string, number[]>();
  const rateLimited = (ip: string) => {
    const now = Date.now();
    const recent = (connectsByIp.get(ip) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    connectsByIp.set(ip, recent);
    return recent.length > limits.connectsPerIpPerMinute;
  };

  const server = http.createServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/plain" }).end("cmd relay\n");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.frameBytes + 5 });
  const lastSeen = new WeakMap<WebSocket, number>();
  const alive = (ws: WebSocket) => {
    lastSeen.set(ws, Date.now());
    ws.on("pong", () => lastSeen.set(ws, Date.now()));
    ws.on("message", () => lastSeen.set(ws, Date.now()));
  };

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://relay");
    const ip = (o.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "") || req.socket.remoteAddress || "?";
    if (url.pathname === "/h") {
      wss.handleUpgrade(req, socket, head, (ws) => hostLink(ws));
      return;
    }
    const m = /^\/r\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
    if (!m || (o.origin && req.headers.origin !== o.origin) || rateLimited(ip)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => deviceLink(ws, m[1]!, ip));
  });

  /** The core's link: authenticate (or register) the route, then route frames to its channels. */
  function hostLink(ws: WebSocket): void {
    alive(ws);
    let r: Route | null = null;
    let routeId = "";
    ws.on("message", (data, isBinary) => {
      if (!r) {
        if (isBinary) return ws.close(RelayClose.forbidden);
        let msg: { register?: boolean; route?: string; secret?: string };
        try {
          msg = JSON.parse(String(data));
        } catch {
          return ws.close(RelayClose.forbidden);
        }
        if (msg.register) {
          routeId = randomId(16);
          const secret = randomId(32);
          r = route(routeId, sha256(secret));
          save();
          ws.send(JSON.stringify({ route: routeId, secret }));
        } else if (typeof msg.route === "string" && typeof msg.secret === "string" && /^[A-Za-z0-9_-]{22}$/.test(msg.route)) {
          routeId = msg.route;
          // An unknown route re-registers (the relay lost its state); a known one must match.
          const known = routes.get(routeId);
          if (known && !crypto.timingSafeEqual(Buffer.from(known.secretHash), Buffer.from(sha256(msg.secret)))) return ws.close(RelayClose.forbidden);
          r = known ?? route(routeId, sha256(msg.secret));
          if (!known) save();
          ws.send(JSON.stringify({ ok: true }));
        } else return ws.close(RelayClose.forbidden);
        r.host?.close(1000, "replaced");
        r.host = ws;
        log(`host up: ${routeId.slice(0, 6)}…`);
        return;
      }
      if (!isBinary) return;
      let f;
      try {
        f = decodeRelayFrame(toBytes(data));
      } catch {
        return;
      }
      const dev = r.channels.get(f.channel);
      if (!dev) return;
      if (f.type === RelayFrameType.close) return dev.close(1000);
      if (f.type !== RelayFrameType.data) return;
      if (dev.bufferedAmount > limits.bufferedBytes) return dev.terminate();
      r.bytesOut += f.payload.length;
      dev.send(f.payload);
    });
    ws.on("close", () => {
      if (!r || r.host !== ws) return;
      r.host = null;
      for (const dev of r.channels.values()) dev.close(RelayClose.unavailable);
      log(`host down: ${routeId.slice(0, 6)}… (${r.connects} device connections, ${r.bytesIn} B in, ${r.bytesOut} B out)`);
    });
    ws.on("error", () => {});
  }

  /** A device's link: a channel on its route's host link. Unknown and offline routes look the same. */
  function deviceLink(ws: WebSocket, routeId: string, ip: string): void {
    const r = routes.get(routeId);
    const host = r?.host;
    if (!r || !host || host.readyState !== WebSocket.OPEN) return ws.close(RelayClose.unavailable);
    if (r.channels.size >= limits.channelsPerRoute) return ws.close(RelayClose.busy);
    alive(ws);
    const channel = r.nextChannel++;
    r.channels.set(channel, ws);
    r.connects++;
    const toHost = (type: RelayFrameType, payload: Uint8Array) => {
      if (r.host !== host || host.readyState !== WebSocket.OPEN) return ws.close(RelayClose.unavailable);
      if (host.bufferedAmount > limits.bufferedBytes) return ws.terminate();
      host.send(encodeRelayFrame({ channel, type, payload }));
    };
    toHost(RelayFrameType.open, new TextEncoder().encode(JSON.stringify({ ip })));
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return ws.close(RelayClose.forbidden);
      const b = toBytes(data);
      if (b.length > limits.frameBytes) return ws.close(RelayClose.tooLarge);
      r.bytesIn += b.length;
      toHost(RelayFrameType.data, b);
    });
    ws.on("close", () => {
      r.channels.delete(channel);
      if (r.host === host && host.readyState === WebSocket.OPEN) host.send(encodeRelayFrame({ channel, type: RelayFrameType.close, payload: new Uint8Array(0) }));
    });
    ws.on("error", () => {});
  }

  const ping = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      if (now - (lastSeen.get(ws) ?? now) > limits.idleMs) ws.terminate();
      else ws.ping();
    }
    for (const [ip, ts] of connectsByIp) if (ts.every((t) => now - t > 60_000)) connectsByIp.delete(ip);
  }, limits.pingMs);

  await new Promise<void>((resolve) => server.listen(o.port ?? 0, o.host ?? "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `ws://${o.host ?? "127.0.0.1"}:${port}`,
    close: async () => {
      clearInterval(ping);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}
