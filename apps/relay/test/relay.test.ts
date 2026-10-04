import { afterEach, describe, expect, it } from "vitest";
import { decodeRelayFrame, encodeRelayFrame, RelayClose, RelayFrameType, type RelayFrame } from "@cmd/protocol";
import { startRelay, type Relay } from "../src/relay.ts";

let relay: Relay;
const logs: string[] = [];
afterEach(() => relay?.close());

const start = async (o: Parameters<typeof startRelay>[0] = {}) => (relay = await startRelay({ log: (m) => logs.push(m), ...o }));

/** A WebSocket with a queue of what it received and how it closed. */
async function open(url: string) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const got: (string | Uint8Array)[] = [];
  let closed: number | null = null;
  ws.onmessage = (e) => got.push(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
  ws.onclose = (e) => (closed = e.code);
  // Node's WebSocket reports a refused upgrade only as an error, without a close.
  ws.onerror = () => (closed ??= 1006);
  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
    ws.addEventListener("close", () => resolve());
    ws.addEventListener("error", () => resolve());
  });
  return { ws, got, closed: () => closed };
}

/** Connect a device and wait for the relay to close it; the close code. */
async function refused(url: string) {
  const d = await open(url);
  await expect.poll(() => d.closed()).not.toBeNull();
  return d.closed();
}

async function host() {
  const h = await open(`${relay.url}/h`);
  h.ws.send(JSON.stringify({ register: true }));
  await expect.poll(() => h.got.length).toBe(1);
  const { route, secret } = JSON.parse(h.got.shift() as string) as { route: string; secret: string };
  const frames = () => h.got.filter((g): g is Uint8Array => typeof g !== "string").map(decodeRelayFrame);
  return { ...h, route, secret, frames, send: (f: RelayFrame) => h.ws.send(encodeRelayFrame(f)) };
}

describe("relay", () => {
  it("routes a device's channel to its host and back", async () => {
    await start();
    const h = await host();
    const d = await open(`${relay.url}/r/${h.route}`);
    await expect.poll(() => h.frames().map((f) => f.type)).toEqual([RelayFrameType.open]);
    const ch = h.frames()[0]!.channel;
    d.ws.send(new TextEncoder().encode("CANARY-secret-bytes"));
    await expect.poll(() => h.frames().length).toBe(2);
    expect(new TextDecoder().decode(h.frames()[1]!.payload)).toBe("CANARY-secret-bytes");
    h.send({ channel: ch, type: RelayFrameType.data, payload: new TextEncoder().encode("back") });
    await expect.poll(() => d.got.length).toBe(1);
    expect(new TextDecoder().decode(d.got[0] as Uint8Array)).toBe("back");
    d.ws.close();
    await expect.poll(() => h.frames().at(-1)?.type).toBe(RelayFrameType.close);
    expect(logs.join("\n")).not.toContain("CANARY");
  });

  it("keeps channels apart", async () => {
    await start();
    const h = await host();
    const a = await open(`${relay.url}/r/${h.route}`);
    const b = await open(`${relay.url}/r/${h.route}`);
    await expect.poll(() => h.frames().length).toBe(2);
    const [ca] = h.frames().map((f) => f.channel);
    h.send({ channel: ca!, type: RelayFrameType.data, payload: new Uint8Array([1]) });
    await expect.poll(() => a.got.length).toBe(1);
    expect(b.got).toEqual([]);
  });

  it("treats unknown and offline routes alike", async () => {
    await start();
    const h = await host();
    h.ws.close();
    await expect.poll(() => h.closed()).not.toBeNull();
    expect(await refused(`${relay.url}/r/${h.route}`)).toBe(RelayClose.unavailable);
    expect(await refused(`${relay.url}/r/AAAAAAAAAAAAAAAAAAAAAA`)).toBe(RelayClose.unavailable);
  });

  it("re-authenticates a route by its secret", async () => {
    await start();
    const h = await host();
    h.ws.close();
    const bad = await open(`${relay.url}/h`);
    bad.ws.send(JSON.stringify({ route: h.route, secret: "wrong" }));
    await expect.poll(() => bad.closed()).toBe(RelayClose.forbidden);
    const good = await open(`${relay.url}/h`);
    good.ws.send(JSON.stringify({ route: h.route, secret: h.secret }));
    await expect.poll(() => good.got).toEqual([JSON.stringify({ ok: true })]);
  });

  it("caps channels per route", async () => {
    await start({ limits: { channelsPerRoute: 1 } });
    const h = await host();
    await open(`${relay.url}/r/${h.route}`);
    expect(await refused(`${relay.url}/r/${h.route}`)).toBe(RelayClose.busy);
  });

  it("checks the Origin of device links", async () => {
    await start({ origins: ["https://client.example"] });
    const h = await host();
    expect(await refused(`${relay.url}/r/${h.route}`)).toBe(1006);
    expect(h.frames()).toEqual([]);
  });
});
