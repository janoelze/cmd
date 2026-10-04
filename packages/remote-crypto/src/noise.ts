// Noise (noiseprotocol.org, rev 34) over WebCrypto: X25519, AES-256-GCM,
// SHA-256/HKDF. No dependencies and no node: imports, so the core and the web
// client share it. Patterns (docs/13-remote-access.md): IK for sessions, IKpsk1
// for pairing (the PSK is checked on message 1, before the Mac asks anyone).

export type Bytes = Uint8Array<ArrayBuffer>;
export type Pattern = "IK" | "IKpsk1";

const subtle = globalThis.crypto.subtle;
const DHLEN = 32;
const TAGLEN = 16;
/** Noise's limit for any message, handshake or transport. */
export const MAX_MESSAGE = 65535;
export const MAX_PLAINTEXT = MAX_MESSAGE - TAGLEN;
/** Both sides rekey (Noise REKEY) after this many messages in a direction. */
const REKEY_EVERY = 2n ** 20n;
const MAX_NONCE = 2n ** 64n - 1n;

const PROTOCOL: Record<Pattern, string> = {
  IK: "Noise_IK_25519_AESGCM_SHA256",
  IKpsk1: "Noise_IKpsk1_25519_AESGCM_SHA256",
};
type Token = "e" | "s" | "ee" | "es" | "se" | "ss" | "psk";
const MESSAGES: Record<Pattern, [Token[], Token[]]> = {
  IK: [["e", "es", "s", "ss"], ["e", "ee", "se"]],
  IKpsk1: [["e", "es", "s", "ss", "psk"], ["e", "ee", "se"]],
};

export interface KeyPair {
  /** Non-extractable unless created with extractable (the host's, to persist it). */
  privateKey: CryptoKey;
  publicKey: Bytes;
}

export async function generateKeyPair(extractable = false): Promise<KeyPair> {
  const kp = (await subtle.generateKey({ name: "X25519" }, extractable, ["deriveBits"])) as CryptoKeyPair;
  return { privateKey: kp.privateKey, publicKey: new Uint8Array(await subtle.exportKey("raw", kp.publicKey)) };
}

/** JWK of an extractable key pair, for storage. */
export async function exportKeyPair(kp: KeyPair): Promise<JsonWebKey> {
  return subtle.exportKey("jwk", kp.privateKey);
}

export async function importKeyPair(jwk: JsonWebKey): Promise<KeyPair> {
  if (!jwk.x) throw new Error("not an X25519 private key");
  const privateKey = await subtle.importKey("jwk", jwk, { name: "X25519" }, false, ["deriveBits"]);
  return { privateKey, publicKey: fromBase64Url(jwk.x) };
}

/** A key pair from a raw 32-byte X25519 private key (wrapped as PKCS#8 for WebCrypto). */
export async function importPrivateKey(raw: Bytes, extractable = false): Promise<KeyPair> {
  const pkcs8 = concat(bytes([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]), raw);
  const k = await subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, true, ["deriveBits"]);
  const jwk = await subtle.exportKey("jwk", k);
  return extractable ? { privateKey: k, publicKey: fromBase64Url(jwk.x!) } : importKeyPair(jwk);
}

async function dh(priv: CryptoKey, pub: Bytes): Promise<Bytes> {
  const key = await subtle.importKey("raw", pub, { name: "X25519" }, true, []);
  return new Uint8Array(await subtle.deriveBits({ name: "X25519", public: key }, priv, DHLEN * 8));
}

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle.digest("SHA-256", data));
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, data));
}

async function hkdf(ck: Bytes, ikm: Bytes, n: 2 | 3): Promise<Bytes[]> {
  const temp = await hmac(ck, ikm);
  const out = [await hmac(temp, bytes([1]))];
  out.push(await hmac(temp, concat(out[0]!, bytes([2]))));
  if (n === 3) out.push(await hmac(temp, concat(out[1]!, bytes([3]))));
  return out;
}

function nonce(n: bigint): Bytes {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, n, false);
  return iv;
}

const importAes = (k: Bytes) => subtle.importKey("raw", k, "AES-GCM", false, ["encrypt", "decrypt"]);

/**
 * A key and its nonce. Calls are serialized: ciphertexts come out (and must be
 * fed back in) in nonce order, and a rekey never races a message.
 */
class CipherState {
  #key: CryptoKey | null = null;
  #n = 0n;
  #chain: Promise<unknown> = Promise.resolve();
  #rekey: boolean;
  #rekeyedAt = 0n;

  constructor(rekey = false) {
    this.#rekey = rekey;
  }

  async init(k: Bytes | null): Promise<void> {
    this.#key = k ? await importAes(k.slice(0, 32)) : null;
    this.#n = 0n;
  }

  hasKey(): boolean {
    return this.#key !== null;
  }

  encrypt(ad: Bytes, pt: Bytes): Promise<Bytes> {
    return this.#serial(async () => {
      if (!this.#key) return pt;
      const iv = await this.#nonce();
      const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad }, this.#key, pt);
      this.#n++;
      return new Uint8Array(ct);
    });
  }

  decrypt(ad: Bytes, ct: Bytes): Promise<Bytes> {
    return this.#serial(async () => {
      if (!this.#key) return ct;
      const iv = await this.#nonce();
      let pt: ArrayBuffer;
      try {
        pt = await subtle.decrypt({ name: "AES-GCM", iv, additionalData: ad }, this.#key, ct);
      } catch {
        throw new Error("noise: decryption failed");
      }
      this.#n++; // only a message that decrypted uses up its nonce
      return new Uint8Array(pt);
    });
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#chain.then(fn);
    this.#chain = p.catch(() => {});
    return p;
  }

  /** The nonce for the next message; transport keys first rekey (REKEY) every REKEY_EVERY messages. */
  async #nonce(): Promise<Bytes> {
    if (this.#n >= MAX_NONCE) throw new Error("noise: nonces exhausted");
    if (this.#rekey && this.#n > 0n && this.#n % REKEY_EVERY === 0n && this.#rekeyedAt !== this.#n) {
      const k = await subtle.encrypt({ name: "AES-GCM", iv: nonce(MAX_NONCE), additionalData: new Uint8Array(0) }, this.#key!, new Uint8Array(32));
      this.#key = await importAes(new Uint8Array(k).slice(0, 32));
      this.#rekeyedAt = this.#n;
    }
    return nonce(this.#n);
  }
}

class SymmetricState {
  ck: Bytes;
  h: Bytes;
  cs = new CipherState();

  private constructor(h: Bytes) {
    this.ck = h;
    this.h = h;
  }

  static async create(name: string): Promise<SymmetricState> {
    const n = utf8(name);
    if (n.length <= 32) {
      const h = new Uint8Array(32);
      h.set(n);
      return new SymmetricState(h);
    }
    return new SymmetricState(await sha256(n));
  }

  async mixKey(ikm: Bytes): Promise<void> {
    const [ck, k] = await hkdf(this.ck, ikm, 2);
    this.ck = ck!;
    await this.cs.init(k!);
  }

  async mixHash(data: Bytes): Promise<void> {
    this.h = await sha256(concat(this.h, data));
  }

  async mixKeyAndHash(ikm: Bytes): Promise<void> {
    const [ck, th, k] = await hkdf(this.ck, ikm, 3);
    this.ck = ck!;
    await this.mixHash(th!);
    await this.cs.init(k!);
  }

  async encryptAndHash(pt: Bytes): Promise<Bytes> {
    const ct = await this.cs.encrypt(this.h, pt);
    await this.mixHash(ct);
    return ct;
  }

  async decryptAndHash(ct: Bytes): Promise<Bytes> {
    const pt = await this.cs.decrypt(this.h, ct);
    await this.mixHash(ct);
    return pt;
  }

  async split(): Promise<[CipherState, CipherState]> {
    const [k1, k2] = await hkdf(this.ck, new Uint8Array(0), 2);
    const c1 = new CipherState(true);
    const c2 = new CipherState(true);
    await c1.init(k1!);
    await c2.init(k2!);
    return [c1, c2];
  }
}

export interface HandshakeOptions {
  pattern: Pattern;
  initiator: boolean;
  /** Our static key. */
  s: KeyPair;
  /** The responder's static key; the initiator must know it (the "K" in IK). */
  rs?: Bytes;
  /** IKpsk1 only: 32 bytes. */
  psk?: Bytes;
  prologue?: Bytes;
  /** Tests only: a fixed ephemeral key (the Noise test vectors). */
  e?: KeyPair;
}

/**
 * One IK handshake: initiator writeMessage → responder readMessage, writeMessage
 * → initiator readMessage, then both call transport().
 */
export class Handshake {
  readonly pattern: Pattern;
  readonly initiator: boolean;
  #ss: SymmetricState;
  #s: KeyPair;
  #e: KeyPair | null = null;
  #rs: Bytes | null;
  #re: Bytes | null = null;
  #psk: Bytes | null;
  #fixedE: KeyPair | null;
  #step = 0;

  private constructor(o: HandshakeOptions, ss: SymmetricState) {
    this.pattern = o.pattern;
    this.initiator = o.initiator;
    this.#ss = ss;
    this.#s = o.s;
    this.#rs = o.rs ?? null;
    this.#psk = o.psk ?? null;
    this.#fixedE = o.e ?? null;
  }

  static async create(o: HandshakeOptions): Promise<Handshake> {
    if (o.pattern === "IKpsk1" && o.psk?.length !== 32) throw new Error("noise: IKpsk1 needs a 32-byte psk");
    if (o.initiator && o.rs?.length !== DHLEN) throw new Error("noise: the initiator needs the responder's static key");
    const ss = await SymmetricState.create(PROTOCOL[o.pattern]);
    await ss.mixHash(o.prologue ?? new Uint8Array(0));
    // Pre-message `<- s`: the responder's static key.
    await ss.mixHash(o.initiator ? o.rs! : o.s.publicKey);
    return new Handshake(o, ss);
  }

  /** The peer's static key (the responder learns it from message 1). */
  get remoteStatic(): Bytes | null {
    return this.#rs;
  }

  /** The handshake hash so far: both sides agree on it after each message (channel binding, fingerprints). */
  get hash(): Bytes {
    return this.#ss.h;
  }

  get done(): boolean {
    return this.#step === 2;
  }

  async writeMessage(payload: Bytes = new Uint8Array(0)): Promise<Bytes> {
    this.#expect(true);
    const out: Bytes[] = [];
    for (const t of MESSAGES[this.pattern][this.#step]!) {
      if (t === "e") {
        this.#e = this.#fixedE ?? (await generateKeyPair());
        out.push(this.#e.publicKey);
        await this.#mixE(this.#e.publicKey);
      } else if (t === "s") out.push(await this.#ss.encryptAndHash(this.#s.publicKey));
      else await this.#token(t);
    }
    out.push(await this.#ss.encryptAndHash(payload));
    this.#step++;
    const msg = concat(...out);
    if (msg.length > MAX_MESSAGE) throw new Error("noise: message too long");
    return msg;
  }

  async readMessage(msg: Bytes): Promise<Bytes> {
    this.#expect(false);
    if (msg.length > MAX_MESSAGE) throw new Error("noise: message too long");
    let off = 0;
    const take = (n: number) => {
      if (off + n > msg.length) throw new Error("noise: message too short");
      return msg.slice(off, (off += n));
    };
    for (const t of MESSAGES[this.pattern][this.#step]!) {
      if (t === "e") {
        this.#re = take(DHLEN);
        await this.#mixE(this.#re);
      } else if (t === "s") this.#rs = await this.#ss.decryptAndHash(take(this.#ss.cs.hasKey() ? DHLEN + TAGLEN : DHLEN));
      else await this.#token(t);
    }
    const payload = await this.#ss.decryptAndHash(msg.slice(off));
    this.#step++;
    return payload;
  }

  /** After the second message: the transport keys. */
  async transport(): Promise<Transport> {
    if (!this.done) throw new Error("noise: handshake not finished");
    const [c1, c2] = await this.#ss.split();
    return this.initiator ? new Transport(c1, c2) : new Transport(c2, c1);
  }

  #expect(writing: boolean): void {
    if (this.#step > 1) throw new Error("noise: handshake already finished");
    // The initiator writes message 1 and reads message 2.
    if (writing !== (this.initiator === (this.#step === 0))) throw new Error("noise: out of order");
  }

  async #mixE(pub: Bytes): Promise<void> {
    await this.#ss.mixHash(pub);
    if (this.#psk) await this.#ss.mixKey(pub);
  }

  async #token(t: Token): Promise<void> {
    const e = () => this.#e!.privateKey;
    const s = this.#s.privateKey;
    switch (t) {
      case "ee":
        return this.#ss.mixKey(await dh(e(), this.#re!));
      case "es":
        return this.#ss.mixKey(this.initiator ? await dh(e(), this.#rs!) : await dh(s, this.#re!));
      case "se":
        return this.#ss.mixKey(this.initiator ? await dh(s, this.#re!) : await dh(e(), this.#rs!));
      case "ss":
        return this.#ss.mixKey(await dh(s, this.#rs!));
      case "psk":
        return this.#ss.mixKeyAndHash(this.#psk!);
    }
  }
}

/** An established session: one key per direction, each with its own nonces. */
export class Transport {
  #send: CipherState;
  #recv: CipherState;

  constructor(send: CipherState, recv: CipherState) {
    this.#send = send;
    this.#recv = recv;
  }

  encrypt(pt: Bytes): Promise<Bytes> {
    if (pt.length > MAX_PLAINTEXT) throw new Error("noise: message too long");
    return this.#send.encrypt(new Uint8Array(0), pt);
  }

  decrypt(ct: Bytes): Promise<Bytes> {
    return this.#recv.decrypt(new Uint8Array(0), ct);
  }
}

// ── bytes ─────────────────────────────────────────────

export function bytes(a: ArrayLike<number>): Bytes {
  return Uint8Array.from(a);
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

const encoder = new TextEncoder();
export const utf8 = (s: string): Bytes => encoder.encode(s) as Bytes;

export function randomBytes(n: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function toBase64Url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("invalid base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
