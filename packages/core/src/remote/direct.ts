// Direct remote access (docs/38-direct-remote-access.md): the core listens on
// loopback and an access adapter (Tailscale Serve, your own proxy) puts HTTPS
// in front. It serves the web client, so the page phones run comes from this
// Mac, and takes device WebSockets on /r/<route> itself, each one a channel
// like a relay's: opaque Noise bytes, same limits. Upgrades need the public
// origin as Origin; everything past that needs a paired key (session.ts).
// The client is read into memory once at start(), so requests never touch the
// disk on the core's thread.

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { RELAY_LIMITS, RelayClose } from "@cmd/protocol";
import { cmdHome, instanceName, logger } from "@cmd/protocol/node";
import type { Endpoint, Transport, TransportEvents, TransportState } from "./transport.ts";

const log = logger("remote");

/**
 * The local port when remote.port is 0, stable so a published Serve config
 * stays valid: 47391 for release, 47392 for the default dev instance, and for
 * an instance in its own $CMD_HOME (one per worktree) a port in 47400–48399
 * derived from that folder, so several dev cores don't collide.
 */
export function defaultDirectPort(): number {
  if (process.env.CMD_HOME) return 47400 + (createHash("sha256").update(path.resolve(cmdHome())).digest().readUInt32BE(0) % 1000);
  return instanceName() === "dev" ? 47392 : 47391;
}

/** Most IPs the connect rate limit tracks between sweeps; past it the oldest go. */
const MAX_TRACKED_IPS = 10_000;
/** Most bytes of web client held in memory; files past it are left out (and answered with the app). */
const MAX_WEB_BYTES = 64 * 1024 * 1024;

/** apps/web/public/.htaccess, with WebSockets to this origin only. */
const HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

export interface DirectListenerOptions {
  port: number;
  /** The route devices dial (HostKeys.directRoute). */
  route: string;
  /** The built web client (webroot.ts); null answers 503. */
  webDir: string | null;
  limits?: Partial<Record<keyof typeof RELAY_LIMITS, number>>;
  /** Who is on the other end, as the access adapter's proxy says (a display hint, never trusted for access). */
  identify?: (req: http.IncomingMessage) => string | null;
}

interface WebFile {
  body: Buffer;
  type: string;
  etag: string;
}

/** The client by URL path ("/index.html", "/assets/app.js"), or null when there's no build. */
type WebRoot = Map<string, WebFile> | null;

export class DirectListener extends EventEmitter<TransportEvents> implements Transport {
  readonly route: string;
  state: TransportState = "connecting";
  error: string | null = null;
  #o: DirectListenerOptions;
  #limits: Record<keyof typeof RELAY_LIMITS, number>;
  #origin: string | null = null;
  #listening = false;
  #server: http.Server | null = null;
  #wss: WebSocketServer | null = null;
  #channels = new Map<number, WebSocket>();
  #next = 1;
  #connects = new Map<string, number[]>();
  #ping: ReturnType<typeof setInterval> | null = null;
  #web: Promise<WebRoot> | null = null;
  #webAt = 0;

  constructor(o: DirectListenerOptions) {
    super();
    this.#o = o;
    this.route = o.route;
    this.#limits = { ...RELAY_LIMITS, ...o.limits };
  }

  /** The port it listens on, once it does. */
  get port(): number | null {
    return this.#listening ? (this.#server!.address() as AddressInfo).port : null;
  }

  endpoint(): Endpoint | null {
    if (!this.#origin) return null;
    return { socket: this.#origin.replace(/^http/, "ws"), client: this.#origin };
  }

  /** The adapter's public origin (https://mac.tailnet.ts.net:8443), or why there is none. */
  setOrigin(url: string | null, error: string | null = null): void {
    this.#origin = url ? new URL(url).origin : null;
    this.#update(error);
  }

  start(): void {
    this.#loadWeb();
    const server = http.createServer((req, res) => {
      this.#serve(req, res).catch((err: Error) => {
        log.warn(`direct listener: ${err.message}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: this.#limits.frameBytes });
    this.#server = server;
    this.#wss = wss;
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://local");
      const ip = forwardedFor(req);
      const ok = url.pathname === `/r/${this.route}` && !!this.#origin && req.headers.origin === this.#origin && !this.#rateLimited(ip);
      if (!ok) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
        return;
      }
      const user = this.#o.identify?.(req) || null;
      wss.handleUpgrade(req, socket, head, (ws) => this.#device(ws, ip, user));
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      this.#listening = false;
      const msg = err.code === "EADDRINUSE" ? `Port ${this.#o.port} is in use. Pick another Local port (remote.port).` : err.message;
      log.warn(`direct listener: ${msg}`);
      this.#update(msg);
    });
    server.listen(this.#o.port, "127.0.0.1", () => {
      this.#listening = true;
      log.info(`direct listener on 127.0.0.1:${this.port}`);
      this.#update(null);
    });
    this.#ping = setInterval(() => this.#sweep(), this.#limits.pingMs);
  }

  send(channel: number, payload: Uint8Array): void {
    const ws = this.#channels.get(channel);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > this.#limits.bufferedBytes) return ws.terminate();
    ws.send(payload);
  }

  closeChannel(channel: number): void {
    const ws = this.#channels.get(channel);
    this.#channels.delete(channel);
    ws?.close(1000);
  }

  close(): void {
    if (this.#ping) clearInterval(this.#ping);
    for (const ws of this.#channels.values()) ws.terminate();
    this.#channels.clear();
    this.#wss?.close();
    this.#server?.closeAllConnections();
    this.#server?.close();
    this.#listening = false;
  }

  /** Reads the client into memory; without a build, a request a few seconds later looks again (`pnpm dev` builds it). */
  #loadWeb(): void {
    const dir = this.#o.webDir;
    this.#webAt = Date.now();
    this.#web = dir
      ? loadWebRoot(dir).catch((err: Error) => {
          log.warn(`direct listener: can't read the web client: ${err.message}`);
          return null;
        })
      : Promise.resolve(null);
  }

  #update(error: string | null): void {
    const state: TransportState = error || !this.#listening ? (error ? "error" : "connecting") : this.#origin ? "online" : "connecting";
    if (state === this.state && error === this.error) return;
    this.state = state;
    this.error = error;
    this.emit("state", state, error);
  }

  #rateLimited(ip: string): boolean {
    const now = Date.now();
    const recent = (this.#connects.get(ip) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    // Re-inserted, so the map runs oldest first and the cap drops the stalest.
    this.#connects.delete(ip);
    while (this.#connects.size >= MAX_TRACKED_IPS) this.#connects.delete(this.#connects.keys().next().value!);
    this.#connects.set(ip, recent);
    return recent.length > this.#limits.connectsPerIpPerMinute;
  }

  #device(ws: WebSocket, ip: string, user: string | null): void {
    if (this.#channels.size >= this.#limits.channelsPerRoute) return ws.close(RelayClose.busy);
    const channel = this.#next++;
    this.#channels.set(channel, ws);
    lastSeen.set(ws, Date.now());
    ws.on("pong", () => lastSeen.set(ws, Date.now()));
    ws.on("message", (data, isBinary) => {
      lastSeen.set(ws, Date.now());
      if (!isBinary) return ws.close(RelayClose.forbidden);
      if (this.#channels.get(channel) === ws) this.emit("data", channel, toBytes(data));
    });
    ws.on("close", () => {
      if (this.#channels.get(channel) !== ws) return;
      this.#channels.delete(channel);
      this.emit("close", channel);
    });
    ws.on("error", () => {});
    this.emit("open", channel, ip, user);
  }

  #sweep(): void {
    const now = Date.now();
    for (const ws of this.#channels.values()) {
      if (now - (lastSeen.get(ws) ?? now) > this.#limits.idleMs) ws.terminate();
      else ws.ping();
    }
    for (const [ip, ts] of this.#connects) if (ts.every((t) => now - t > 60_000)) this.#connects.delete(ip);
  }

  /** The web client: a file of the build, else index.html (the app's routes, /pair#… included). */
  async #serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
    let web = await this.#web;
    if (!web && this.#o.webDir && Date.now() - this.#webAt > 5_000) {
      this.#loadWeb();
      web = await this.#web;
    }
    const index = web?.get("/index.html");
    if (!web || !index) return void res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("The web client isn't built.\n");
    let file = index;
    try {
      // Normalized, so /../ can't leave the build; dotfiles were never loaded.
      file = web.get(path.posix.normalize(decodeURIComponent(new URL(req.url ?? "/", "http://local").pathname))) ?? index;
    } catch {
      // a malformed path: the app
    }
    const headers = { ...HEADERS, etag: file.etag, "cache-control": file === index ? "no-cache" : "public, max-age=31536000, immutable" };
    if (req.headers["if-none-match"]?.split(",").some((t) => t.trim() === file.etag)) return void res.writeHead(304, headers).end();
    res.writeHead(200, { ...headers, "content-type": file.type, "content-length": file.body.length });
    res.end(req.method === "HEAD" ? undefined : file.body);
  }
}

/** Reads the build under `dir` into memory: no dotfiles or dot-folders (the hosted site's .htaccess ships in dist). */
async function loadWebRoot(dir: string): Promise<WebRoot> {
  const files = new Map<string, WebFile>();
  let total = 0;
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const r = path.posix.join(rel, e.name);
      const abs = path.join(dir, r);
      if (e.isDirectory()) {
        await walk(r);
        continue;
      }
      // Symlinked files are followed, symlinked folders aren't (no loops).
      if (!e.isFile() && !(e.isSymbolicLink() && (await fs.stat(abs).catch(() => null))?.isFile())) continue;
      const body = await fs.readFile(abs);
      if (total + body.length > MAX_WEB_BYTES) {
        log.warn(`direct listener: web client over ${MAX_WEB_BYTES >> 20} MB, leaving out /${r}`);
        continue;
      }
      total += body.length;
      const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
      files.set(`/${r}`, { body, type: TYPES[path.extname(e.name)] ?? "application/octet-stream", etag });
    }
  };
  await walk("");
  return files.has("/index.html") ? files : null;
}

const lastSeen = new WeakMap<WebSocket, number>();

/**
 * The device's address for rate limits and the session list. Only local
 * processes reach a loopback port, so the proxy in front is the one trusted
 * hop: it appends the address it saw, the rightmost X-Forwarded-For entry.
 * Entries left of it are whatever the client sent.
 */
export function forwardedFor(req: http.IncomingMessage): string {
  return String(req.headers["x-forwarded-for"] ?? "").split(",").at(-1)?.trim() || req.socket.remoteAddress || "?";
}

function toBytes(data: RawData): Uint8Array<ArrayBuffer> {
  const b = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
  return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
}
