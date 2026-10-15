// Pictures (API 1.3, docs/57 "1.3 additions" A5): what a Picture's src may be and how cmd gets
// one. The page never loads an image a widget names: an <img src> from a widget would load
// with the app session's cookies and tell a host each time the window redraws. So a `data:`
// src is checked here (the type it says, and its bytes are that type), and an `https:` src is
// fetched by the core through net.fetch's broker (net.ts: the host checked against the grant
// per URL, redirects only within the host, cmd's user agent, no cookies, no Referer, counted
// against the widget's net limit), its bytes checked by their magic numbers (PNG, JPEG, WebP,
// GIF; never SVG, which can carry script and references), at most PICTURE_LIMITS.fetch bytes
// and PICTURE_LIMITS.side px a side, and handed on as a `data:` URL. Fetched pictures are
// cached by URL for an hour, PICTURE_LIMITS.cache bytes at most (the least recently used go
// first), shared by every window: a widget that redraws makes no request per redraw, and one
// that adds a nonce to its URLs spends its net limit. host/pictures.ts puts them in the tree.

import { PICTURE_DATA, PICTURE_DATA_MAX } from "@cmd/protocol";
import { ApiRefusal, failed, invalid, missing } from "./access.ts";
import { brokeredResponse, granted, hostOf, readBytes } from "./net.ts";

export const PICTURE_LIMITS = {
  /** The most a fetched picture may be (bytes). */
  fetch: 2 * 1024 * 1024,
  /** Its widest and tallest (px). */
  side: 4096,
  /** How long a fetched picture is kept (ms). */
  keepMs: 60 * 60_000,
  /** How long a URL that failed isn't asked again (ms): a redraw is no reason to ask. */
  failedMs: 10 * 60_000,
  /** The cache's size (bytes of data: URLs). */
  cache: 32 * 1024 * 1024,
} as const;

export type PictureType = "png" | "jpeg" | "webp" | "gif";

/** The type of an image by its magic numbers, and its size; null for anything else (SVG, HTML, text, another format). */
export function sniff(b: Uint8Array): { type: PictureType; width: number; height: number } | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
  const ascii = (i: number, s: string) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  const be16 = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const le16 = (i: number) => b[i]! | (b[i + 1]! << 8);
  const le24 = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const be32 = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
  if (b.length >= 24 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) && ascii(12, "IHDR")) return { type: "png", width: be32(16), height: be32(20) };
  if (b.length >= 10 && (ascii(0, "GIF87a") || ascii(0, "GIF89a"))) return { type: "gif", width: le16(6), height: le16(8) };
  if (b.length >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (ascii(12, "VP8 ") && at(23, 0x9d, 0x01, 0x2a)) return { type: "webp", width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (ascii(12, "VP8L") && b[20] === 0x2f) return { type: "webp", width: 1 + (((b[22]! & 0x3f) << 8) | b[21]!), height: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)) };
    if (ascii(12, "VP8X")) return { type: "webp", width: 1 + le24(24), height: 1 + le24(27) };
    return null;
  }
  if (b.length >= 4 && at(0, 0xff, 0xd8, 0xff)) {
    // The frame header (SOFn but DHT, JPG, DAC) has the size: walk the segments to it.
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1]!;
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: "jpeg", width: be16(i + 7), height: be16(i + 5) };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + be16(i + 2);
    }
    return null;
  }
  return null;
}

/** What the bytes are, as a refusal's words: an SVG named as one. */
const whatItIs = (b: Uint8Array) => (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg|<svg)/i.test(Buffer.from(b.subarray(0, 512)).toString("latin1")) ? "an SVG, which cmd never draws" : "not a PNG, JPEG, WebP or GIF");

/** Checks a picture's bytes: one of the four types, within the size; its data: URL, or throws. `what` names it in the refusal. */
export function pictureData(bytes: Uint8Array, what: string, said?: string): string {
  const s = sniff(bytes);
  if (!s) throw invalid(`Picture: ${what} is ${whatItIs(bytes)}. Use a PNG, JPEG, WebP or GIF.`);
  if (said && said !== s.type) throw invalid(`Picture: ${what} says it's a ${said.toUpperCase()} but is a ${s.type.toUpperCase()}.`);
  if (!s.width || !s.height) throw invalid(`Picture: ${what} has no size.`);
  if (s.width > PICTURE_LIMITS.side || s.height > PICTURE_LIMITS.side) throw invalid(`Picture: ${what} is ${s.width}×${s.height} px; cmd draws pictures up to ${PICTURE_LIMITS.side} px a side.`);
  return `data:image/${s.type};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** A Picture's data: src as it may be drawn: the type it says (no SVG), at most PICTURE_DATA_MAX, its bytes that type; or throws. */
export function checkDataSrc(src: string): string {
  if (src.length > PICTURE_DATA_MAX) throw invalid(`Picture: a data: src is at most ${PICTURE_DATA_MAX / 1024} KB; this one is ${Math.ceil(src.length / 1024)} KB.`);
  const m = PICTURE_DATA.exec(src);
  if (!m) throw invalid(`Picture: a data: src is a base64 PNG, JPEG, WebP or GIF${/^data:image\/svg/i.test(src) ? ", never SVG" : ""}.`);
  pictureData(Buffer.from(src.slice(src.indexOf(",") + 1), "base64"), "its data: src", m[1]);
  return src;
}

/** Fetched pictures by URL, shared by every widget window (WidgetHost has one). */
export class PictureCache {
  readonly #kept = new Map<string, { src: string | null; at: number; why?: string }>();
  readonly #flight = new Map<string, Promise<string>>();
  #bytes = 0;
  /** Requests made (tests). */
  fetches = 0;
  readonly #now: () => number;

  constructor(o: { now?: () => number } = {}) {
    this.#now = o.now ?? Date.now;
  }

  /**
   * The picture at `url` as a data: URL: kept, being fetched, or fetched now with `fetchOne`
   * after `take` (the asking widget's net limit, which throws when spent: then nothing is
   * kept). A failure of the fetch is kept too, a while. The caller checks the grant first.
   */
  get(url: string, fetchOne: () => Promise<string>, take: () => void = () => {}): Promise<string> {
    const k = this.#kept.get(url);
    if (k && this.#now() - k.at < (k.src === null ? PICTURE_LIMITS.failedMs : PICTURE_LIMITS.keepMs)) {
      // Least recently used goes first: a hit moves it to the end.
      this.#kept.delete(url);
      this.#kept.set(url, k);
      return k.src === null ? Promise.reject(failed(k.why ?? "Picture: couldn't be fetched")) : Promise.resolve(k.src);
    }
    if (k) this.#drop(url);
    const going = this.#flight.get(url);
    if (going) return going;
    try {
      take();
    } catch (e) {
      return Promise.reject(e);
    }
    this.fetches++;
    const p = fetchOne().then(
      (src) => (this.#keep(url, { src, at: this.#now() }), src),
      (e: unknown) => {
        const refusal = e instanceof ApiRefusal ? e : failed(`Picture: ${(e as Error).message}`);
        this.#keep(url, { src: null, at: this.#now(), why: refusal.error.message });
        throw refusal;
      },
    );
    this.#flight.set(url, p);
    void p.catch(() => {}).finally(() => this.#flight.delete(url));
    return p;
  }

  #keep(url: string, e: { src: string | null; at: number; why?: string }): void {
    this.#drop(url);
    this.#kept.set(url, e);
    this.#bytes += e.src?.length ?? 0;
    for (const [k] of this.#kept) {
      if (this.#bytes <= PICTURE_LIMITS.cache) break;
      this.#drop(k);
    }
  }

  #drop(url: string): void {
    const e = this.#kept.get(url);
    if (!e) return;
    this.#bytes -= e.src?.length ?? 0;
    this.#kept.delete(url);
  }

  /** Bytes kept (tests). */
  get size(): number {
    return this.#bytes;
  }
}

/** What one widget's picture fetch may do: its grant's hosts, what fetches (tests). */
export interface PictureScope {
  net: string[];
  fetchImpl?: typeof fetch;
}

/** An https src's URL, checked: https only, no credentials, the host in the grant. */
export function pictureUrl(src: string, net: string[]): URL {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    throw invalid(`Picture: "${src.slice(0, 200)}" isn't a URL.`);
  }
  if (u.protocol !== "https:") throw invalid(`Picture: a src is a data: image or an https:// address, not ${u.protocol}`);
  if (u.username || u.password) throw invalid("Picture: an address with credentials in it isn't fetched.");
  if (!granted(net, u)) throw missing("net", hostOf(u), `Showing pictures from ${hostOf(u)}`);
  return u;
}

/** Fetches one picture as net.fetch would, and checks it: its data: URL, or throws. */
export async function fetchPicture(url: URL, scope: PictureScope): Promise<string> {
  const host = hostOf(url);
  const { res } = await brokeredResponse(url.href, { method: "GET", headers: { accept: "image/png,image/jpeg,image/webp,image/gif" } }, { net: scope.net, fields: [], secret: () => null, fetchImpl: scope.fetchImpl });
  try {
    if (res.status < 200 || res.status >= 300) throw failed(`Picture: ${host} answered ${res.status}.`);
    const type = res.headers.get("content-type") ?? "";
    if (/svg|xml|html/i.test(type)) throw invalid(`Picture: ${host} sent ${type.split(";")[0]}, which cmd never draws. Use a PNG, JPEG, WebP or GIF.`);
    const length = Number(res.headers.get("content-length"));
    if (length > PICTURE_LIMITS.fetch) throw invalid(`Picture: ${host} sent ${Math.ceil(length / 1024 / 1024)} MB; cmd fetches pictures up to ${PICTURE_LIMITS.fetch / 1024 / 1024} MB.`);
    const { bytes, clipped } = await readBytes(res, PICTURE_LIMITS.fetch);
    if (clipped) throw invalid(`Picture: ${host} sent more than ${PICTURE_LIMITS.fetch / 1024 / 1024} MB; cmd fetches pictures up to that.`);
    return pictureData(bytes, `the picture from ${host}`);
  } finally {
    await res.body?.cancel().catch(() => {});
  }
}
