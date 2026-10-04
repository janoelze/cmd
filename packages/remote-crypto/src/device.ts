// The device's side of a channel (the web client, and tests): run the handshake
// over any byte socket, then send and receive JSON-RPC lines. The host's side
// lives in the core (packages/core/src/remote/session.ts).

import { frame, LineOpener, PROLOGUE, sealLine, unframe, Wire } from "./channel.ts";
import { Handshake, utf8, type Bytes, type KeyPair, type Transport } from "./noise.ts";
import { fingerprint } from "./words.ts";

/** A connected relay channel (a WebSocket to /r/<route>), as bytes. */
export interface ByteSocket {
  send(b: Bytes): void;
  close(): void;
}

export interface DeviceSessionOptions {
  socket: ByteSocket;
  /** The host's static key, from the pairing link (then stored by the client). */
  hostKey: Bytes;
  /** This device's static key (non-extractable in the browser). */
  device: KeyPair;
  /** Pairing: the QR's PSK; omitted for a paired device's session. */
  psk?: Bytes;
  /** Told to the host in message 1, e.g. { name: "Safari on iPhone" }. */
  hello?: Record<string, unknown>;
  /** Pairing: the four words to show while the Mac asks for approval. */
  onFingerprint?: (words: string[]) => void;
}

/** A session after the handshake. */
export interface DeviceSession {
  /** What the host answered in message 2 (e.g. { deviceId, version }). */
  host: Record<string, unknown>;
  send(line: string): Promise<void>;
  onLine(fn: (line: string) => void): void;
  close(): void;
}

/**
 * Starts the handshake and returns feeds for the socket's incoming messages and
 * its closing, plus the session, which resolves once the host replies (pairing:
 * after the person on the Mac allowed it) and rejects if the socket closes first.
 */
export function openDeviceSession(o: DeviceSessionOptions): { receive: (msg: Bytes) => void; closed: () => void; session: Promise<DeviceSession> } {
  let receive: (msg: Bytes) => void = () => {};
  let closed: () => void = () => {};
  const session = (async () => {
    const hs = await Handshake.create({ pattern: o.psk ? "IKpsk1" : "IK", initiator: true, s: o.device, rs: o.hostKey, psk: o.psk, prologue: PROLOGUE });
    const reply = new Promise<Bytes>((resolve, reject) => {
      closed = () => reject(new Error("the host closed the channel"));
      receive = (msg) => {
        try {
          const f = unframe(msg);
          if (f.kind !== Wire.reply) throw new Error("expected the host's reply");
          resolve(f.body);
        } catch (err) {
          reject(err);
        }
      };
    });
    const m1 = await hs.writeMessage(utf8(JSON.stringify(o.hello ?? {})));
    o.onFingerprint?.(fingerprint(hs.hash));
    o.socket.send(frame(o.psk ? Wire.pair : Wire.hello, m1));
    const host = JSON.parse(new TextDecoder().decode(await hs.readMessage(await reply))) as Record<string, unknown>;
    const t = await hs.transport();
    return established(o.socket, t, host, (fn) => (receive = fn));
  })();
  return { receive: (msg) => receive(msg), closed: () => closed(), session };
}

function established(socket: ByteSocket, t: Transport, host: Record<string, unknown>, setReceive: (fn: (msg: Bytes) => void) => void): DeviceSession {
  const opener = new LineOpener(t);
  const listeners: ((line: string) => void)[] = [];
  // Decrypt strictly in order; a bad message ends the session.
  let chain = Promise.resolve();
  setReceive((msg) => {
    chain = chain.then(async () => {
      const f = unframe(msg);
      if (f.kind !== Wire.data) throw new Error("unexpected frame");
      const line = await opener.open(f.body);
      if (line !== null) for (const fn of listeners) fn(line);
    }).catch(() => socket.close());
  });
  return {
    host,
    send: async (line) => {
      for (const f of await sealLine(t, line)) socket.send(f);
    },
    onLine: (fn) => void listeners.push(fn),
    close: () => socket.close(),
  };
}
