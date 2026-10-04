// The core's one connection to the relay (protocol: @cmd/protocol relay.ts).
// Outbound only, over Node's built-in WebSocket client. Registers a route the
// first time, then authenticates with it; reconnects with backoff; multiplexes
// every device's channel.

import { EventEmitter } from "node:events";
import { decodeRelayFrame, encodeRelayFrame, RelayFrameType } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";

const log = logger("remote");

export type LinkState = "connecting" | "online" | "error";

export interface RelayLinkOptions {
  relay: string;
  route: string | null;
  secret: string | null;
  /** The relay gave this host a route: keep it. */
  onRegistered: (route: string, secret: string) => void;
}

export class RelayLink extends EventEmitter<{
  state: [LinkState, string | null];
  open: [channel: number, ip: string];
  data: [channel: number, bytes: Uint8Array<ArrayBuffer>];
  close: [channel: number];
}> {
  #o: RelayLinkOptions;
  #ws: WebSocket | null = null;
  #closed = false;
  #retry = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  state: LinkState = "connecting";
  error: string | null = null;

  constructor(o: RelayLinkOptions) {
    super();
    this.#o = o;
  }

  get route(): string | null {
    return this.#o.route;
  }

  start(): void {
    this.#connect();
  }

  send(channel: number, payload: Uint8Array): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(encodeRelayFrame({ channel, type: RelayFrameType.data, payload }));
  }

  closeChannel(channel: number): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(encodeRelayFrame({ channel, type: RelayFrameType.close, payload: new Uint8Array(0) }));
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#ws?.close(1000);
    this.#ws = null;
  }

  #setState(s: LinkState, error: string | null = null): void {
    if (s === this.state && error === this.error) return;
    this.state = s;
    this.error = error;
    this.emit("state", s, error);
  }

  #connect(): void {
    if (this.#closed) return;
    this.#setState("connecting", this.error);
    let ws: WebSocket;
    try {
      ws = new WebSocket(new URL("/h", this.#o.relay));
    } catch (err) {
      this.#setState("error", `bad relay URL: ${(err as Error).message}`);
      return;
    }
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    let authed = false;
    const channels = new Set<number>();
    ws.onopen = () => {
      ws.send(JSON.stringify(this.#o.route && this.#o.secret ? { route: this.#o.route, secret: this.#o.secret } : { register: true }));
    };
    ws.onmessage = (ev) => {
      if (!authed) {
        if (typeof ev.data !== "string") return;
        const msg = JSON.parse(ev.data) as { ok?: boolean; route?: string; secret?: string };
        if (msg.route && msg.secret) {
          this.#o = { ...this.#o, route: msg.route, secret: msg.secret };
          this.#o.onRegistered(msg.route, msg.secret);
        } else if (!msg.ok) return;
        authed = true;
        this.#retry = 0;
        log.info(`relay link up (${this.#o.relay})`);
        this.#setState("online");
        return;
      }
      if (!(ev.data instanceof ArrayBuffer)) return;
      let f;
      try {
        f = decodeRelayFrame(new Uint8Array(ev.data));
      } catch {
        return;
      }
      if (f.type === RelayFrameType.open) {
        channels.add(f.channel);
        let ip = "?";
        try {
          ip = String((JSON.parse(new TextDecoder().decode(f.payload)) as { ip?: string }).ip ?? "?");
        } catch {}
        this.emit("open", f.channel, ip);
      } else if (f.type === RelayFrameType.data) {
        if (channels.has(f.channel)) this.emit("data", f.channel, new Uint8Array(f.payload));
      } else if (channels.delete(f.channel)) this.emit("close", f.channel);
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      for (const ch of channels) this.emit("close", ch);
      channels.clear();
      if (this.#ws !== ws || this.#closed) return;
      this.#ws = null;
      // 4403: the relay refused our route's secret; register a new route next time.
      if (ev.code === 4403 && this.#o.route) {
        log.warn("the relay refused this host's route; registering a new one (paired devices must pair again)");
        this.#o = { ...this.#o, route: null, secret: null };
      }
      const delay = Math.min(60_000, 1000 * 2 ** this.#retry++) * (0.8 + Math.random() * 0.4);
      this.#setState("error", authed ? "lost the relay; reconnecting" : `can't reach the relay (${ev.code || "no connection"})`);
      this.#timer = setTimeout(() => this.#connect(), delay);
    };
  }
}
