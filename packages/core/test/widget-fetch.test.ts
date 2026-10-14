// cmd.net.fetch through the core (docs/56, "Secrets never reach a widget"; widgets/api/net.ts)
// against local servers: a granted host is fetched, another refused with the permission to add;
// a secret goes only to the host its field is bound to, in its header and scheme; a redirect to
// another host isn't followed; a long body comes back clipped; the secret's value is in no
// result or error; file: and plain http beyond localhost are refused; the rate limit names itself.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiRefusal, RateLimit } from "../src/widgets/api/access.ts";
import { brokeredFetch, FETCH_BODY_MAX, type FetchScope } from "../src/widgets/api/net.ts";
import type { ConfigField } from "../src/widgets/package.ts";

const SECRET = "ghp_supersecretvalue123";
const seen: { url: string; auth: string | undefined; key: string | undefined }[] = [];
let a: http.Server;
let b: http.Server;
let A: string; // "localhost:<port>"
let B: string; // "127.0.0.1:<port>": another host

const serve = (fn: http.RequestListener) =>
  new Promise<http.Server>((r) => {
    const s = http.createServer(fn);
    s.listen(0, "127.0.0.1", () => r(s));
  });

beforeAll(async () => {
  b = await serve((req, res) => {
    seen.push({ url: `B${req.url}`, auth: req.headers.authorization, key: req.headers["x-api-key"] as string | undefined });
    res.end("from B");
  });
  B = `127.0.0.1:${(b.address() as AddressInfo).port}`;
  a = await serve((req, res) => {
    seen.push({ url: `A${req.url}`, auth: req.headers.authorization, key: req.headers["x-api-key"] as string | undefined });
    if (req.url === "/big") return res.end("x".repeat(FETCH_BODY_MAX + 5000));
    if (req.url === "/away") return res.writeHead(302, { location: `http://${B}/landed` }).end();
    if (req.url === "/here") return res.writeHead(302, { location: "/landed" }).end();
    if (req.url === "/echo") return res.end(`you sent ${req.headers.authorization}`);
    res.setHeader("set-cookie", "s=1");
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  A = `localhost:${(a.address() as AddressInfo).port}`;
});

afterAll(() => {
  a?.close();
  b?.close();
});

const token: ConfigField = { key: "token", title: "Token", type: "string", secret: true, host: "" };
const scope = (o: Partial<FetchScope> = {}): FetchScope => ({ net: [A], fields: [{ ...token, host: A }], secret: (k) => (k === "token" ? SECRET : null), ...o });
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiRefusal) return e.error;
    throw e;
  }
  throw new Error("not refused");
};

describe("net.fetch", () => {
  it("fetches a granted host and returns status, headers and text", async () => {
    const r = await brokeredFetch(`http://${A}/hello`, {}, scope());
    expect(r).toMatchObject({ status: 200, body: JSON.stringify({ ok: true, path: "/hello" }), clipped: false });
    expect(r.headers["content-type"] ?? r.headers["content-length"]).toBeDefined();
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a host the grant doesn't name, saying what to add", async () => {
    const e = await refused(brokeredFetch(`http://${B}/x`, {}, scope()));
    expect(e).toMatchObject({ code: "permission", permission: `net: ["${B}"]` });
    expect(seen.some((s) => s.url === "B/x")).toBe(false);
  });

  it("attaches a secret only on its field's host, in its header and scheme", async () => {
    seen.length = 0;
    await brokeredFetch(`http://${A}/auth`, { auth: "token" }, scope());
    expect(seen.at(-1)).toEqual({ url: "A/auth", auth: `Bearer ${SECRET}`, key: undefined });
    await brokeredFetch(`http://${A}/key`, { auth: "token" }, scope({ fields: [{ ...token, host: A, header: "X-Api-Key", scheme: "" }] }));
    expect(seen.at(-1)).toEqual({ url: "A/key", auth: undefined, key: SECRET });
    // Bound to A, asked for B (which is granted too): refused, nothing sent.
    const e = await refused(brokeredFetch(`http://${B}/steal`, { auth: "token" }, scope({ net: [A, B] })));
    expect(e.message).toBe(`net.fetch: "token" is only sent to ${A}, not to ${B}`);
    expect(seen.some((s) => s.url === "B/steal")).toBe(false);
    // Without auth, no secret: the widget's own header is its own.
    await brokeredFetch(`http://${A}/plain`, { headers: { Authorization: "mine" } }, scope());
    expect(seen.at(-1)?.auth).toBe("mine");
  });

  it("doesn't follow a redirect to another host, and follows one on the same host", async () => {
    seen.length = 0;
    const e = await refused(brokeredFetch(`http://${A}/away`, { auth: "token" }, scope({ net: [A, B] })));
    expect(e.message).toMatch(/redirected to 127\.0\.0\.1:\d+, and cmd doesn't follow a redirect to another host/);
    expect(seen.some((s) => s.url.startsWith("B"))).toBe(false);
    const r = await brokeredFetch(`http://${A}/here`, {}, scope());
    expect(JSON.parse(r.body)).toEqual({ ok: true, path: "/landed" });
  });

  it("clips a long body", async () => {
    const r = await brokeredFetch(`http://${A}/big`, {}, scope());
    expect(r.clipped).toBe(true);
    expect(r.body.length).toBe(FETCH_BODY_MAX);
  });

  it("keeps the secret out of results and errors", async () => {
    const echo = await brokeredFetch(`http://${A}/echo`, { auth: "token" }, scope());
    expect(echo.body).toBe("you sent Bearer [secret]");
    const failing: typeof fetch = async () => {
      throw new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED with header Bearer ${SECRET}`) });
    };
    const e = await refused(brokeredFetch(`http://${A}/down`, { auth: "token" }, scope({ fetchImpl: failing })));
    expect(e.code).toBe("failed");
    expect(JSON.stringify(e)).not.toContain(SECRET);
    expect(e.message).toContain("[secret]");
  });

  it("refuses file:, plain http beyond localhost, and credentials in the URL", async () => {
    expect((await refused(brokeredFetch("file:///etc/passwd", {}, scope({ net: ["*"] })))).code).toBe("invalid");
    expect((await refused(brokeredFetch("http://example.com/", {}, scope({ net: ["example.com"] })))).message).toMatch(/only https/);
    expect((await refused(brokeredFetch(`http://u:p@${A}/`, {}, scope()))).message).toMatch(/secret config field/);
    expect((await refused(brokeredFetch(`http://${A}/`, { auth: "nope" }, scope()))).message).toMatch(/isn't a secret config field/);
  });

  it("limits calls a minute, naming the limit", () => {
    const limit = new RateLimit(2);
    limit.take("net.fetch", 0);
    limit.take("net.fetch", 1);
    expect(() => limit.take("net.fetch", 2)).toThrow("net.fetch: at most 2 a minute; try again shortly.");
    expect(() => limit.take("net.fetch", 60_001)).not.toThrow();
  });
});
