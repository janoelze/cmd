// The Magic agent's `fetch`: an HTTP GET that only reaches public hosts. It
// runs in the core (not sandboxed), so every hop, the first URL and each
// redirect, is resolved first and refused when any address is loopback,
// link-local (cloud metadata), private, CGNAT or otherwise not public. The
// connection then goes to exactly the addresses that were checked, so a DNS
// answer that changes between the check and the connect (rebinding) can't
// slip through.
//
// TODO(AR1-11-03): once the agent has read a local file or command output in a
// build, allow only hosts already fetched or named in the request.

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import type { Readable } from "node:stream";

export interface Address {
  address: string;
  family: number;
}

/** Resolves a host name to all its addresses (tests inject one, so they don't need DNS). */
export type Lookup = (hostname: string) => Promise<Address[]>;

const systemLookup: Lookup = (h) => dns.promises.lookup(h, { all: true, verbatim: true });

export interface GuardedFetchOptions {
  lookup?: Lookup;
  /** Tests: host names taken as public whatever they resolve to (a local server standing in for one). */
  publicHosts?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Body bytes to read at most (default 64 KB); the rest is dropped. */
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  /** Content types that are streams: their headers are the answer, the body isn't read. */
  stream?: RegExp;
}

export interface GuardedResponse {
  status: number;
  /** The URL that answered (after redirects). */
  url: string;
  contentType: string;
  body: string;
  /** The content type is a stream; body is empty. */
  streamed: boolean;
}

/** fetch refused a URL: `message` is one line for the model saying what and why. */
export class FetchRefused extends Error {}

// Every range that isn't the public internet, with what to call it.
const RANGES = (
  [
    ["0.0.0.0", 8, "ipv4", "unspecified"],
    ["10.0.0.0", 8, "ipv4", "private"],
    ["100.64.0.0", 10, "ipv4", "carrier-grade NAT"],
    ["127.0.0.0", 8, "ipv4", "loopback"],
    ["169.254.0.0", 16, "ipv4", "link-local"],
    ["172.16.0.0", 12, "ipv4", "private"],
    ["192.0.0.0", 24, "ipv4", "reserved"],
    ["192.168.0.0", 16, "ipv4", "private"],
    ["198.18.0.0", 15, "ipv4", "benchmarking"],
    ["224.0.0.0", 4, "ipv4", "multicast"],
    ["240.0.0.0", 4, "ipv4", "reserved"],
    ["::", 128, "ipv6", "unspecified"],
    ["::1", 128, "ipv6", "loopback"],
    ["fc00::", 7, "ipv6", "private"],
    ["fe80::", 10, "ipv6", "link-local"],
    ["ff00::", 8, "ipv6", "multicast"],
  ] as const
).map(([a, bits, family, why]) => {
  const list = new net.BlockList();
  list.addSubnet(a, bits, family);
  return { list, family, why };
});

/** The IPv4 address an IPv6 one carries (::ffff:a.b.c.d, ::ffff:7f00:1, NAT64 64:ff9b::…), if it does. */
function embeddedV4(ip: string): string | null {
  const m = /^(?:::ffff:(?:0:)?|64:ff9b::)(.+)$/i.exec(ip);
  if (!m) return null;
  if (net.isIPv4(m[1]!)) return m[1]!;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(m[1]!);
  if (!hex) return null;
  const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Why an address isn't public ("loopback", "private", …); null when it is. */
export function nonPublic(ip: string): string | null {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const v4 = net.isIPv4(bare) ? bare : embeddedV4(bare);
  if (!v4 && !net.isIPv6(bare)) return "not an IP address";
  const family = v4 ? "ipv4" : "ipv6";
  return RANGES.find((r) => r.family === family && r.list.check(v4 ?? bare, family))?.why ?? null;
}

/** The checked addresses of a URL's host; throws FetchRefused when one isn't public. */
async function resolve(url: URL, o: GuardedFetchOptions, what: string): Promise<Address[]> {
  const lookup = o.lookup ?? systemLookup;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = net.isIP(host);
  let addrs: Address[];
  if (literal) addrs = [{ address: host, family: literal }];
  else {
    try {
      addrs = await lookup(host);
    } catch (e) {
      throw new Error(`couldn't resolve ${host}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
    if (!addrs.length) throw new Error(`couldn't resolve ${host}`);
  }
  if (o.publicHosts?.includes(host)) return addrs;
  for (const a of addrs) {
    const why = nonPublic(a.address);
    if (why) throw new FetchRefused(`Not fetched: ${what ? what + " " : ""}${url.href} goes to ${a.address}, a ${why} address; fetch only reaches public hosts.`);
  }
  return addrs;
}

function decoded(res: http.IncomingMessage): Readable {
  const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
  if (enc === "gzip" || enc === "x-gzip") return res.pipe(zlib.createGunzip());
  if (enc === "deflate") return res.pipe(zlib.createInflate());
  if (enc === "br") return res.pipe(zlib.createBrotliDecompress());
  return res;
}

/** One request to checked addresses; resolves with the response once headers are in. */
function request(url: URL, addrs: Address[], headers: Record<string, string>, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((ok, fail) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, {
      method: "GET",
      headers: { "accept-encoding": "gzip, deflate, br", ...headers },
      signal,
      agent: false,
      // Connect only to the addresses resolve() checked.
      lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
        opts?.all ? cb(null, addrs) : cb(null, addrs[0]!.address, addrs[0]!.family)) as unknown as net.LookupFunction,
    });
    req.on("response", ok);
    req.on("error", fail);
    req.end();
  });
}

/** HTTP GET a public http(s) URL, following up to `maxRedirects` redirects, each checked. */
export async function guardedFetch(input: string, o: GuardedFetchOptions = {}): Promise<GuardedResponse> {
  const max = o.maxBytes ?? 64 * 1024;
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 10_000);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new FetchRefused(`Not fetched: ${input} isn't a URL.`);
  }
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchRefused(`Not fetched: ${hop ? "redirect to " : ""}${url.href} isn't http(s).`);
    const addrs = await resolve(url, o, hop ? "redirect to" : "");
    const res = await request(url, addrs, o.headers ?? {}, signal);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.resume();
      if (hop >= (o.maxRedirects ?? 5)) throw new Error(`too many redirects (last: ${url.href})`);
      url = new URL(location, url);
      continue;
    }
    const contentType = String(res.headers["content-type"] ?? "");
    if (o.stream?.test(contentType)) {
      res.destroy();
      return { status, url: url.href, contentType, body: "", streamed: true };
    }
    const chunks: Buffer[] = [];
    let n = 0;
    const body = decoded(res);
    await new Promise<void>((done, fail) => {
      body.on("data", (b: Buffer) => {
        chunks.push(b);
        n += b.length;
        if (n >= max) {
          res.destroy();
          done();
        }
      });
      body.on("end", () => done());
      body.on("error", (e) => (n >= max ? done() : fail(e)));
      res.on("error", (e) => (n >= max ? done() : fail(e)));
    });
    return { status, url: url.href, contentType, body: Buffer.concat(chunks).subarray(0, max).toString("utf8"), streamed: false };
  }
}
