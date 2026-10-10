// Remote access end to end: a real relay, a core, and a device speaking Noise
// through it (the web client's code path, minus the browser).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RpcClient, RpcError, type CoreEvent, type RemotePairRequest } from "@cmd/protocol";
import { decodePairing, generateKeyPair, openDeviceSession, type Bytes, type DeviceSession, type KeyPair } from "@cmd/remote-crypto";
import { startRelay, type Relay } from "../../../apps/relay/src/relay.ts";
import { Core } from "../src/core.ts";
import { fakeFactory } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";
import { until } from "../../../test/system.ts";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-remote-")));
let relay: Relay;
let core: Core;
/** Events a local client (the desktop app) sees. */
const events: CoreEvent[] = [];

beforeAll(async () => {
  relay = await startRelay({ log: () => {} });
  core = new Core({ socketPath: path.join(dir, "core.sock"), dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, home: dir });
  core.serve({ access: "local", send: () => {}, event: (e) => events.push(e), close: () => {} }).receive(JSON.stringify({ id: 1, method: "events.subscribe", params: {} }));
  core.settings.set("remote.relay", relay.url);
  core.settings.set("remote.client", "https://client.test");
  await core.call("remote.enable", {});
  await core.remote.ready();
  await until("the relay link online", () => core.remote.status().state === "online");
});

afterAll(async () => {
  await core?.close();
  await relay?.close();
  rmTemp(dir);
});

/** A device's channel through the relay: the WebSocket a browser opens. */
async function connect(route: string, o: { hostKey: Bytes; device: KeyPair; psk?: Bytes; onFingerprint?: (w: string[]) => void }) {
  const ws = new WebSocket(`${relay.url}/r/${route}`);
  ws.binaryType = "arraybuffer";
  let closed = false;
  await new Promise((r) => (ws.onopen = r));
  const { receive, closed: onClosed, session } = openDeviceSession({ ...o, hello: { name: "Test Phone" }, socket: { send: (b) => ws.send(b), close: () => ws.close() } });
  ws.onmessage = (e) => receive(new Uint8Array(e.data as ArrayBuffer));
  ws.onclose = () => {
    closed = true;
    onClosed();
  };
  session.catch(() => {});
  return { session, ws, closed: () => closed };
}

function rpc(s: DeviceSession): RpcClient {
  const c = new RpcClient((line) => void s.send(line));
  s.onLine((l) => c.receive(l));
  return c;
}

const pairRequest = () => events.findLast((e): e is Extract<CoreEvent, { type: "remote.pairRequest" }> => e.type === "remote.pairRequest")?.request;

describe("remote access", () => {
  let device: KeyPair;
  let hostKey: Bytes;
  let route: string;
  let deviceId: string;

  it("pairs a device after the Mac approves it, with matching words", async () => {
    const link = decodePairing(new URL((await core.call("remote.pair", { scope: "view" })).url).hash);
    ({ hostKey, route } = link);
    device = await generateKeyPair();
    let words: string[] = [];
    const c = await connect(route, { hostKey, device, psk: link.psk, onFingerprint: (w) => (words = w) });
    await expect.poll(pairRequest).toBeTruthy();
    const req = pairRequest() as RemotePairRequest;
    expect(req).toMatchObject({ name: "Test Phone", scope: "view" });
    expect(req.words).toEqual(words);
    await core.call("remote.approve", { requestId: req.requestId, allow: true });
    const s = await c.session;
    expect(s.host).toMatchObject({ scope: "view" });
    deviceId = s.host.deviceId as string;
    expect(core.remote.devices()).toMatchObject([{ id: deviceId, name: "Test Phone", scope: "view", connected: true }]);
    c.ws.close();
  });

  it("refuses the same pairing link twice", async () => {
    const link = decodePairing(new URL((await core.call("remote.pair", {})).url).hash);
    const before = pairRequest()?.requestId;
    const first = await connect(route, { hostKey, device: await generateKeyPair(), psk: link.psk });
    await expect.poll(() => pairRequest()?.requestId).not.toBe(before);
    await core.call("remote.approve", { requestId: pairRequest()!.requestId, allow: false });
    await expect.poll(first.closed).toBe(true);
    const again = await connect(route, { hostKey, device: await generateKeyPair(), psk: link.psk });
    await expect.poll(again.closed).toBe(true);
    expect(core.remote.devices()).toHaveLength(1);
  });

  it("lets a paired device in with view scope only", async () => {
    const c = await connect(route, { hostKey, device });
    const client = rpc(await c.session);
    const boot = await client.call("remote.bootstrap", {});
    expect(boot.device).toEqual({ id: deviceId, scope: "view" });
    expect(boot.workspaces.length).toBeGreaterThan(0);
    expect(await client.call("pane.list", {})).toEqual([]);
    await expect(client.call("settings.get", {})).rejects.toThrow(RpcError);
    await expect(client.call("pane.create", {})).rejects.toThrow(/needs control access/);
    await expect(client.call("fs.read", { path: "/etc/passwd" })).rejects.toThrow(/outside your workspaces/);
    c.ws.close();
  });

  it("follows the scope the Mac sets", async () => {
    await core.call("remote.setScope", { id: deviceId, scope: "control" });
    const c = await connect(route, { hostKey, device });
    const client = rpc(await c.session);
    await client.call("remote.bootstrap", {});
    const pane = await client.call("pane.create", {});
    // Output reaches a session only for panes it follows.
    const got: CoreEvent[] = [];
    client.onEvent((e) => got.push(e));
    await client.call("window.follow", { ids: [pane.id] });
    await client.call("pane.write", { paneId: pane.id, data: "x" });
    expect(got.some((e) => e.type === "settings.updated")).toBe(false);
    // The Mac sees who is in, what they watch, and where they type.
    expect(core.remote.status().sessions).toMatchObject([{ deviceId, name: "Test Phone", scope: "control", watching: [pane.id] }]);
    expect(events).toContainEqual({ type: "remote.input", deviceId, name: "Test Phone", paneId: pane.id });
    c.ws.close();
    await expect.poll(() => core.remote.status().sessions).toEqual([]);
  });

  it("disconnects without unpairing", async () => {
    const c = await connect(route, { hostKey, device });
    await c.session;
    await core.call("remote.disconnect", {});
    await expect.poll(c.closed).toBe(true);
    expect(core.remote.devices()).toHaveLength(1);
    expect((await core.call("remote.log", {}))[0]).toMatchObject({ kind: "disconnected", detail: "all" });
  });

  it("sizes a terminal to the phone until the Mac takes it back", async () => {
    const c = await connect(route, { hostKey, device });
    const client = rpc(await c.session);
    const pane = await core.call("pane.create", { cols: 120, rows: 40 });
    const size = () => core.panes.get(pane.id)!;
    await client.call("pane.fitOverride", { paneId: pane.id, cols: 48, rows: 30 });
    expect(size()).toMatchObject({ cols: 48, rows: 30, sizedBy: "Test Phone" });
    // The desktop keeps fitting its window: remembered, not applied.
    await core.call("pane.resize", { paneId: pane.id, cols: 130, rows: 42 });
    expect(size()).toMatchObject({ cols: 48, rows: 30 });
    // A terminal's own reports (focus, cursor position) aren't someone typing at the Mac.
    const local = core.serve({ access: "local", send: () => {}, close: () => {} });
    local.receive(JSON.stringify({ id: 1, method: "pane.write", params: { paneId: pane.id, data: "\x1b[I" } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(size().sizedBy).toBe("Test Phone");
    local.receive(JSON.stringify({ id: 2, method: "pane.write", params: { paneId: pane.id, data: "l" } }));
    await expect.poll(() => size()).toMatchObject({ cols: 130, rows: 42, sizedBy: null });
    // Out of range, or from a view-only device: refused.
    await expect(client.call("pane.fitOverride", { paneId: pane.id, cols: 5, rows: 30 })).rejects.toThrow(/range/);
    // Disconnecting gives it back too.
    await client.call("pane.fitOverride", { paneId: pane.id, cols: 50, rows: 20 });
    expect(size().sizedBy).toBe("Test Phone");
    c.ws.close();
    await expect.poll(() => size()).toMatchObject({ cols: 130, rows: 42, sizedBy: null });
  });

  it("refuses unknown devices", async () => {
    const c = await connect(route, { hostKey, device: await generateKeyPair() });
    await expect.poll(c.closed).toBe(true);
  });

  it("closes a revoked device's session at once", async () => {
    const c = await connect(route, { hostKey, device });
    await c.session;
    await core.call("remote.revoke", { id: deviceId });
    await expect.poll(c.closed).toBe(true);
    const again = await connect(route, { hostKey, device });
    await expect.poll(again.closed).toBe(true);
  });

  it("logs what happened, as events in the log", async () => {
    const kinds = (await core.call("remote.log", { limit: 500 })).map((r) => r.kind);
    expect(core.data.query({ types: ["remote.audit"], limit: 500 }).length).toBe(kinds.length);
    for (const k of ["enabled", "paired", "session", "denied", "pair-denied", "handshake-failed", "revoked"]) expect(kinds).toContain(k);
  });
});
