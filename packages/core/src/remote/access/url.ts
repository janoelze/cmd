// The "Your own URL" access adapter: the person runs something that forwards
// HTTPS and WebSockets to the loopback port (Caddy, nginx, Cloudflare Tunnel,
// ngrok) and gives its origin as remote.url. cmd publishes nothing itself; the
// checks say whether the page and the socket come through.

import { WebSocket } from "ws";
import type { AccessAdapter, AdapterContext, Check } from "./adapter.ts";

/** remote.url as an https origin, or why it isn't one. */
export function publicOrigin(raw: string): { url: string } | { error: string } {
  const s = raw.trim();
  if (!s) return { error: "Add your HTTPS address (remote.url)." };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { error: `“${s}” isn't a URL.` };
  }
  // Browsers treat loopback as secure too: testing on this Mac (e2e/web.mjs).
  const loopback = u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !loopback) return { error: "The address needs HTTPS: phones only encrypt on secure pages." };
  if (u.pathname !== "/" || u.search || u.hash) return { error: "Use the address without a path, like https://mac.example.com." };
  return { url: u.origin };
}

export const urlAdapter: AccessAdapter = {
  id: "url",
  title: "Your own URL",
  icon: "link",
  description: "A proxy or tunnel you run, in front of this Mac.",

  async detect(ctx) {
    const o = publicOrigin(ctx.settings["remote.url"]);
    const checks: Check[] = [
      "error" in o
        ? { id: "url", title: "An HTTPS address", state: "todo", detail: o.error }
        : { id: "url", title: "An HTTPS address", state: "ok", detail: o.url },
    ];
    if ("error" in o) return checks;
    const page = await probePage(o.url);
    checks.push({ id: "page", title: "The page loads", state: page ? "error" : "ok", detail: page ?? `Forwards to 127.0.0.1:${ctx.port}` });
    if (page) return checks;
    const socket = await probeSocket(o.url, ctx);
    checks.push({ id: "socket", title: "Phones can connect", state: socket ? "error" : "ok", detail: socket ?? undefined });
    return checks;
  },

  async enable(ctx) {
    const o = publicOrigin(ctx.settings["remote.url"]);
    if ("error" in o) throw new Error(o.error);
    return o;
  },

  async disable() {},
};

/** null when the origin serves cmd's web client; else what's wrong. */
async function probePage(origin: string): Promise<string | null> {
  try {
    const res = await fetch(origin, { signal: AbortSignal.timeout(8000), redirect: "manual" });
    if (!res.ok) return `${origin} answered ${res.status}. Check that it forwards to this Mac.`;
    const csp = res.headers.get("content-security-policy") ?? "";
    if (!csp.includes("connect-src 'self'")) return `${origin} doesn't serve cmd's page. Check that it forwards to this Mac.`;
    return null;
  } catch (err) {
    return `Couldn't reach ${origin} (${(err as Error).cause ? String(((err as Error).cause as Error).message ?? (err as Error).cause) : (err as Error).message}).`;
  }
}

/** null when a WebSocket to /r/<route> opens through the proxy. */
function probeSocket(origin: string, ctx: AdapterContext): Promise<string | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/r/${ctx.route}`, { origin, handshakeTimeout: 8000 });
    const done = (v: string | null) => {
      ws.removeAllListeners();
      ws.on("error", () => {});
      ws.terminate();
      resolve(v);
    };
    ws.on("open", () => done(null));
    ws.on("unexpected-response", (_req, res) => done(`The WebSocket was refused (${res.statusCode}). Check that the proxy forwards WebSockets.`));
    ws.on("error", (err) => done(`The WebSocket didn't connect (${err.message}). Check that the proxy forwards WebSockets.`));
  });
}
