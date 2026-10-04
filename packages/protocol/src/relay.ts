// The relay's host link (docs/13-remote-access.md, "Relay"): the core keeps one
// WebSocket to the relay and every device is a channel on it. The relay only
// forwards; what a channel carries is end-to-end encrypted (@cmd/remote-crypto).
//
// Host link (`/h`): first a JSON text message, `{ register: true }` → `{ route,
// secret }`, or `{ route, secret }` → `{ ok: true }`; then binary frames
// [u32 channel][u8 type][payload]. Device link (`/r/<route>`): binary messages,
// each one a channel's `data`.

export const RelayFrameType = {
  /** Relay → host: a device connected; payload: JSON { ip }. */
  open: 1,
  /** Either way: bytes for / from the channel's device. */
  data: 2,
  /** Either way: the channel is gone, or the host drops it. */
  close: 3,
} as const;
export type RelayFrameType = (typeof RelayFrameType)[keyof typeof RelayFrameType];

export interface RelayFrame {
  channel: number;
  type: RelayFrameType;
  payload: Uint8Array;
}

export const RELAY_LIMITS = {
  /** A device message: one Noise message (65535) plus its kind byte. */
  frameBytes: 64 * 1024 + 1,
  channelsPerRoute: 8,
  connectsPerIpPerMinute: 30,
  bufferedBytes: 1024 * 1024,
  pingMs: 25_000,
  idleMs: 90_000,
} as const;

/** Close codes the relay uses on device links. */
export const RelayClose = { unavailable: 4404, busy: 4429, tooLarge: 4413, forbidden: 4403 } as const;

export function encodeRelayFrame(f: RelayFrame): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(5 + f.payload.length);
  new DataView(out.buffer).setUint32(0, f.channel, false);
  out[4] = f.type;
  out.set(f.payload, 5);
  return out;
}

export function decodeRelayFrame(b: Uint8Array): RelayFrame {
  if (b.length < 5) throw new Error("short relay frame");
  const type = b[4];
  if (type !== RelayFrameType.open && type !== RelayFrameType.data && type !== RelayFrameType.close) throw new Error("bad relay frame type");
  return { channel: new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, false), type, payload: b.subarray(5) };
}
