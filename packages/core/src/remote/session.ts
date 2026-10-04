// One device's channel on the relay link, host side: the Noise handshake (IK for
// a paired device, IKpsk1 for pairing, which waits for the person on the Mac),
// then a Connection the core serves like a socket client. Its writer coalesces
// terminal output per pane and, when the device falls behind, drops it and asks
// the device to resync from a snapshot instead of buffering without bound.

import type { CoreEvent, RemoteScope } from "@cmd/protocol";
import { fingerprint, frame, Handshake, LineOpener, PROLOGUE, sealLine, unframe, utf8, Wire, type Bytes, type KeyPair, type Transport } from "@cmd/remote-crypto";
import type { Connection, Served } from "../connection.ts";

/** Merge a pane's output for this long before sending it. */
const COALESCE_MS = 30;
/** Pending output beyond this is dropped (the device resyncs). */
const MAX_PENDING = 1024 * 1024;

export interface ChannelHost {
  key: KeyPair;
  version: string;
  /** A paired device by its public key, or null. */
  device(publicKey: Bytes): { id: string; scope: RemoteScope } | null;
  /** The PSK of the pairing link in effect (consumed by the caller), or null. */
  takePairing(): { psk: Bytes; scope: RemoteScope } | null;
  /** Ask the person on the Mac; resolves with the scope to pair with, or null for no (or when `signal` aborts: the device left). */
  approve(name: string, words: string[], scope: RemoteScope, signal: AbortSignal): Promise<RemoteScope | null>;
  /** Store a newly paired device. */
  addDevice(name: string, publicKey: Bytes, scope: RemoteScope): { id: string };
  /** A handshake failed (wrong key, wrong PSK, junk). */
  failed(reason: string): void;
  /** The session is up: serve it. */
  serve(conn: Connection): Served;
  opened(session: HostChannel): void;
}

export class HostChannel {
  readonly channel: number;
  readonly ip: string;
  deviceId: string | null = null;
  scope: RemoteScope | null = null;
  #host: ChannelHost;
  #send: (b: Bytes) => void;
  #drop: () => void;
  #state: "hello" | "busy" | "open" | "closed" = "hello";
  #opener: LineOpener | null = null;
  #served: Served | null = null;
  #in: Promise<void> = Promise.resolve();
  #gone = new AbortController();

  constructor(o: { channel: number; ip: string; host: ChannelHost; send: (b: Bytes) => void; drop: () => void }) {
    this.channel = o.channel;
    this.ip = o.ip;
    this.#host = o.host;
    this.#send = o.send;
    this.#drop = o.drop;
  }

  /** A message from the device; processed strictly in order. Anything malformed ends the channel. */
  receive(msg: Bytes): void {
    this.#in = this.#in
      .then(() => this.#receive(msg))
      .catch((err: Error) => {
        if (this.#state !== "open") this.#host.failed(err.message);
        this.close();
      });
  }

  async #receive(msg: Bytes): Promise<void> {
    if (this.#state === "closed") return;
    const f = unframe(msg);
    if (this.#state === "open") {
      if (f.kind !== Wire.data) throw new Error("unexpected frame");
      const line = await this.#opener!.open(f.body);
      if (line !== null) this.#served?.receive(line);
      return;
    }
    if (this.#state !== "hello") throw new Error("message during the handshake");
    this.#state = "busy";
    if (f.kind === Wire.hello) await this.#session(f.body);
    else if (f.kind === Wire.pair) await this.#pair(f.body);
    else throw new Error("expected a handshake");
  }

  /** A paired device: IK, and its key must be on the list. */
  async #session(m1: Bytes): Promise<void> {
    const hs = await Handshake.create({ pattern: "IK", initiator: false, s: this.#host.key, prologue: PROLOGUE });
    await hs.readMessage(m1);
    const d = this.#host.device(hs.remoteStatic!);
    if (!d) throw new Error("unknown device key");
    await this.#open(hs, d.id, d.scope);
  }

  /** Pairing: the QR's PSK (single use), then the person on the Mac decides. */
  async #pair(m1: Bytes): Promise<void> {
    const pairing = this.#host.takePairing();
    if (!pairing) throw new Error("no pairing in progress");
    const hs = await Handshake.create({ pattern: "IKpsk1", initiator: false, s: this.#host.key, psk: pairing.psk, prologue: PROLOGUE });
    const hello = parseHello(await hs.readMessage(m1));
    const scope = await this.#host.approve(hello.name, fingerprint(hs.hash), pairing.scope, this.#gone.signal);
    if (this.#state === "closed") return;
    if (!scope) return this.close(); // the person said no: not a failed handshake
    const { id } = this.#host.addDevice(hello.name, hs.remoteStatic!, scope);
    await this.#open(hs, id, scope);
  }

  async #open(hs: Handshake, deviceId: string, scope: RemoteScope): Promise<void> {
    this.#send(frame(Wire.reply, await hs.writeMessage(utf8(JSON.stringify({ deviceId, scope, version: this.#host.version })))));
    const t = await hs.transport();
    this.#opener = new LineOpener(t);
    this.deviceId = deviceId;
    this.scope = scope;
    this.#state = "open";
    this.#served = this.#host.serve(new RemoteConnection(t, scope, deviceId, (b) => this.#send(b), () => this.close()));
    this.#host.opened(this);
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#gone.abort();
    this.#served?.closed();
    this.#drop();
  }

  get open(): boolean {
    return this.#state === "open";
  }
}

function parseHello(b: Bytes): { name: string } {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder().decode(b));
  } catch {
    v = null;
  }
  const name = (v as { name?: unknown } | null)?.name;
  return { name: typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : "Unknown browser" };
}

/** The session as the core sees it. */
class RemoteConnection implements Connection {
  readonly access: RemoteScope;
  readonly deviceId: string;
  #t: Transport;
  #send: (b: Bytes) => void;
  #close: () => void;
  #out: Promise<void> = Promise.resolve();
  /** Output waiting to be merged, per pane, in arrival order. */
  #pending = new Map<string, string>();
  #pendingBytes = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(t: Transport, access: RemoteScope, deviceId: string, send: (b: Bytes) => void, close: () => void) {
    this.#t = t;
    this.access = access;
    this.deviceId = deviceId;
    this.#send = send;
    this.#close = close;
  }

  send(line: string): void {
    const t = this.#t;
    this.#out = this.#out
      .then(async () => {
        for (const f of await sealLine(t, line.replace(/\n$/, ""))) this.#send(f);
      })
      .catch(() => this.#close());
  }

  event(e: CoreEvent, line: string): void {
    if (e.type !== "pane.output") {
      this.#flush(); // keep output ahead of what follows it
      this.send(line);
      return;
    }
    this.#pending.set(e.paneId, (this.#pending.get(e.paneId) ?? "") + e.data);
    this.#pendingBytes += e.data.length;
    if (this.#pendingBytes > MAX_PENDING) {
      const panes = [...this.#pending.keys()];
      this.#pending.clear();
      this.#pendingBytes = 0;
      for (const paneId of panes) this.send(eventLine({ type: "pane.resync", paneId }));
      return;
    }
    this.#timer ??= setTimeout(() => this.#flush(), COALESCE_MS);
  }

  #flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    for (const [paneId, data] of this.#pending) this.send(eventLine({ type: "pane.output", paneId, data }));
    this.#pending.clear();
    this.#pendingBytes = 0;
  }

  close(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#close();
  }
}

const eventLine = (e: CoreEvent) => JSON.stringify({ jsonrpc: "2.0", method: "event", params: e });
