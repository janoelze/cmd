// Publishing the phone origin on the tailnet: `tailscale serve --bg --https=5443`
// in front of Vite, with what the core's Tailscale adapter knows (where the CLI
// lives, how to read the Mac's MagicDNS name, whose a Serve entry is). Like the
// adapter it only adds or removes its own port's entry, and only when that entry
// proxies to Vite.

import { execFile } from "node:child_process";
import fs from "node:fs";
import { CANDIDATES, host, normalizeProxy, type Cli, type ServeConfig, type Status } from "../../packages/core/src/remote/access/tailscale.ts";

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

function run(cli: Cli, args: string[], timeout = 15_000): Promise<Run> {
  return new Promise((resolve) => {
    execFile(cli.cmd, args, { timeout, env: { ...process.env, ...cli.env } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr), error: err && code === null ? err.message : null });
    });
  });
}

/** The Tailscale CLI, or null: the app's binary, Homebrew's, then PATH. */
export async function findCli(): Promise<Cli | null> {
  for (const c of CANDIDATES) {
    if (c.cmd.startsWith("/")) {
      if (fs.existsSync(c.cmd)) return c;
    } else if ((await run(c, ["version"], 5000)).code === 0) return c;
  }
  return null;
}

/** The shell command that runs `args` with this CLI, for people to copy. */
export const shown = (cli: Cli | null, args: string[]): string => `${cli?.env?.TAILSCALE_BE_CLI ? "TAILSCALE_BE_CLI=1 " : ""}${cli?.cmd.includes(" ") ? `"${cli.cmd}"` : (cli?.cmd ?? "tailscale")} ${args.join(" ")}`;

const firstLine = (s: string) => s.trim().split("\n")[0]?.trim() ?? "";

/** This Mac's MagicDNS name, or why there is none. */
export async function magicName(cli: Cli): Promise<{ host: string } | { error: string }> {
  const r = await run(cli, ["status", "--json"]);
  if (r.code !== 0) return { error: firstLine(r.stderr || r.stdout) || r.error || `exit ${r.code}` };
  let s: Status;
  try {
    s = JSON.parse(r.stdout || "{}") as Status;
  } catch {
    return { error: "couldn't read tailscale status" };
  }
  if (s.BackendState !== "Running") return { error: "Tailscale isn't connected" };
  if (!s.CurrentTailnet?.MagicDNSEnabled) return { error: "MagicDNS is off for your tailnet" };
  if (!s.CertDomains?.length) return { error: "HTTPS certificates are off for your tailnet" };
  const h = host(s);
  return h ? { host: h } : { error: "Tailscale doesn't say this Mac's name" };
}

/** Whose `https:<port>` is on this host: proxies to `target` (ours), something else, or nobody's. */
export function owner(cfg: ServeConfig, h: string, port: number, target: string): "ours" | "taken" | "free" {
  const proxy = cfg.Web?.[`${h}:${port}`]?.Handlers?.["/"]?.Proxy;
  if (proxy && normalizeProxy(proxy) === target) return "ours";
  return cfg.TCP?.[String(port)] || cfg.Web?.[`${h}:${port}`] ? "taken" : "free";
}

async function serveStatus(cli: Cli): Promise<ServeConfig> {
  const r = await run(cli, ["serve", "status", "--json"]);
  try {
    return r.code === 0 ? (JSON.parse(r.stdout || "{}") as ServeConfig) : {};
  } catch {
    return {};
  }
}

/** Publishes https://<host>:<port> → target. added: false when it already was (so leave it on). */
export async function publish(cli: Cli, h: string, port: number, target: string): Promise<{ added: boolean } | { error: string }> {
  const who = owner(await serveStatus(cli), h, port, target);
  if (who === "ours") return { added: false };
  if (who === "taken") return { error: `port ${port} on your tailnet already serves something else (pick another with --https-port)` };
  const r = await run(cli, ["serve", "--bg", "--yes", `--https=${port}`, target], 20_000);
  if (r.code !== 0) return { error: firstLine(r.stderr || r.stdout) || r.error || `exit ${r.code}` };
  return { added: true };
}

/** Takes https:<port> off again, if it's still ours. */
export async function unpublish(cli: Cli, h: string, port: number, target: string): Promise<void> {
  if (owner(await serveStatus(cli), h, port, target) !== "ours") return;
  await run(cli, ["serve", "--yes", `--https=${port}`, "off"]);
}
