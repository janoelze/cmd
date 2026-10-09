// `cmd remote …`: remote access from a phone or browser (docs/13-remote-access.md,
// docs/38-direct-remote-access.md). Status, pairing, devices, and how phones reach
// this Mac: the hosted relay, Tailscale or your own URL, with each mode's setup checks.

import readline from "node:readline/promises";
import type { AppWindow, RemoteAccessCheck, RemoteDevice, RemotePairRequest, RemoteScope, RemoteSession, RemoteStatus } from "@cmd/protocol";
import { SETTINGS_SCHEMA } from "@cmd/protocol";
import type { Connection } from "@cmd/protocol/node";
import { renderUnicodeCompact } from "uqr";

type Client = Connection["client"];

export const REMOTE_HELP = `  remote [status|on|off]              remote access from a phone or browser (end-to-end encrypted):
                                      how phones reach this Mac, who is connected and what they're watching
  remote access relay|tailscale|url [URL]
                                      how phones reach this Mac: the hosted relay, Tailscale or your own URL
  remote setup [tailscale|url] [--json]
                                      check what that mode needs (default: the one in use)
  remote pair                         a one-time QR code; approve the device here
  remote devices | log                paired devices | recent activity
  remote disconnect [DEVICE]          close live sessions (devices stay paired)
  remote revoke DEVICE | scope DEVICE view|control
                                      unpair a device | change what it may do`;

export const ACCESS_MODES = SETTINGS_SCHEMA["remote.access"].options as readonly string[];
const ACCESS_LABELS: Record<string, string> = SETTINGS_SCHEMA["remote.access"].labels ?? {};
/** "Hosted relay", "Tailscale", "Your own URL". */
export const accessLabel = (mode: string) => ACCESS_LABELS[mode] ?? mode;

const REMOTE_STATE: Record<RemoteStatus["state"], string> = { off: "off", connecting: "connecting…", online: "ready", error: "can't connect" };

/** The first line of `cmd remote`: state, then how phones reach this Mac (the relay only in relay mode). */
export function statusLine(st: RemoteStatus): string {
  const where = (st.access ?? "relay") === "relay" ? `${accessLabel("relay")} ${st.relay}` : [accessLabel(st.access), st.address].filter(Boolean).join("  ·  ");
  return `Remote access: ${REMOTE_STATE[st.state]}${st.error ? ` (${st.error})` : ""}  ·  ${where}`;
}

export function sessionLine(s: RemoteSession, title: (id: string) => string): string {
  const watching = s.watching.length ? `watching ${s.watching.map(title).join(", ")}` : "on its home screen";
  const who = [s.user, s.ip].filter(Boolean).join(", ");
  return `${s.name.padEnd(24)} ${(s.scope === "view" ? "view only" : "control").padEnd(10)} since ${new Date(s.since).toLocaleTimeString()}  ${watching}${who ? `  (${who})` : ""}`;
}

const MARK: Record<RemoteAccessCheck["state"], string> = { ok: "✓", todo: "•", error: "✗" };

/** A setup check: the marker and title, then what to do and where, indented. */
export function checkLines(c: RemoteAccessCheck): string[] {
  return [`${MARK[c.state]} ${c.title}`, ...(c.detail ? [`  ${c.detail}`] : []), ...(c.link ? [`  ${c.link}`] : [])];
}

/**
 * `remote access MODE [URL]` → the settings to write. A URL is only for `url`; `url`
 * without one keeps the saved `remote.url`, and errors when there is none.
 */
export function parseAccess(args: string[], savedUrl: string): { access: string; url?: string } | { error: string } {
  const [mode, url] = args;
  if (!mode || !ACCESS_MODES.includes(mode)) return { error: "usage: cmd remote access relay|tailscale|url [URL]" };
  if (mode !== "url") return url ? { error: `only Your own URL takes an address (cmd remote access url ${url})` } : { access: mode };
  if (!url) return savedUrl ? { access: mode } : { error: "Your own URL needs an address: cmd remote access url https://mac.example.com" };
  // The rest (HTTPS, no path) is the setup checks' to say.
  if (!URL.canParse(url)) return { error: `${url} isn't a URL. Try one like https://mac.example.com` };
  return { access: mode, url: url.trim() };
}

export async function remoteCommand(client: Client, pos: string[], opt: Record<string, unknown>): Promise<number> {
  const [sub = "status", ...rest] = pos;
  const scopeArg = (v: unknown): RemoteScope | undefined => (v === "view" || v === "control" ? v : undefined);
  const find = async (prefix: string | undefined) => {
    const ds = (await client.call("remote.devices", {})).filter((d) => prefix && (d.id.startsWith(prefix) || d.name.toLowerCase().startsWith(prefix.toLowerCase())));
    if (ds.length !== 1) throw new Error(ds.length ? `ambiguous device: ${prefix}` : `no such device: ${prefix ?? "(none given)"}`);
    return ds[0]!;
  };
  switch (sub) {
    case "status":
    case "on":
    case "off": {
      const before = sub === "off" ? (await client.call("remote.status", {})).sessions.length : 0;
      const st = await client.call(sub === "on" ? "remote.enable" : sub === "off" ? "remote.disable" : "remote.status", {});
      if (opt.json) return out(st);
      printRemote(st, await client.call("window.list", {}));
      if (sub === "off" && before) console.log(`\nclosed ${before} session${before === 1 ? "" : "s"}`);
      if (sub === "on" && st.state !== "online" && (st.access ?? "relay") !== "relay") console.log("\nnext: cmd remote setup");
      else if (sub === "on" && st.state !== "error" && !st.devices.length) console.log("\nnext: cmd remote pair");
      return 0;
    }
    case "access":
      return access(client, rest);
    case "setup":
      return setup(client, rest[0], !!opt.json);
    case "devices": {
      const ds = await client.call("remote.devices", {});
      if (opt.json) return out(ds);
      if (!ds.length) return out("no paired devices (cmd remote pair)");
      for (const d of ds) console.log(remoteDevice(d));
      return 0;
    }
    case "log": {
      const log = await client.call("remote.log", { limit: Number(opt.limit ?? 30) });
      if (opt.json) return out(log);
      for (const e of log.reverse()) console.log(`${new Date(e.at).toLocaleString().padEnd(22)} ${e.kind.padEnd(16)} ${(e.device ?? (e.deviceId ? short(e.deviceId) : "")).padEnd(20)} ${e.detail ?? ""}`);
      return 0;
    }
    case "revoke": {
      const d = await find(rest[0]);
      await client.call("remote.revoke", { id: d.id });
      return out(`unpaired ${d.name}`);
    }
    case "disconnect": {
      const d = rest[0] ? await find(rest[0]) : null;
      await client.call("remote.disconnect", { id: d?.id });
      return out(d ? `disconnected ${d.name} (still paired)` : "disconnected every device (still paired)");
    }
    case "scope": {
      const scope = scopeArg(rest[1]);
      if (!scope) return fail("usage: cmd remote scope <device> view|control");
      const d = await client.call("remote.setScope", { id: (await find(rest[0])).id, scope });
      return out(`${d.name}: ${d.scope === "view" ? "view only" : "control"}`);
    }
    case "pair":
      return remotePair(client, scopeArg(opt.scope) ?? "view", !!opt.json);
    default:
      return fail(`unknown remote command: ${sub} (cmd help)`);
  }
}

/** Switch how phones reach this Mac. Devices paired over another mode pair again (another origin and route). */
async function access(client: Client, args: string[]): Promise<number> {
  const { settings } = await client.call("settings.get", {});
  const was = String(settings["remote.access"]);
  const savedUrl = String(settings["remote.url"] ?? "");
  if (!args.length) return out(`${accessLabel(was)}${was === "url" && savedUrl ? `  ·  ${savedUrl}` : ""}`);
  const want = parseAccess(args, savedUrl);
  if ("error" in want) return fail(want.error);
  if (want.access === was && (want.url === undefined || want.url === savedUrl)) return out(`already using ${accessLabel(was)}`);
  if (want.url !== undefined) await client.call("settings.set", { key: "remote.url", value: want.url });
  if (want.access !== was) await client.call("settings.set", { key: "remote.access", value: want.access });
  const url = want.url ?? savedUrl;
  console.log(`${accessLabel(want.access)}${want.access === "url" ? `  ·  ${url}` : ""}${want.access !== was ? ` (was ${accessLabel(was)})` : ""}`);
  const st = await client.call("remote.status", {});
  if (want.access !== was && st.devices.length) console.log("Devices paired before need to pair again (cmd remote pair).");
  if (want.access !== "relay") console.log("\nnext: cmd remote setup");
  return 0;
}

/** The checklist of an access mode: the one in use is retried (remote.setup), another is only checked. */
async function setup(client: Client, mode: string | undefined, json: boolean): Promise<number> {
  if (mode !== undefined && !ACCESS_MODES.includes(mode)) return fail("usage: cmd remote setup [tailscale|url] [--json]");
  const st = await client.call("remote.status", {});
  const current = mode === undefined || mode === st.access;
  const which = mode ?? st.access;
  const checks = current ? await client.call("remote.setup", {}) : await client.call("remote.checks", { access: which });
  const ready = checks.every((c) => c.state === "ok");
  if (json) {
    console.log(JSON.stringify(checks, null, 2));
    return ready ? 0 : 1;
  }
  if (!checks.length) return out(`${accessLabel(which)}: nothing to set up`);
  for (const c of checks) for (const l of checkLines(c)) console.log(l);
  if (ready && !current) console.log(`\nnext: cmd remote access ${which}`);
  else if (ready && !st.enabled) console.log("\nnext: cmd remote on");
  return ready ? 0 : 1;
}

/** Show a one-time link as a QR code, then approve the device here (works with the app closed, or over SSH). */
async function remotePair(client: Client, scope: RemoteScope, json: boolean): Promise<number> {
  const requests: RemotePairRequest[] = [];
  let wake = () => {};
  client.onEvent((e) => {
    if (e.type === "remote.pairRequest") requests.push(e.request), wake();
  });
  await client.call("events.subscribe", { types: ["remote.pairRequest"] });
  const { url, expiresAt } = await client.call("remote.pair", { scope });
  if (json) console.log(JSON.stringify({ url, expiresAt }));
  else {
    if (process.stdout.isTTY) console.log(renderUnicodeCompact(url, { ecc: "L", border: 2 }));
    console.log(`Scan with your phone's camera, or open:\n${url}\n\nWorks once, for 5 minutes. Waiting for a device… (Ctrl-C to cancel)`);
  }
  while (Date.now() < expiresAt) {
    const req = requests.shift();
    if (!req) {
      await new Promise<void>((r) => ((wake = r), setTimeout(r, 1000)));
      continue;
    }
    console.log(`\n“${req.name}” wants to use cmd on this Mac.\nCheck that its screen shows:  ${req.words.join(" ")}\n`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Allow? [v]iew only, [c]ontrol (a shell on this Mac), [n]o: ")).trim().toLowerCase();
    rl.close();
    const chosen: RemoteScope | null = answer.startsWith("c") ? "control" : answer.startsWith("v") ? "view" : null;
    await client.call("remote.approve", { requestId: req.requestId, allow: !!chosen, scope: chosen ?? undefined });
    return out(chosen ? `paired ${req.name} (${chosen === "view" ? "view only" : "control"})` : "not allowed");
  }
  return fail("the pairing link expired (cmd remote pair for a new one)");
}

function printRemote(st: RemoteStatus, windows: AppWindow[]): void {
  const title = (id: string) => windows.find((w) => w.id === id)?.title ?? short(id);
  console.log(statusLine(st));
  if (st.sessions.length) {
    console.log("\nConnected now");
    for (const s of st.sessions) console.log(`  ${sessionLine(s, title)}`);
  }
  console.log(st.devices.length ? "\nPaired devices" : "\nNo paired devices (cmd remote pair)");
  for (const d of st.devices) console.log(`  ${remoteDevice(d)}`);
}

function remoteDevice(d: RemoteDevice): string {
  const seen = d.connected ? "connected" : `last seen ${ago(d.lastSeenAt)}`;
  return `${short(d.id)}  ${d.name.padEnd(24)} ${(d.scope === "view" ? "view only" : "control").padEnd(10)} ${seen}`;
}

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

const short = (id: string) => id.slice(0, 8);

function out(v: unknown): number {
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
  return 0;
}

function fail(msg: string): number {
  console.error(`cmd: ${msg}`);
  return 1;
}
