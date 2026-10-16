// `pnpm phone:serve [--port N] [--https-port N] [--no-tailscale]`: the web
// client (apps/web) from Vite with hot reload, on one fixed origin a real phone
// opens (docs/56-phone-development.md): Vite on 127.0.0.1, Tailscale Serve in
// front for HTTPS on https://<mac>.<tailnet>.ts.net:5443, and /c/release and
// /c/dev forwarded to those cores (proxy.ts). Ctrl-C takes the Serve entry off
// again when this run added it. Without Tailscale it says what to run and still
// serves on localhost (a secure context, for this Mac's browsers).

import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { phoneHosts, phoneProxy } from "./proxy.ts";
import { findCli, magicName, publish, shown, unpublish } from "./tailscale.ts";
import { devLine, phoneHome, resolveTarget, stateDir, TARGETS } from "./targets.ts";

const root = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const port = flag("--port", 5190);
const httpsPort = flag("--https-port", 5443);
const local = `http://127.0.0.1:${port}`;
const time = () => new Date().toLocaleTimeString();

// Tailscale first: its name goes into Vite's allowed hosts and HMR settings.
let ts: { cli: NonNullable<Awaited<ReturnType<typeof findCli>>>; host: string } | null = null;
const publishArgs = ["serve", "--bg", `--https=${httpsPort}`, local];
if (!args.includes("--no-tailscale")) {
  const cli = await findCli();
  if (!cli) console.log(`Tailscale isn't installed (or this shell can't run it). Serving on this Mac only.\nTo reach it from your phone, install Tailscale (https://tailscale.com/download/mac), then run:\n  ${shown(null, publishArgs)}\n`);
  else {
    const name = await magicName(cli);
    if ("error" in name) console.log(`Couldn't use Tailscale: ${name.error}. Serving on this Mac only.\nOnce that's fixed, run pnpm phone:serve again, or publish it yourself:\n  ${shown(cli, publishArgs)}\n`);
    else ts = { cli, host: name.host };
  }
}

// vite is apps/web's dependency, not the root's.
/** The part of Vite's API this uses. */
interface Vite {
  createServer(config: object): Promise<{ listen(): Promise<unknown>; close(): Promise<void> }>;
}
const vite = (await import(pathToFileURL(path.join(root, "apps/web/node_modules/vite/dist/node/index.js")).href)) as Vite;
const proxy = phoneProxy({ hosts: phoneHosts(port, ts && { host: ts.host, port: httpsPort }), log: (m) => console.log(`${time()}  ${m}`) });
const server = await vite.createServer({
  root: path.join(root, "apps/web"),
  configFile: path.join(root, "apps/web/vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    ...(ts ? { allowedHosts: [ts.host], hmr: { protocol: "wss", clientPort: httpsPort } } : {}),
  },
  plugins: [
    {
      name: "cmd-phone-proxy",
      configureServer(s: { httpServer: http.Server | null }) {
        s.httpServer?.on("upgrade", (req, socket, head) => void proxy(req, socket, head));
      },
    },
  ],
});
await server.listen();

let origin = local;
let added = false;
if (ts) {
  const r = await publish(ts.cli, ts.host, httpsPort, local);
  if ("error" in r) console.log(`Couldn't publish on your tailnet: ${r.error}.\nServing on this Mac only. To publish it yourself:\n  ${shown(ts.cli, publishArgs)}\n`);
  else {
    added = r.added;
    origin = httpsPort === 443 ? `https://${ts.host}` : `https://${ts.host}:${httpsPort}`;
  }
}

// What phone:pair puts in links.
fs.mkdirSync(stateDir(), { recursive: true });
const serveFile = path.join(stateDir(), "serve.json");
fs.writeFileSync(serveFile, JSON.stringify({ origin, local, pid: process.pid }, null, 2) + "\n");

const dev = resolveTarget("dev");
console.log(`${origin !== local ? `cmd for your phone: ${origin}\nOn this Mac:        ${local}` : `cmd on this Mac only: ${local}`}

  /c/release → the installed cmd (127.0.0.1:${resolveTarget("release").port})
  /c/dev     → ${dev.home === phoneHome() ? "the phone's dev core" : dev.home} (127.0.0.1:${dev.port}): ${await devLine(dev)}
               pnpm phone:core <checkout> runs it from another worktree

Pair:  pnpm phone:pair ${TARGETS.join("|")}
Stop:  Ctrl-C${added ? " (takes it off your tailnet again)" : ts && origin !== local ? " (it was on your tailnet before, so it stays)" : ""}
`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (added && ts) await unpublish(ts.cli, ts.host, httpsPort, local).catch(() => {});
  try {
    if (JSON.parse(fs.readFileSync(serveFile, "utf8")).pid === process.pid) fs.rmSync(serveFile);
  } catch {}
  await server.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
