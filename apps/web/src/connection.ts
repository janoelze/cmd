// The session with the Mac: a WebSocket to the relay or to the Mac itself, the
// Noise handshake (@cmd/remote-crypto), then JSON-RPC over it with the same
// RpcClient the desktop uses. Reconnects with backoff, and right away when the page comes back
// (iOS freezes WebSockets in the background), then bootstraps again. An attempt that hangs
// (iOS right after a network change, a VPN coming back: the socket neither opens nor closes)
// is given up at a deadline: 8 s for the handshake, then 30 s without a byte until the
// bootstrap is in (a big one on a slow link keeps arriving). Coming back or online again
// drops a hung attempt at once, and checks that an established session still answers (a half-open socket looks online but is dead). Each
// session checks this device's notifications (push.ts) and tells the Mac
// whether the page is in front, so it doesn't push what the page shows.

import { RelayClose, RpcClient, type CoreEvent, type Result } from "@cmd/protocol";
import { decodePairing, generateKeyPair, openDeviceSession, type Bytes, type KeyPair } from "@cmd/remote-crypto";
import { deviceName, loadIdentity, macKey, saveIdentity, touchIdentity, type Identity } from "./identity.ts";
import { syncPush } from "./push.ts";

export type Phase =
  | { kind: "connecting" }
  | { kind: "pairing"; words: string[] }
  | { kind: "online"; boot: Result<"remote.bootstrap"> }
  /** The Mac isn't reachable (mac: asleep, remote access off; busy: too many devices, or it isn't ready; network: anything else). */
  | { kind: "offline"; since: number; reason: "mac" | "busy" | "network" }
  /** The Mac refused this browser's key: unpaired, or never paired. */
  | { kind: "refused" };

/** Why the socket closed, as the phase it leaves the page in. */
function closed(code: number, since: number): Phase {
  const reason = code === RelayClose.unavailable ? "mac" : code === RelayClose.busy || code === RelayClose.later ? "busy" : "network";
  return { kind: "offline", since, reason };
}

/** From the socket opening to the Noise session established (what hangs on iOS): past this an attempt is given up and tried again. */
export const ATTEMPT_MS = 8000;
/** After the handshake, until the bootstrap is answered: this long without a byte arriving gives up (a big bootstrap on a slow link keeps it alive). */
export const SILENT_MS = 30_000;
/** An attempt this young is left to finish when the page comes back. */
const FRESH_MS = 1000;
/** How long an established session gets to answer when the page comes back. */
export const PING_MS = 4000;
/** The longest wait between attempts: only while the page is in front (someone is looking); hidden, it waits to come back. */
export const BACKOFF_VISIBLE_MS = 10_000;

/** What opens a channel to the Mac (open() below; a fake in tests). */
export type Opener = typeof open;

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
  #open: Opener;
  /** The session is up: handshake done and the bootstrap answered. */
  #ready = false;
  #deadline: ReturnType<typeof setTimeout> | null = null;
  #pinging = false;
  /** When the attempt in flight began: coming back fires several events (visibilitychange, pageshow), and the second mustn't drop the attempt the first just made. */
  #attemptAt = 0;
  /** Back in front, or online again: a hung attempt is dropped for a new one; a live session is asked whether it still answers. */
  #wake = (e?: Event) => {
    this.#visible();
    if (this.#closed || document.visibilityState !== "visible") return;
    if (this.#ws && this.#ready) return void this.#check();
    // Online again: the network changed, so even a fresh attempt went out on the old one.
    if (this.#ws && e?.type !== "online" && Date.now() - this.#attemptAt < FRESH_MS) return;
    if (this.#ws) this.#abandon(this.#ws);
    this.#connectNow();
  };
  /** Tell the Mac whether this page is in front (cores before push don't know the call). */
  #visible = () => {
    if (this.phase.kind === "online" && this.phase.boot.push) void this.client?.call("push.visible", { visible: document.visibilityState === "visible" }).catch(() => {});
  };

  constructor(id: Identity, opener: Opener = open) {
    this.#id = id;
    this.#open = opener;
    document.addEventListener("visibilitychange", this.#wake);
    window.addEventListener("pageshow", this.#wake);
    window.addEventListener("online", this.#wake);
  }

  get identity(): Identity {
    return this.#id;
  }

  /** The Mac's host key in base64url, as the identity store keys it. */
  get key(): string {
    return macKey(this.#id.hostKey);
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
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#deadline) clearTimeout(this.#deadline);
    document.removeEventListener("visibilitychange", this.#wake);
    window.removeEventListener("pageshow", this.#wake);
    window.removeEventListener("online", this.#wake);
    this.#ws?.close();
  }

  /** Try again now ("Not paired anymore" doesn't retry by itself: the Mac counts each refusal as a failed attempt). */
  retry(): void {
    if (this.phase.kind === "refused") this.#set({ kind: "connecting" });
    if (this.#ws && !this.#ready) this.#abandon(this.#ws);
    this.#connectNow();
  }

  /** The next attempt, with backoff (shorter while the page is in front). */
  #schedule(): void {
    if (this.#closed || document.visibilityState !== "visible") return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#connect(), Math.min(BACKOFF_VISIBLE_MS, 1000 * 2 ** this.#retry++));
  }

  /** Give up on this socket now, without waiting for its close (a hung one may never fire it): offline, then the usual retry. */
  #abandon(ws: WebSocket): void {
    if (this.#ws !== ws) return;
    this.#ws = null;
    this.#ready = false;
    if (this.#deadline) clearTimeout(this.#deadline);
    this.client?.fail(new Error("disconnected"));
    this.client = null;
    try {
      ws.close();
    } catch {}
    if (this.#closed) return;
    this.#set(closed(1006, this.phase.kind === "offline" ? this.phase.since : Date.now()));
    this.#schedule();
  }

  /** An established session answers a cheap call quickly, or it's dropped and connected again. */
  #check(): void {
    const ws = this.#ws;
    const client = this.client;
    if (!ws || !client || this.#pinging) return;
    this.#pinging = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), PING_MS)));
    void Promise.race([client.call("core.hello", {}).then(() => "ok" as const, () => "late" as const), late]).then((r) => {
      clearTimeout(timer);
      this.#pinging = false;
      if (r === "late" && this.#ws === ws) {
        this.#abandon(ws);
        this.#connectNow();
      }
    });
  }

  #connectNow(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#retry = 0;
    void this.#connect();
  }

  async #connect(): Promise<void> {
    if (this.#closed || this.#ws) return;
    if (this.phase.kind !== "online" && this.phase.kind !== "offline") this.#set({ kind: "connecting" });
    const { ws, opened, session } = this.#open(this.#id.socket, this.#id.route, { hostKey: this.#id.hostKey, device: this.#id.device });
    this.#ws = ws;
    this.#ready = false;
    this.#attemptAt = Date.now();
    let established = false;
    if (this.#deadline) clearTimeout(this.#deadline);
    this.#deadline = setTimeout(() => this.#abandon(ws), ATTEMPT_MS);
    ws.addEventListener("close", async (e) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#ready = false;
      if (this.#deadline) clearTimeout(this.#deadline);
      this.client?.fail(new Error("disconnected"));
      this.client = null;
      if (this.#closed) return;
      // The Mac hung up cleanly mid-handshake: it doesn't know this key. Anything else (the relay
      // busy, the Mac not ready or gone, the network) is worth another try.
      if ((await opened) && !established && e.code === 1000) return this.#set({ kind: "refused" });
      this.#set(closed(e.code, this.phase.kind === "offline" ? this.phase.since : Date.now()));
      this.#schedule();
    });
    try {
      const s = await session;
      if (this.#ws !== ws) return; // given up meanwhile
      established = true;
      // Handshake done: hello, ack and bootstrap may take a while on a slow link, as long as bytes keep coming.
      const silent = () => {
        if (this.#ws !== ws || this.#ready) return;
        if (this.#deadline) clearTimeout(this.#deadline);
        this.#deadline = setTimeout(() => this.#abandon(ws), SILENT_MS);
      };
      silent();
      ws.addEventListener("message", silent);
      const client = new RpcClient((line) => void s.send(line));
      // What was read, acked every 64 KiB (remote.ack): the Mac holds output past a window instead of the relay dropping a slow phone.
      let received = 0;
      let acked = 0;
      s.onLine((l) => {
        received += l.length + 1;
        client.receive(l);
        if (received - acked >= 65_536 && client.has("remote.ack")) (acked = received), void client.call("remote.ack", { received }).catch(() => {});
      });
      // Events during the bootstrap wait for it, then replay in order on top of it: those before its reply are
      // already in it (each carries a whole object, so again changes nothing), those after would be lost under it.
      let held: CoreEvent[] | null = [];
      const emit = (e: CoreEvent) => this.#events.forEach((fn) => fn(e));
      client.onEvent((e) => (held ? held.push(e) : emit(e)));
      this.client = client;
      // What the Mac serves, so client.has() can tell a feature its cmd doesn't have yet (a Mac without the list has all of them).
      await client.hello().catch(() => {});
      // The first ack turns the window on for this session (a Mac without remote.ack has none).
      if (client.has("remote.ack") && client.core?.methods) void client.call("remote.ack", { received }).catch(() => {});
      const boot = await client.call("remote.bootstrap", {}).catch((err: Error) => {
        held = null;
        throw err;
      });
      if (this.#ws !== ws) return; // given up meanwhile
      if (this.#deadline) clearTimeout(this.#deadline);
      this.#ready = true;
      this.#retry = 0;
      this.#set({ kind: "online", boot });
      for (const e of held.splice(0)) emit(e);
      held = null;
      this.#visible();
      void syncPush(this, boot.push).catch((err: Error) => console.warn(`notifications: ${err.message}`));
      // The name a list of Macs shows; it follows a renamed Mac.
      const name = boot.host?.name;
      if (name && name !== this.#id.name) void touchIdentity(this.key, { name }).then(() => (this.#id = { ...this.#id, name }), () => {});
    } catch {
      // the close handler says why
    }
  }
}

/** A channel to the Mac (through the relay or straight to it) and a device session on it; the handshake starts once the socket is open. */
function open(socket: string, route: string, o: { hostKey: Bytes; device: KeyPair; psk?: Bytes; onFingerprint?: (w: string[]) => void }) {
  const ws = new WebSocket(`${socket.replace(/\/+$/, "")}/r/${route}`);
  ws.binaryType = "arraybuffer";
  const opened = new Promise<boolean>((resolve) => {
    ws.addEventListener("open", () => resolve(true), { once: true });
    ws.addEventListener("close", () => resolve(false), { once: true });
  });
  const session = opened.then((ok) => {
    if (!ok) throw new Error("can't reach the Mac");
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
 * Pair from the link's fragment: a new device key, the IKpsk1 handshake, the
 * four words while the Mac decides. Saves the identity once the Mac allowed it
 * (replacing an earlier pairing with the same Mac) and returns it as loaded
 * back, so a browser that can't keep it says so now.
 */
export async function pair(fragment: string, onWords: (w: string[]) => void): Promise<Identity> {
  const link = decodePairing(fragment);
  const device = await generateKeyPair(true);
  const { ws, session } = open(link.socket, link.route, { hostKey: link.hostKey, device, psk: link.psk, onFingerprint: onWords });
  const s = await session.catch(() => {
    throw new Error("The Mac didn't allow this browser, or the code expired. Make a new one on your Mac.");
  });
  ws.close();
  const id: Identity = { device, hostKey: link.hostKey, socket: link.socket, route: link.route, deviceId: String(s.host.deviceId) };
  await saveIdentity(id);
  const saved = await loadIdentity(macKey(id.hostKey));
  if (!saved) throw new Error("This browser couldn't save the pairing. Make a new code on your Mac and try again.");
  // Best effort: ask the browser not to clear it under storage pressure.
  void navigator.storage?.persist?.().catch(() => {});
  return saved;
}
