// `pnpm phone:pair release|dev [--control] [--origin URL] [--json]`: a one-time
// pairing link from that core, as `cmd remote pair` makes it, pointed at the
// phone origin (link.ts): the page opens there and the device dials /c/<target>.
// The release app's settings are never touched; a dev core with remote access
// off (or on the relay) is switched to "Your own URL" on its loopback port,
// which is all the proxy needs (targets.ts reachable(), as phone:use does).
// The four words and the approval happen on the Mac as usual: here, or in the
// app's own sheet.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type { RemotePairRequest, RemoteScope } from "../../packages/protocol/src/index.ts";
import { connect } from "../../packages/protocol/src/node.ts";
import { rewriteLink } from "./link.ts";
import { phoneHome, reachable, resolveTarget, stateDir, TARGETS, type TargetName } from "./targets.ts";

const root = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const name = args.find((a) => !a.startsWith("--")) as TargetName | undefined;
if (!name || !TARGETS.includes(name)) fail("usage: pnpm phone:pair release|dev [--control] [--origin URL] [--json]");
const target = resolveTarget(name!);
const scope: RemoteScope = args.includes("--control") ? "control" : "view";
const json = args.includes("--json");

/** The phone origin: --origin, else the running phone:serve's. */
function phoneOrigin(): string {
  const i = args.indexOf("--origin");
  if (i >= 0) return new URL(args[i + 1] ?? "").origin;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(stateDir(), "serve.json"), "utf8")) as { origin: string; pid: number };
    process.kill(s.pid, 0);
    return s.origin;
  } catch {
    return fail("pnpm phone:serve isn't running. Start it first (or pass --origin).");
  }
}
const origin = phoneOrigin();

const where = target.instance === "release" ? "the installed cmd" : target.home === phoneHome() ? "the phone's dev core" : (target.home ?? "cmd dev");
const conn = await connect(target.socket).catch(() => fail(`No ${name} core is running (${where}). ${name === "dev" ? "pnpm phone:core starts it." : "Open cmd, then try again."}`));
const call = conn.client.call.bind(conn.client);
if (name === "release") {
  const st = await call("remote.status", {});
  if (!st.enabled || st.access === "relay")
    fail(`The installed cmd has ${!st.enabled ? "remote access off" : "remote access on the hosted relay"}, so it has no local listener for /c/release.
phone:pair never changes its settings. To use /c/release, turn on remote access through Tailscale or Your own URL in cmd: Settings → Remote Access.
Phones paired through the relay pair again after that switch. docs/56-phone-development.md says more.`);
  if (st.state !== "online") fail(`The installed cmd's remote access isn't ready${st.error ? `: ${st.error}` : "."}`);
} else {
  // A dev core: its own loopback listener as "Your own URL" is all the proxy needs (as phone:use does).
  const { info, changed } = await reachable(target, conn);
  if (changed && !json) console.log(`Turned on remote access for ${where} (Your own URL, 127.0.0.1:${info.port}).`);
  if (!info.origin) fail(`The dev core's remote access isn't ready: ${info.error}`);
  if (!json && target.home !== phoneHome()) console.log(`/c/dev points at ${target.home}, not the phone's dev core: this pairing holds for that core only.\n`);
}

const requests: RemotePairRequest[] = [];
const ended = new Set<string>();
let wake = () => {};
conn.client.onEvent((e) => {
  if (e.type === "remote.pairRequest") requests.push(e.request);
  if (e.type === "remote.pairEnded") ended.add(e.requestId);
  wake();
});
await call("events.subscribe", { types: ["remote.pairRequest", "remote.pairEnded"] });
const { url, expiresAt } = await call("remote.pair", { scope });
const link = rewriteLink(url, origin, name!);

if (json) {
  console.log(JSON.stringify({ link, url, expiresAt }));
  conn.close();
  process.exit(0);
}
// uqr is apps/web's dependency, not the root's.
const { renderUnicodeCompact } = (await import(pathToFileURL(path.join(root, "apps/web/node_modules/uqr/dist/index.mjs")).href)) as { renderUnicodeCompact(s: string, o: object): string };
console.log(renderUnicodeCompact(link, { ecc: "L", border: 2 }));
console.log(`Scan with your phone's camera, or open:\n${link}\n\nPairs with ${where} through ${origin}/c/${name}. Works once, for 5 minutes.\nWaiting for your phone… (Ctrl-C to cancel)`);

while (Date.now() < expiresAt) {
  const req = requests.shift();
  if (!req) {
    await new Promise<void>((r) => ((wake = r), setTimeout(r, 1000)));
    continue;
  }
  if (ended.has(req.requestId)) continue;
  console.log(`\n“${req.name}” wants to use cmd on this Mac.\nCheck that its screen shows:  ${req.words.join(" ")}\nAnswer here or in cmd.\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ac = new AbortController();
  // Answered in the app: stop asking here.
  const watch = setInterval(() => ended.has(req.requestId) && ac.abort(), 200);
  const answer = await rl.question("Allow? [v]iew only, [c]ontrol (a shell on this Mac), [n]o: ", { signal: ac.signal }).catch(() => null);
  clearInterval(watch);
  rl.close();
  if (answer === null) {
    console.log("\nAnswered in cmd");
    break;
  }
  const chosen: RemoteScope | null = answer.trim().toLowerCase().startsWith("c") ? "control" : answer.trim().toLowerCase().startsWith("v") ? "view" : null;
  await call("remote.approve", { requestId: req.requestId, allow: !!chosen, scope: chosen ?? undefined }).catch((e: Error) => console.log(e.message));
  console.log(chosen ? `paired ${req.name} (${chosen === "view" ? "view only" : "control"})` : "not allowed");
  break;
}
if (Date.now() >= expiresAt) console.log("The pairing link expired. Run pnpm phone:pair again for a new one.");
conn.close();
process.exit(0);
