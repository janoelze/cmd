// `cmd.net.fetch` (docs/56, "Secrets never reach a widget"): the widget process has no network
// of its own, so the core fetches for it. The URL's host must be in the grant's `net` (exactly,
// a port included when it names one); https only, plain http only to localhost; no redirect to
// another host; a 30 s timeout; the body back as text, clipped at 256 KB. `init.auth` names a
// secret config field: its value goes in the field's header, and only when the URL's host is
// the field's own. The value never appears in a result, an error or a log line. A Picture's
// https src (1.3, picture.ts) goes through the same request (brokeredResponse), its body read
// as bytes.

import type { ApiFetchInit, ApiFetchResponse } from "@cmd/protocol";
import type { ConfigField } from "../package.ts";
import { ApiRefusal, failed, invalid, missing } from "./access.ts";

export const FETCH_BODY_MAX = 256 * 1024;
export const FETCH_TIMEOUT_MS = 30_000;
const SEND_MAX = 1024 * 1024;
const REDIRECTS = 5;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
/** Headers the core sets, never the widget. */
const OWN = new Set(["host", "content-length", "cookie", "connection", "transfer-encoding"]);

export interface FetchScope {
  /** The grant's hosts. */
  net: string[];
  /** The widget's config fields (its secrets among them). */
  fields: ConfigField[];
  /** A secret's value, or null when it isn't set. */
  secret(key: string): string | null;
  fetchImpl?: typeof fetch;
}

/** "host" or "host:port" of a URL, as a grant writes it. */
export const hostOf = (u: URL) => (u.port ? `${u.hostname}:${u.port}` : u.hostname);

/** Whether the grant reaches this URL's host. */
export function granted(net: string[], u: URL): boolean {
  return net.includes("*") || net.includes(hostOf(u)) || (!u.port && net.includes(u.hostname));
}

function parse(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw invalid(`net.fetch: "${String(url).slice(0, 200)}" isn't a URL.`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw invalid(`net.fetch: only https:// addresses (and http://localhost) can be fetched, not ${u.protocol}`);
  if (u.username || u.password) throw invalid("net.fetch: put credentials in a secret config field, not the URL.");
  return u;
}

/** A redacted message: nothing of the secret's value. */
const scrub = (s: string, secret: string | null) => (secret && secret.length >= 4 ? s.replaceAll(secret, "[secret]") : s);

export async function brokeredFetch(url: string, init: ApiFetchInit | null | undefined, scope: FetchScope): Promise<ApiFetchResponse> {
  const { res, secret } = await brokeredResponse(url, init, scope);
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (k !== "set-cookie") out[k] = v;
  });
  const { text, clipped } = await readClipped(res, FETCH_BODY_MAX);
  return { status: res.status, headers: out, body: scrub(text, secret), clipped };
}

/** The request net.fetch makes (the grant, the method, the headers, a secret, the redirects), up to the response, its body unread. */
export async function brokeredResponse(url: string, init: ApiFetchInit | null | undefined, scope: FetchScope): Promise<{ res: Response; url: URL; secret: string | null }> {
  const o = init ?? {};
  let u = parse(url);
  if (!granted(scope.net, u)) throw missing("net", hostOf(u), `Fetching ${hostOf(u)}`);
  const method = (o.method ?? "GET").toUpperCase();
  if (!METHODS.includes(method)) throw invalid(`net.fetch: ${method} isn't a method cmd sends (${METHODS.join(", ")})`);
  if (o.body !== undefined && o.body !== null && typeof o.body !== "string") throw invalid("net.fetch: the body should be a string (JSON.stringify it)");
  if (o.body && Buffer.byteLength(o.body) > SEND_MAX) throw invalid("net.fetch: the body is over 1 MB");

  const headers: Record<string, string> = { "user-agent": "cmd-widget/1" };
  for (const [k, v] of Object.entries(o.headers ?? {})) if (typeof v === "string" && !OWN.has(k.toLowerCase())) headers[k.toLowerCase()] = v;

  let secret: string | null = null;
  let authHost: string | null = null;
  if (o.auth !== undefined && o.auth !== null) {
    const field = scope.fields.find((f) => f.key === o.auth);
    if (!field?.secret || !field.host) throw invalid(`net.fetch: auth "${String(o.auth)}" isn't a secret config field of this widget`);
    authHost = field.host;
    // Exactly its host: a field bound to "api.github.com" goes to no other port of it.
    if (hostOf(u) !== authHost) throw invalid(`net.fetch: "${field.key}" is only sent to ${authHost}, not to ${hostOf(u)}`);
    secret = scope.secret(field.key);
    if (!secret) throw failed(`${field.title} isn't set yet. Add it in the widget's settings.`);
    const name = (field.header ?? "Authorization").toLowerCase();
    const scheme = field.scheme ?? "Bearer";
    headers[name] = scheme ? `${scheme} ${secret}` : secret;
  }

  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const doFetch = scope.fetchImpl ?? fetch;
  let res: Response;
  try {
    for (let hop = 0; ; hop++) {
      res = await doFetch(u, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : (o.body ?? undefined), redirect: "manual", signal });
      if (res.status < 300 || res.status >= 400 || !res.headers.get("location")) break;
      await res.body?.cancel().catch(() => {});
      const next = parse(new URL(res.headers.get("location")!, u).href);
      if (next.host !== u.host || next.protocol !== u.protocol) throw failed(`net.fetch: ${hostOf(u)} redirected to ${hostOf(next)}, and cmd doesn't follow a redirect to another host`);
      if (hop >= REDIRECTS) throw failed(`net.fetch: more than ${REDIRECTS} redirects from ${hostOf(u)}`);
      u = next;
    }
  } catch (e) {
    if (e instanceof ApiRefusal) throw e;
    const why = (e as Error).name === "TimeoutError" ? `didn't answer within ${FETCH_TIMEOUT_MS / 1000} s` : scrub(((e as { cause?: Error }).cause?.message ?? (e as Error).message).slice(0, 200), secret);
    throw failed(`net.fetch: ${hostOf(u)} ${why.startsWith("didn't") ? why : `couldn't be reached (${why})`}`);
  }
  return { res: res!, url: u, secret };
}

/** A response's body as text, at most `max` bytes. */
async function readClipped(res: Response, max: number): Promise<{ text: string; clipped: boolean }> {
  const { bytes, clipped } = await readBytes(res, max);
  return { text: new TextDecoder().decode(bytes), clipped };
}

/** A response's body, at most `max` bytes (`clipped`: there was more, and it wasn't read). */
export async function readBytes(res: Response, max: number): Promise<{ bytes: Buffer; clipped: boolean }> {
  if (!res.body) return { bytes: Buffer.alloc(0), clipped: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let clipped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > max) {
      chunks.push(value.subarray(0, max - size));
      size = max;
      clipped = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  return { bytes: Buffer.concat(chunks), clipped };
}
