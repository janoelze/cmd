// What travels inside a relay channel: a kind byte, then a Noise message. After
// the handshake every DATA message carries one chunk of a JSON-RPC line (the
// same lines the Unix socket carries); a line longer than one Noise message is
// split, with a flag byte saying whether more chunks follow.

import { concat, MAX_PLAINTEXT, type Bytes, type Transport } from "./noise.ts";

export const Wire = {
  /** Device → host: IK message 1 (a paired device starting a session). */
  hello: 1,
  /** Device → host: IKpsk1 message 1 (pairing with the QR's PSK). */
  pair: 2,
  /** Host → device: message 2 of either handshake. */
  reply: 3,
  /** Either way: a transport message. */
  data: 4,
} as const;
export type WireKind = (typeof Wire)[keyof typeof Wire];

/** Everything a device and a host say during the handshake and in payloads, versioned. */
export const PROLOGUE = new TextEncoder().encode("cmd-remote/1") as Bytes;

export function frame(kind: WireKind, body: Bytes): Bytes {
  return concat(Uint8Array.of(kind), body);
}

export function unframe(msg: Bytes): { kind: WireKind; body: Bytes } {
  const kind = msg[0];
  if (kind !== Wire.hello && kind !== Wire.pair && kind !== Wire.reply && kind !== Wire.data) throw new Error("bad frame");
  return { kind, body: msg.slice(1) };
}

const MORE = 1;
const CHUNK = MAX_PLAINTEXT - 1;
/** A line larger than this (after reassembly) drops the channel. */
export const MAX_LINE = 16 * 1024 * 1024;

/** One line → the DATA frames that carry it. */
export async function sealLine(t: Transport, line: string): Promise<Bytes[]> {
  const b = new TextEncoder().encode(line) as Bytes;
  if (b.length > MAX_LINE) throw new Error("line too long");
  const parts: Promise<Bytes>[] = [];
  for (let off = 0; off === 0 || off < b.length; off += CHUNK) {
    const end = Math.min(off + CHUNK, b.length);
    parts.push(t.encrypt(concat(Uint8Array.of(end < b.length ? MORE : 0), b.slice(off, end))).then((ct) => frame(Wire.data, ct)));
  }
  return Promise.all(parts);
}

/** Reassembles lines from DATA frame bodies, in arrival order. */
export class LineOpener {
  #t: Transport;
  #parts: Bytes[] = [];
  #size = 0;
  #decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(t: Transport) {
    this.#t = t;
  }

  /** The line this message completes, or null if more chunks follow. Throws on tampering. */
  async open(body: Bytes): Promise<string | null> {
    const pt = await this.#t.decrypt(body);
    if (pt.length < 1) throw new Error("empty message");
    this.#parts.push(pt.slice(1));
    this.#size += pt.length - 1;
    if (this.#size > MAX_LINE) throw new Error("line too long");
    if (pt[0] === MORE) return null;
    const line = this.#decoder.decode(concat(...this.#parts));
    this.#parts = [];
    this.#size = 0;
    return line;
  }
}
