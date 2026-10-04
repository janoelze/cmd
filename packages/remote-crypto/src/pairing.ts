// The pairing link: https://CLIENT/pair#v1.<relay>.<route>.<host key>.<psk>,
// every field base64url. It lives in the URL fragment, which browsers never send
// to a server, so no log, proxy or analytics ever sees the PSK.

import { fromBase64Url, toBase64Url, utf8, type Bytes } from "./noise.ts";

export interface Pairing {
  /** The relay's WebSocket base URL, e.g. wss://relay.example.com */
  relay: string;
  /** The host's mailbox on the relay (base64url, 16 bytes). */
  route: string;
  /** The host's static public key. */
  hostKey: Bytes;
  /** One-time pre-shared key, 32 bytes. */
  psk: Bytes;
}

export function encodePairing(p: Pairing): string {
  return ["v1", toBase64Url(utf8(p.relay)), p.route, toBase64Url(p.hostKey), toBase64Url(p.psk)].join(".");
}

/** Parses a fragment (with or without the leading #). Throws on anything malformed. */
export function decodePairing(fragment: string): Pairing {
  const [v, relay, route, hostKey, psk, ...rest] = fragment.replace(/^#/, "").split(".");
  if (v !== "v1" || !relay || !route || !hostKey || !psk || rest.length) throw new Error("not a cmd pairing link");
  const p = { relay: new TextDecoder().decode(fromBase64Url(relay)), route, hostKey: fromBase64Url(hostKey), psk: fromBase64Url(psk) };
  if (!/^wss?:\/\//.test(p.relay) || p.hostKey.length !== 32 || p.psk.length !== 32 || fromBase64Url(route).length !== 16) throw new Error("not a cmd pairing link");
  return p;
}
