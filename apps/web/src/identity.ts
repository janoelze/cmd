// This browser's pairing with one Mac, kept in IndexedDB: the device's X25519
// key as a non-extractable CryptoKey (script can use it, never read it), the
// Mac's public key, and where to reach it. Nothing secret is ever in a URL
// after pairing. Pairings saved before direct modes keep the socket as `relay`;
// loading reads it as `socket`, so those phones stay paired.

import type { KeyPair } from "@cmd/remote-crypto";

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

export const loadIdentity = () =>
  tx<(Omit<Identity, "socket"> & { socket?: string; relay?: string }) | undefined>("readonly", (s) => s.get(KEY)).then((d): Identity | undefined => {
    if (!d) return undefined;
    const { relay, socket, ...rest } = d;
    return { ...rest, socket: socket ?? relay ?? "" };
  });
export const saveIdentity = (id: Identity) => tx("readwrite", (s) => s.put(id, KEY)).then(() => {});
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
