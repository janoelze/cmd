// A pretend phone for developing remote access before the web client exists:
// pairs from a pairing link and calls the core through the relay (or straight to
// the Mac in a direct mode), end-to-end encrypted, exactly as a browser would.
//
//   pnpm remote:device pair '<pairing url>' [name]
//   pnpm remote:device call <method> ['<params json>']
//   pnpm remote:device watch      # bootstrap, then print events
//
// Its identity lives in $CMD_HOME/remote-device.json (default ./.cmd-dev); one
// saved before direct modes has the socket as `relay`.

import fs from "node:fs";
import path from "node:path";
import { RpcClient, type Method } from "@cmd/protocol";
import { decodePairing, exportKeyPair, fromBase64Url, generateKeyPair, importKeyPair, openDeviceSession, toBase64Url, type Bytes, type KeyPair } from "@cmd/remote-crypto";

const file = path.join(process.env.CMD_HOME ?? ".cmd-dev", "remote-device.json");
const [cmd, ...args] = process.argv.slice(2);

interface Saved {
  key: JsonWebKey;
  socket?: string;
  /** What `socket` was called before. */
  relay?: string;
  route: string;
  hostKey: string;
}

async function open(o: { socket: string; route: string; hostKey: Bytes; device: KeyPair; psk?: Bytes; name?: string }) {
  const ws = new WebSocket(`${o.socket.replace(/\/+$/, "")}/r/${o.route}`);
  ws.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = () => reject(new Error("can't reach the Mac")))));
  const { receive, closed, session } = openDeviceSession({
    socket: { send: (b) => ws.send(b), close: () => ws.close() },
    hostKey: o.hostKey,
    device: o.device,
    psk: o.psk,
    hello: { name: o.name ?? "remote-device.ts" },
    onFingerprint: (w) => o.psk && console.error(`words: ${w.join(" ")} (approve on the Mac)`),
  });
  ws.onmessage = (e) => receive(new Uint8Array(e.data as ArrayBuffer));
  ws.onclose = () => {
    closed();
    if (cmd === "watch") process.exit(0);
  };
  const s = await session.catch((err: Error) => {
    console.error(`error: ${err.message} (not paired, or revoked?)`);
    process.exit(1);
  });
  const client = new RpcClient((line) => void s.send(line));
  s.onLine((l) => client.receive(l));
  return { s, client, ws };
}

async function saved() {
  const d = JSON.parse(fs.readFileSync(file, "utf8")) as Saved;
  return open({ socket: d.socket ?? d.relay!, route: d.route, hostKey: fromBase64Url(d.hostKey), device: await importKeyPair(d.key) });
}

if (cmd === "pair") {
  const link = decodePairing(new URL(args[0]!).hash);
  const device = await generateKeyPair(true);
  const { s, ws } = await open({ ...link, device, name: args[1] });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const doc: Saved = { key: await exportKeyPair(device), socket: link.socket, route: link.route, hostKey: toBase64Url(link.hostKey) };
  fs.writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
  console.log(`paired: ${JSON.stringify(s.host)}`);
  ws.close();
} else if (cmd === "call") {
  const { client, ws } = await saved();
  try {
    console.log(JSON.stringify(await client.call(args[0] as Method, JSON.parse(args[1] ?? "{}") as never), null, 2));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
  ws.close();
} else if (cmd === "watch") {
  const { client } = await saved();
  client.onEvent((e) => console.log(JSON.stringify(e).slice(0, 200)));
  const boot = await client.call("remote.bootstrap", {});
  console.log(`bootstrap: ${boot.workspaces.length} Workspaces, ${boot.panes.length} terminals, device ${JSON.stringify(boot.device)}`);
  await client.call("window.follow", { ids: boot.panes.map((p) => p.id).slice(0, 64) });
} else {
  console.error("usage: pnpm remote:device pair <url> [name] | call <method> [params] | watch");
  process.exitCode = 2;
}
