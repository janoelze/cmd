// A client that (re)attaches to a terminal applies the core's snapshot, then the output
// after it: every byte exactly once. Checked against a pane printing continuously, over
// each path output takes: the core's own terminals, the PTY host, and a remote session
// (the relay, with its output coalescing).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import headless from "@xterm/headless";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RpcClient, type CoreEvent } from "@cmd/protocol";
import { OutputGate } from "@cmd/protocol/replay";
import { decodePairing, generateKeyPair, openDeviceSession } from "@cmd/remote-crypto";
import { startRelay, type Relay } from "../../../apps/relay/src/relay.ts";
import { Core } from "../src/core.ts";
import { PtyHost } from "../src/terminals/host.ts";
import { RemoteBackend } from "../src/terminals/remote.ts";
import { fakeFactory, type FakePty } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";
import { until } from "../../../test/system.ts";

type Snap = { data: string; cols: number; rows: number; seq?: number };
type Output = Extract<CoreEvent, { type: "pane.output" }>;
/** What a client saw, in wire order. */
type Seen = { kind: "output"; e: Output } | { kind: "snapshot"; snap: Snap };

let dir: string;
const cleanup: (() => Promise<void> | void)[] = [];
beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-snaporder-")));
});
afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn();
  rmTemp(dir);
});

/** Print numbered lines in small bursts, one burst a task, until stopped; `count` is the last line printed. */
function printer(pty: FakePty) {
  let n = 0;
  let on = true;
  const tick = () => {
    if (!on) return;
    let s = "";
    for (let i = 0; i < 3; i++) s += `L${++n}\r\n`;
    pty.output(s);
    setImmediate(tick);
  };
  setImmediate(tick);
  return { stop: () => void (on = false), get count() { return n; } };
}

/** The lines a client shows after applying what it saw the way `apply` decides. */
async function screen(seen: Seen[], apply: (seen: Seen[]) => { snap: Snap; writes: string[] }): Promise<number[]> {
  const { snap, writes } = apply(seen);
  const t = new headless.Terminal({ cols: snap.cols, rows: snap.rows, scrollback: 100_000, allowProposedApi: true });
  for (const d of [snap.data, ...writes]) await new Promise<void>((r) => t.write(d, r));
  const out: number[] = [];
  const buf = t.buffer.active;
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)?.translateToString(true) ?? "";
    if (!line) continue;
    const m = /^L(\d+)$/.exec(line);
    // A torn line: part of the output written twice, or lost.
    if (!m) throw new Error(`line ${i} reads ${JSON.stringify(line)}`);
    out.push(Number(m[1]));
  }
  t.dispose();
  return out;
}

const isSnap = (r: unknown): r is Snap => typeof r === "object" && r !== null && "data" in r && "cols" in r;

/** What a client writes: the snapshot, then the output an OutputGate lets through, in wire order. */
function gated(legacy: "keep" | "drop") {
  return (seen: Seen[]) => {
    const gate = new OutputGate(legacy); // waits: the snapshot was asked for before anything here arrived
    let snap: Snap | null = null;
    const writes: string[] = [];
    for (const s of seen) {
      if (s.kind === "snapshot") {
        snap = s.snap;
        expect(snap.seq, "the snapshot carries seq").toBeTypeOf("number");
        writes.push(gate.snapshot(snap.seq));
      } else {
        expect(s.e.seq, "pane.output carries seq").toBeTypeOf("number");
        writes.push(gate.output(s.e.data, s.e.seq));
      }
    }
    return { snap: snap!, writes };
  };
}

/** Every line from the first shown to the last printed, once each. */
function expectExact(lines: number[], last: number): void {
  const dupes = lines.filter((n, i) => lines.indexOf(n) !== i);
  const first = lines[0] ?? 1;
  const missing: number[] = [];
  for (let n = first; n <= last; n++) if (!lines.includes(n)) missing.push(n);
  expect({ dupes: dupes.slice(0, 10), missing: missing.slice(0, 10) }).toEqual({ dupes: [], missing: [] });
  expect(lines.at(-1)).toBe(last);
}

/** Snapshot a printing pane a few times, record what arrives after the last ask, and check what a client shows. */
async function check(o: {
  pty: () => FakePty;
  call: (method: string, params: object) => Promise<unknown>;
  seen: Seen[];
}): Promise<void> {
  const p = printer(o.pty());
  await until("some output", () => p.count > 300);
  // Several snapshots in a row, as a re-attach or a resync would ask.
  for (let round = 0; round < 3; round++) {
    o.seen.length = 0;
    await o.call("pane.snapshot", {});
    const at = p.count;
    await until("output after the snapshot", () => p.count > at + 300);
  }
  p.stop();
  const last = p.count;
  await until("the last line delivered", () => o.seen.some((s) => s.kind === "output" && s.e.data.includes(`L${last}\r\n`)));
  // The app drops what waited for an older core's snapshot, the web client keeps it; both by seq here.
  expectExact(await screen(o.seen, gated("drop")), last);
  expectExact(await screen(o.seen, gated("keep")), last);
}

/** A local client (the app) over Core.serve(), seeing every event and reply in order. */
function localClient(core: Core) {
  const seen: Seen[] = [];
  const waits = new Map<number, (r: unknown) => void>();
  let id = 0;
  const served = core.serve({
    access: "local",
    send: (line) => {
      const msg = JSON.parse(line);
      if (msg.method === "event") {
        if (msg.params.type === "pane.output") seen.push({ kind: "output", e: msg.params });
      } else {
        if (isSnap(msg.result)) seen.push({ kind: "snapshot", snap: msg.result });
        waits.get(msg.id)?.(msg.result);
      }
    },
    close: () => {},
  });
  const call = (method: string, params: object) =>
    new Promise<unknown>((resolve) => {
      waits.set(++id, resolve);
      served.receive(JSON.stringify({ id, method, params }));
    });
  return { seen, call };
}

describe("a snapshot and the output after it", () => {
  it("the core's own terminals, to a local client", async () => {
    const f = fakeFactory();
    const core = new Core({ socketPath: path.join(dir, "a.sock"), dbPath: null, settingsPath: null, terminals: f.factory, pollMs: 0, home: dir });
    cleanup.push(() => core.close());
    const pane = core.panes.create({ cwd: dir, rows: 24, cols: 80 });
    const c = localClient(core);
    await c.call("events.subscribe", {});
    await check({ pty: () => f.ptys[0]!, seen: c.seen, call: (m, p) => c.call(m, { ...p, paneId: pane.id }) });
  });

  it("terminals in the PTY host, to a local client", async () => {
    const f = fakeFactory();
    const host = new PtyHost(f.factory, { idleMs: 60_000 });
    const hostSock = path.join(dir, "host.sock");
    await host.listen(hostSock);
    cleanup.push(() => host.close());
    const core = new Core({ socketPath: path.join(dir, "b.sock"), dbPath: null, settingsPath: null, terminals: await RemoteBackend.connect(hostSock), pollMs: 0, home: dir });
    cleanup.push(() => core.close());
    const pane = core.panes.create({ cwd: dir, rows: 24, cols: 80 });
    await until("the terminal started", () => core.panes.get(pane.id)!.pid > 0);
    const c = localClient(core);
    await c.call("events.subscribe", {});
    await check({ pty: () => f.ptys[0]!, seen: c.seen, call: (m, p) => c.call(m, { ...p, paneId: pane.id }) });
  });

  describe("a remote session", () => {
    let relay: Relay;
    beforeAll(async () => {
      relay = await startRelay({ log: () => {} });
      cleanup.push(() => relay.close());
    });

    it("through the relay, output coalesced", async () => {
      const f = fakeFactory();
      const core = new Core({ socketPath: path.join(dir, "c.sock"), dbPath: null, settingsPath: null, terminals: f.factory, pollMs: 0, home: dir });
      cleanup.push(() => core.close());
      const asks: string[] = [];
      core.settings.set("remote.relay", relay.url);
      core.settings.set("remote.client", "https://client.test");
      // Approve the pairing as the person on the Mac would.
      core.serve({
        access: "local",
        send: (line) => {
          const msg = JSON.parse(line);
          if (msg.params?.type === "remote.pairRequest") asks.push(msg.params.request.requestId);
        },
        close: () => {},
      }).receive(JSON.stringify({ id: 1, method: "events.subscribe", params: {} }));
      await core.call("remote.enable", {});
      await core.remote.ready();
      await until("the relay link online", () => core.remote.status().state === "online");
      const link = decodePairing(new URL((await core.call("remote.pair", { scope: "view" })).url).hash);
      const ws = new WebSocket(`${relay.url}/r/${link.route}`);
      ws.binaryType = "arraybuffer";
      await new Promise((r) => (ws.onopen = r));
      cleanup.push(() => ws.close());
      const dev = openDeviceSession({ hostKey: link.hostKey, device: await generateKeyPair(), psk: link.psk, hello: { name: "Test Phone" }, socket: { send: (b) => ws.send(b), close: () => ws.close() } });
      ws.onmessage = (e) => dev.receive(new Uint8Array(e.data as ArrayBuffer));
      await until("the pairing request", () => asks.length > 0);
      await core.call("remote.approve", { requestId: asks[0]!, allow: true });
      const s = await dev.session;
      const client = new RpcClient((line) => void s.send(line));
      // Replies and events in the order they arrive, as the web client sees them.
      const seen: Seen[] = [];
      s.onLine((l) => {
        const msg = JSON.parse(l);
        if (msg.method === "event" && msg.params.type === "pane.output") seen.push({ kind: "output", e: msg.params });
        else if (isSnap(msg.result)) seen.push({ kind: "snapshot", snap: msg.result });
        client.receive(l);
      });
      await client.call("remote.bootstrap", {});
      const pane = core.panes.create({ cwd: dir, rows: 24, cols: 80 });
      await client.call("window.follow", { ids: [pane.id] });
      await check({ pty: () => f.ptys[0]!, seen, call: (m, p) => client.call(m as "pane.snapshot", { ...p, paneId: pane.id } as never) });
    });
  });
});
