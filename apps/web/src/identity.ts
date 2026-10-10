// This browser's pairing with one Mac, kept in IndexedDB: the device's X25519
// key wrapped by a non-extractable AES key, the Mac's public key, and where to
// reach it. WebKit stores an X25519 CryptoKey but reads it back as null (the
// whole record), so the key is kept wrapped and unwrapped non-extractable on
// load. Nothing secret is ever in a URL after pairing. Pairings saved before
// direct modes keep the socket as `relay`; loading reads it as `socket`, and
// ones saved with the bare CryptoKey (Chromium) still load.

import type { KeyPair } from "@cmd/remote-crypto";

const subtle = globalThis.crypto.subtle;

export interface Identity {
  device: KeyPair;
  hostKey: Uint8Array<ArrayBuffer>;
  /** The WebSocket base it dials (Pairing.socket): the relay, or the Mac's own address. */
  socket: string;
  route: string;
  deviceId: string;
}

const DB = "cmd-remote";
const STORE = "identity";
const KEY = "mac";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** As stored: the device key wrapped (`wrapped` under `wrapKey`), or a bare CryptoKey from before. */
interface Stored extends Omit<Identity, "device" | "socket"> {
  socket?: string;
  relay?: string;
  device?: KeyPair;
  wrapKey?: CryptoKey;
  iv?: Uint8Array<ArrayBuffer>;
  wrapped?: Uint8Array<ArrayBuffer>;
  publicKey?: Uint8Array<ArrayBuffer>;
}

const AES = (iv: Uint8Array<ArrayBuffer>) => ({ name: "AES-GCM", iv });

export async function loadIdentity(): Promise<Identity | undefined> {
  const d = await tx<Stored | undefined>("readonly", (s) => s.get(KEY));
  if (!d) return undefined;
  const { relay, socket, device, wrapKey, iv, wrapped, publicKey, ...rest } = d;
  let kp = device;
  if (wrapKey && iv && wrapped && publicKey) {
    const privateKey = await subtle.unwrapKey("pkcs8", wrapped, wrapKey, AES(iv), { name: "X25519" }, false, ["deriveBits"]);
    kp = { privateKey, publicKey };
  }
  if (!kp) return undefined;
  return { ...rest, device: kp, socket: socket ?? relay ?? "" };
}

/** Saves a pairing; the device key must be extractable (it is wrapped, never stored readable). */
export async function saveIdentity(id: Identity): Promise<void> {
  const { device, ...rest } = id;
  const wrapKey = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(await subtle.wrapKey("pkcs8", device.privateKey, wrapKey, AES(iv)));
  const stored: Stored = { ...rest, wrapKey, iv, wrapped, publicKey: device.publicKey };
  await tx("readwrite", (s) => s.put(stored, KEY));
}
export const forgetIdentity = () => tx("readwrite", (s) => s.delete(KEY)).then(() => {});

/** What the Mac shows in its approval sheet. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad|Macintosh.*Mobile/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  const browser = /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "a computer";
  return `${browser} on ${os}`;
}
