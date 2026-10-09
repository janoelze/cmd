// The pairing link: https://CLIENT/pair#v1.<socket>.<route>.<host key>.<psk>,
// every field base64url. It lives in the URL fragment, which browsers never send
// to a server, so no log, proxy or analytics ever sees the PSK. The fields are
// positional: `socket` was called `relay` before there were direct modes, and
// only its TS name changed, so links made by either decode the same.

import { fromBase64Url, toBase64Url, utf8, type Bytes } from "./noise.ts";

export interface Pairing {
  /** The WebSocket base a device dials as `<socket>/r/<route>`: the relay (wss://relay.example.com) or this Mac's own address (wss://mac.tailnet.ts.net:8443). */
  socket: string;
  /** The host's mailbox on the relay, or its path on the direct listener (base64url, 16 bytes). */
  route: string;
  /** The host's static public key. */
  hostKey: Bytes;
  /** One-time pre-shared key, 32 bytes. */
  psk: Bytes;
}

export function encodePairing(p: Pairing): string {
  return ["v1", toBase64Url(utf8(p.socket)), p.route, toBase64Url(p.hostKey), toBase64Url(p.psk)].join(".");
}

/** Parses a fragment (with or without the leading #). Throws on anything malformed. */
export function decodePairing(fragment: string): Pairing {
  const [v, socket, route, hostKey, psk, ...rest] = fragment.replace(/^#/, "").split(".");
  if (v !== "v1" || !socket || !route || !hostKey || !psk || rest.length) throw new Error("not a cmd pairing link");
  const p = { socket: new TextDecoder().decode(fromBase64Url(socket)), route, hostKey: fromBase64Url(hostKey), psk: fromBase64Url(psk) };
  if (!/^wss?:\/\//.test(p.socket) || p.hostKey.length !== 32 || p.psk.length !== 32 || fromBase64Url(route).length !== 16) throw new Error("not a cmd pairing link");
  return p;
}
