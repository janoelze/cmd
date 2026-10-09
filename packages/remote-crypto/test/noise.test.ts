import { describe, expect, it } from "vitest";
import vectors from "./vectors.json" with { type: "json" };
import {
  decodePairing,
  encodePairing,
  fingerprint,
  frame,
  generateKeyPair,
  Handshake,
  importPrivateKey,
  LineOpener,
  openDeviceSession,
  PROLOGUE,
  randomBytes,
  sealLine,
  toBase64Url,
  unframe,
  utf8,
  Wire,
  WORDS,
  type Bytes,
} from "../src/index.ts";

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16)) as Bytes;
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("Noise test vectors (cacophony)", () => {
  for (const v of vectors) {
    it(v.protocol_name, async () => {
      const pattern = v.protocol_name.includes("psk1") ? "IKpsk1" : "IK";
      const psk = "init_psks" in v ? hex((v as { init_psks: string[] }).init_psks[0]!) : undefined;
      const init = await Handshake.create({
        pattern, initiator: true, psk, prologue: hex(v.init_prologue),
        s: await importPrivateKey(hex(v.init_static)), e: await importPrivateKey(hex(v.init_ephemeral)), rs: hex(v.init_remote_static),
      });
      const resp = await Handshake.create({
        pattern, initiator: false, psk, prologue: hex(v.resp_prologue),
        s: await importPrivateKey(hex(v.resp_static)), e: await importPrivateKey(hex(v.resp_ephemeral)),
      });
      const [m1, m2, ...rest] = v.messages;
      expect(toHex(await init.writeMessage(hex(m1!.payload)))).toBe(m1!.ciphertext);
      expect(toHex(await resp.readMessage(hex(m1!.ciphertext)))).toBe(m1!.payload);
      expect(toHex(await resp.writeMessage(hex(m2!.payload)))).toBe(m2!.ciphertext);
      expect(toHex(await init.readMessage(hex(m2!.ciphertext)))).toBe(m2!.payload);
      expect(toHex(init.hash)).toBe(v.handshake_hash);
      const ti = await init.transport();
      const tr = await resp.transport();
      for (const [i, m] of rest.entries()) {
        const [a, b] = i % 2 === 0 ? [ti, tr] : [tr, ti];
        expect(toHex(await a.encrypt(hex(m.payload)))).toBe(m.ciphertext);
        expect(toHex(await b.decrypt(hex(m.ciphertext)))).toBe(m.payload);
      }
    });
  }
});

async function pair(psk?: Bytes, respPsk = psk) {
  const host = await generateKeyPair();
  const device = await generateKeyPair();
  const init = await Handshake.create({ pattern: psk ? "IKpsk1" : "IK", initiator: true, s: device, rs: host.publicKey, psk, prologue: PROLOGUE });
  const resp = await Handshake.create({ pattern: respPsk ? "IKpsk1" : "IK", initiator: false, s: host, psk: respPsk, prologue: PROLOGUE });
  return { host, device, init, resp };
}

describe("handshake", () => {
  it("tells the responder who the initiator is", async () => {
    const { device, init, resp } = await pair();
    await resp.readMessage(await init.writeMessage(utf8("hi")));
    expect(toHex(resp.remoteStatic!)).toBe(toHex(device.publicKey));
    expect(toHex(resp.hash)).toBe(toHex(init.hash));
  });

  it("refuses message 1 under a different PSK", async () => {
    const { init, resp } = await pair(randomBytes(32), randomBytes(32));
    await expect(resp.readMessage(await init.writeMessage())).rejects.toThrow(/decryption failed/);
  });

  it("refuses a host that isn't the expected key", async () => {
    const { init } = await pair();
    const impostor = await Handshake.create({ pattern: "IK", initiator: false, s: await generateKeyPair(), prologue: PROLOGUE });
    await expect(impostor.readMessage(await init.writeMessage())).rejects.toThrow();
  });

  it("refuses tampered and replayed transport messages", async () => {
    const { init, resp } = await pair();
    await resp.readMessage(await init.writeMessage());
    await init.readMessage(await resp.writeMessage());
    const [ti, tr] = [await init.transport(), await resp.transport()];
    const ct = await ti.encrypt(utf8("ls"));
    const bad = ct.slice();
    bad[0]! ^= 1;
    await expect(tr.decrypt(bad)).rejects.toThrow();
    expect(new TextDecoder().decode(await tr.decrypt(ct))).toBe("ls");
    await expect(tr.decrypt(ct)).rejects.toThrow(); // replay: the nonce moved on
  });
});

describe("lines", () => {
  it("splits and reassembles long lines", async () => {
    const { init, resp } = await pair();
    await resp.readMessage(await init.writeMessage());
    await init.readMessage(await resp.writeMessage());
    const opener = new LineOpener(await resp.transport());
    const line = JSON.stringify({ data: "é".repeat(100_000) });
    const frames = await sealLine(await init.transport(), line);
    expect(frames.length).toBeGreaterThan(1);
    const out = [];
    for (const f of frames) out.push(await opener.open(unframe(f).body));
    expect(out.slice(0, -1).every((x) => x === null)).toBe(true);
    expect(out.at(-1)).toBe(line);
  });
});

describe("device session", () => {
  it("pairs, shows matching words on both sides, and exchanges lines", async () => {
    const host = await generateKeyPair();
    const psk = randomBytes(32);
    const toHost: Bytes[] = [];
    let words: string[] = [];
    const { receive, session } = openDeviceSession({
      socket: { send: (b) => toHost.push(b), close: () => {} },
      hostKey: host.publicKey, device: await generateKeyPair(), psk, hello: { name: "test" },
      onFingerprint: (w) => (words = w),
    });
    await expect.poll(() => toHost.length).toBe(1);
    const f = unframe(toHost.shift()!);
    expect(f.kind).toBe(Wire.pair);
    const hs = await Handshake.create({ pattern: "IKpsk1", initiator: false, s: host, psk, prologue: PROLOGUE });
    expect(JSON.parse(new TextDecoder().decode(await hs.readMessage(f.body)))).toEqual({ name: "test" });
    expect(fingerprint(hs.hash)).toEqual(words);
    receive(frame(Wire.reply, await hs.writeMessage(utf8(JSON.stringify({ deviceId: "d1" })))));
    const s = await session;
    expect(s.host).toEqual({ deviceId: "d1" });
    const t = await hs.transport();
    await s.send('{"x":1}');
    expect(await new LineOpener(t).open(unframe(toHost[0]!).body)).toBe('{"x":1}');
    const got: string[] = [];
    s.onLine((l) => got.push(l));
    for (const fr of await sealLine(t, "pong")) receive(fr);
    await expect.poll(() => got).toEqual(["pong"]);
  });
});

describe("pairing link", () => {
  it("round-trips and rejects junk", async () => {
    const p = { socket: "wss://relay.example.com", route: toBase64Url(randomBytes(16)), hostKey: randomBytes(32), psk: randomBytes(32) };
    const back = decodePairing("#" + encodePairing(p));
    expect(back.socket).toBe(p.socket);
    expect(toHex(back.psk)).toBe(toHex(p.psk));
    expect(() => decodePairing("v1.a.b.c")).toThrow();
    expect(() => decodePairing(encodePairing({ ...p, socket: "https://x" }))).toThrow();
  });

  it("keeps the positional format links made before `relay` became `socket` use", () => {
    const [route, hostKey, psk] = [randomBytes(16), randomBytes(32), randomBytes(32)].map(toBase64Url);
    const old = `v1.${toBase64Url(new TextEncoder().encode("wss://relay.example.com"))}.${route}.${hostKey}.${psk}`;
    expect(decodePairing(old)).toMatchObject({ socket: "wss://relay.example.com", route });
  });

  it("has 256 distinct words", () => {
    expect(new Set(WORDS).size).toBe(256);
  });
});
