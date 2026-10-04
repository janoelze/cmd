// The session with the Mac: a WebSocket to the relay, the Noise handshake
// (@cmd/remote-crypto), then JSON-RPC over it with the same RpcClient the
// desktop uses. Reconnects with backoff, and right away when the page comes back
// (iOS freezes WebSockets in the background), then bootstraps again.

import { RpcClient, type CoreEvent, type Result } from "@cmd/protocol";
import { decodePairing, generateKeyPair, openDeviceSession, type Bytes, type KeyPair } from "@cmd/remote-crypto";
import { deviceName, saveIdentity, type Identity } from "./identity.ts";

export type Phase =
  | { kind: "connecting" }
  | { kind: "pairing"; words: string[] }
  | { kind: "online"; boot: Result<"remote.bootstrap"> }
  /** The Mac isn't reachable (asleep, remote access off, relay down). */
  | { kind: "offline"; since: number; reason: string }
  /** The Mac refused this browser's key: unpaired, or never paired. */
  | { kind: "refused" };

/** The relay's close code for a route with no Mac behind it. */
const UNAVAILABLE = 4404;

export class Connection {
  client: RpcClient | null = null;
  phase: Phase = { kind: "connecting" };
  #id: Identity;
  #ws: WebSocket | null = null;
  #listeners = new Set<() => void>();
  #events = new Set<(e: CoreEvent) => void>();
  #retry = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(id: Identity) {
    this.#id = id;
    const wake = () => document.visibilityState === "visible" && this.#ws === null && this.#connectNow();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("online", wake);
  }

  get identity(): Identity {
    return this.#id;
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  onEvent(fn: (e: CoreEvent) => void): () => void {
    this.#events.add(fn);
    return () => this.#events.delete(fn);
  }

  #set(p: Phase): void {
    this.phase = p;
    for (const fn of this.#listeners) fn();
  }

  start(): void {
    void this.#connect();
  }

  close(): void {
    this.#closed = true;
    this.#ws?.close();
  }

  #connectNow(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#retry = 0;
    void this.#connect();
  }

  async #connect(): Promise<void> {
    if (this.#closed || this.#ws) return;
    if (this.phase.kind !== "online" && this.phase.kind !== "offline") this.#set({ kind: "connecting" });
    const { ws, opened, session } = open(this.#id.relay, this.#id.route, { hostKey: this.#id.hostKey, device: this.#id.device });
    this.#ws = ws;
    let established = false;
    ws.addEventListener("close", async (e) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.client?.fail(new Error("disconnected"));
      this.client = null;
      if (this.#closed) return;
      // The relay reached the Mac, and the Mac hung up mid-handshake: it doesn't know this key.
      if ((await opened) && !established && e.code !== UNAVAILABLE) return this.#set({ kind: "refused" });
      this.#set({ kind: "offline", since: this.phase.kind === "offline" ? this.phase.since : Date.now(), reason: e.code === UNAVAILABLE ? "mac" : "network" });
      if (document.visibilityState === "visible") this.#timer = setTimeout(() => void this.#connect(), Math.min(30_000, 1000 * 2 ** this.#retry++));
    });
    try {
      const s = await session;
      established = true;
      const client = new RpcClient((line) => void s.send(line));
      s.onLine((l) => client.receive(l));
      client.onEvent((e) => this.#events.forEach((fn) => fn(e)));
      this.client = client;
      this.#retry = 0;
      this.#set({ kind: "online", boot: await client.call("remote.bootstrap", {}) });
    } catch {
      // the close handler says why
    }
  }
}

/** A relay channel and a device session on it; the handshake starts once the socket is open. */
function open(relay: string, route: string, o: { hostKey: Bytes; device: KeyPair; psk?: Bytes; onFingerprint?: (w: string[]) => void }) {
  const ws = new WebSocket(`${relay.replace(/\/+$/, "")}/r/${route}`);
  ws.binaryType = "arraybuffer";
  const opened = new Promise<boolean>((resolve) => {
    ws.addEventListener("open", () => resolve(true), { once: true });
    ws.addEventListener("close", () => resolve(false), { once: true });
  });
  const session = opened.then((ok) => {
    if (!ok) throw new Error("can't reach the relay");
    const d = openDeviceSession({
      socket: { send: (b) => ws.readyState === WebSocket.OPEN && ws.send(b), close: () => ws.close() },
      hostKey: o.hostKey,
      device: o.device,
      psk: o.psk,
      hello: { name: deviceName(), ua: navigator.userAgent },
      onFingerprint: o.onFingerprint,
    });
    ws.onmessage = (e) => d.receive(new Uint8Array(e.data as ArrayBuffer));
    ws.addEventListener("close", () => d.closed());
    return d.session;
  });
  session.catch(() => {});
  return { ws, opened, session };
}

/**
 * Pair from the link's fragment: a new non-extractable device key, the IKpsk1
 * handshake, the four words while the Mac decides. Saves the identity once the
 * Mac allowed it.
 */
export async function pair(fragment: string, onWords: (w: string[]) => void): Promise<Identity> {
  const link = decodePairing(fragment);
  const device = await generateKeyPair(false);
  const { ws, session } = open(link.relay, link.route, { hostKey: link.hostKey, device, psk: link.psk, onFingerprint: onWords });
  const s = await session.catch(() => {
    throw new Error("The Mac didn't allow this browser, or the code expired. Make a new one on your Mac.");
  });
  ws.close();
  const id: Identity = { device, hostKey: link.hostKey, relay: link.relay, route: link.route, deviceId: String(s.host.deviceId) };
  await saveIdentity(id);
  return id;
}
