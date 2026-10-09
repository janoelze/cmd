// The Tailscale access adapter (docs/38, "tailscale"): publishes the loopback
// listener on the tailnet with `tailscale serve --bg`, which terminates HTTPS
// with the tailnet's certificate (renewed by Tailscale) and survives restarts.
// Everything goes through the CLI (the App Store app's LocalAPI isn't reachable
// from outside its sandbox). It only ever adds or removes its own HTTPS port's
// entry, and only when that entry proxies to our port: never `serve reset`,
// never someone else's handler.

import fs from "node:fs";
import type { AccessAdapter, AdapterContext, Check } from "./adapter.ts";
import { probePage } from "./url.ts";

interface Cli {
  cmd: string;
  env?: NodeJS.ProcessEnv;
}

/** Where the CLI lives: the app (App Store and Standalone, as a CLI with TAILSCALE_BE_CLI), Homebrew and the like, then PATH. */
const CANDIDATES: Cli[] = [
  { cmd: "/Applications/Tailscale.app/Contents/MacOS/Tailscale", env: { TAILSCALE_BE_CLI: "1" } },
  { cmd: "/usr/local/bin/tailscale" },
  { cmd: "/opt/homebrew/bin/tailscale" },
  { cmd: "tailscale" },
];

export const DOWNLOAD_URL = "https://tailscale.com/download/mac";
export const DNS_ADMIN_URL = "https://login.tailscale.com/admin/dns";

/** The parts of `tailscale status --json` (ipnstate.Status) this reads. */
interface Status {
  BackendState?: string;
  AuthURL?: string;
  Self?: { DNSName?: string };
  CurrentTailnet?: { Name?: string; MagicDNSEnabled?: boolean } | null;
  CertDomains?: string[] | null;
}

/** The parts of `tailscale serve status --json` (ipn.ServeConfig) this reads. */
interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

export interface TailscaleOptions {
  /** Whether a path exists (tests). */
  exists?: (p: string) => boolean;
  /** null when cmd's page loads at the URL; else why not (tests). */
  probe?: (url: string) => Promise<string | null>;
}

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

export function createTailscaleAdapter(o: TailscaleOptions = {}): AccessAdapter {
  const exists = o.exists ?? fs.existsSync;
  const probe = o.probe ?? probePage;

  async function findCli(ctx: AdapterContext): Promise<Cli | null> {
    for (const c of CANDIDATES) {
      if (c.cmd.startsWith("/")) {
        if (exists(c.cmd)) return c;
      } else if ((await ctx.exec(c.cmd, ["version"], { timeout: 5000 })).error === null) return c;
    }
    return null;
  }

  const run = (ctx: AdapterContext, cli: Cli, args: string[], timeout = 10_000) => ctx.exec(cli.cmd, args, { timeout, env: cli.env });

  async function json<T>(ctx: AdapterContext, cli: Cli, args: string[]): Promise<Read<T>> {
    const r = await run(ctx, cli, args);
    if (r.code === 0) {
      try {
        return { ok: true, value: JSON.parse(r.stdout || "{}") as T };
      } catch {}
    }
    return { ok: false, error: firstLine(r.stderr || r.stdout) || r.error || `exit ${r.code}` };
  }

  /** Why Tailscale can't publish yet, as a check that isn't ok; null when it's connected with MagicDNS and certificates. */
  function blocker(st: Read<Status>, cli: Cli): Check | null {
    // The app is opened; a CLI-only install (Homebrew's tailscaled) is brought up from a terminal.
    const app = cli.cmd === CANDIDATES[0]!.cmd;
    if (!st.ok) return { id: "running", title: "Connected to your tailnet", state: "todo", detail: app ? "Tailscale isn't running. Open it and connect." : "Tailscale isn't running. Start tailscaled, then run “tailscale up”." };
    const s = st.value;
    if (s.BackendState !== "Running") {
      const login = s.BackendState === "NeedsLogin" || s.BackendState === "NeedsMachineAuth";
      const detail = s.AuthURL ? "Log in to Tailscale." : app ? (login ? "Open Tailscale and log in." : "Open Tailscale and connect.") : "Run “tailscale up” in a terminal to connect.";
      return { id: "running", title: "Connected to your tailnet", state: "todo", detail, link: s.AuthURL || undefined };
    }
    if (!s.CurrentTailnet?.MagicDNSEnabled) return { id: "magicdns", title: "MagicDNS is on", state: "todo", detail: "Turn on MagicDNS in Tailscale's admin console.", link: DNS_ADMIN_URL };
    if (!s.CertDomains?.length || !host(s))
      return {
        id: "https",
        title: "HTTPS certificates are on",
        state: "todo",
        detail: "Turn on HTTPS in Tailscale's admin console. Your Mac's and tailnet's names then appear in public certificate logs.",
        link: DNS_ADMIN_URL,
      };
    return null;
  }

  const tsPort = (ctx: AdapterContext) => ctx.settings["remote.tailscale.port"];
  const target = (ctx: AdapterContext) => `http://127.0.0.1:${ctx.port}`;

  /** Whose the port's entry is: ours (proxies to our listener), someone else's, or nobody's. */
  function owner(cfg: ServeConfig, h: string, ctx: AdapterContext): "ours" | "taken" | "free" {
    const port = String(tsPort(ctx));
    const proxy = cfg.Web?.[`${h}:${port}`]?.Handlers?.["/"]?.Proxy;
    if (proxy && normalizeProxy(proxy) === target(ctx)) return "ours";
    return cfg.TCP?.[port] || cfg.Web?.[`${h}:${port}`] ? "taken" : "free";
  }

  const url = (h: string, port: number) => (port === 443 ? `https://${h}` : `https://${h}:${port}`);

  return {
    id: "tailscale",
    title: "Tailscale",
    icon: "network",
    description: "Your tailnet, with HTTPS from Tailscale.",

    async detect(ctx) {
      const titles: [string, string][] = [
        ["installed", "Tailscale is installed"],
        ["running", "Connected to your tailnet"],
        ["magicdns", "MagicDNS is on"],
        ["https", "HTTPS certificates are on"],
        ["published", "Published on your tailnet"],
        ["reachable", "Phones can reach it"],
      ];
      const checks: Check[] = [];
      /** The rest of the list, still to do, after the step that stopped it. */
      const rest = (stopped: Check) => {
        const at = titles.findIndex(([id]) => id === stopped.id);
        for (const [id, title] of titles.slice(checks.length, at)) checks.push({ id, title, state: "ok" });
        checks.push(stopped);
        for (const [id, title] of titles.slice(at + 1)) checks.push({ id, title, state: "todo" });
        return checks;
      };

      const cli = await findCli(ctx);
      if (!cli) return rest({ id: "installed", title: "Tailscale is installed", state: "todo", detail: "Install Tailscale on this Mac.", link: DOWNLOAD_URL });
      checks.push({ id: "installed", title: "Tailscale is installed", state: "ok" });
      const st = await json<Status>(ctx, cli, ["status", "--json"]);
      const b = blocker(st, cli);
      if (b) return rest(b);
      const s = (st as { value: Status }).value;
      const h = host(s)!;
      checks.push({ id: "running", title: "Connected to your tailnet", state: "ok", detail: s.CurrentTailnet?.Name || undefined });
      checks.push({ id: "magicdns", title: "MagicDNS is on", state: "ok", detail: h });
      checks.push({ id: "https", title: "HTTPS certificates are on", state: "ok" });

      const serve = await json<ServeConfig>(ctx, cli, ["serve", "status", "--json"]);
      const port = tsPort(ctx);
      const who = serve.ok ? owner(serve.value, h, ctx) : "free";
      if (who !== "ours") {
        const detail =
          who === "taken"
            ? `Port ${port} on your tailnet already serves something else. Pick another one (remote.tailscale.port).`
            : !ctx.settings["remote.enabled"] || ctx.settings["remote.access"] !== "tailscale"
              ? "Turn on remote access through Tailscale to publish it."
              : "Not published yet. Check Again to retry.";
        return rest({ id: "published", title: "Published on your tailnet", state: who === "taken" ? "error" : "todo", detail });
      }
      checks.push({ id: "published", title: "Published on your tailnet", state: "ok", detail: `${url(h, port)} → 127.0.0.1:${ctx.port}` });
      const unreachable = await probe(url(h, port));
      checks.push(
        unreachable
          ? { id: "reachable", title: "Phones can reach it", state: "error", detail: `${unreachable} The first certificate can take a minute.` }
          : { id: "reachable", title: "Phones can reach it", state: "ok", detail: url(h, port) },
      );
      return checks;
    },

    async enable(ctx) {
      const cli = await findCli(ctx);
      if (!cli) throw new Error("Install Tailscale on this Mac.");
      const st = await json<Status>(ctx, cli, ["status", "--json"]);
      const b = blocker(st, cli);
      if (b) throw new Error(b.detail);
      const h = host((st as { value: Status }).value)!;
      const port = tsPort(ctx);
      const serve = await json<ServeConfig>(ctx, cli, ["serve", "status", "--json"]);
      const who = serve.ok ? owner(serve.value, h, ctx) : "free";
      if (who === "ours") return { url: url(h, port) };
      if (who === "taken") throw new Error(`Port ${port} on your tailnet already serves something else. Pick another one (remote.tailscale.port).`);
      const r = await run(ctx, cli, ["serve", "--bg", "--yes", `--https=${port}`, target(ctx)], 20_000);
      if (r.code !== 0) {
        const out = `${r.stdout}\n${r.stderr}`;
        const link = out.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
        if (/serve is not enabled/i.test(out)) throw new Error(`Turn on Serve for your tailnet${link ? `: ${link}` : " in Tailscale's admin console."}`);
        if (/https.*not enabled|enable https/i.test(out)) throw new Error(`Turn on HTTPS for your tailnet${link ? `: ${link}` : " in Tailscale's admin console."}`);
        // tailscaled running as root (Homebrew) refuses other users unless they're its operator.
        if (/access denied|permission denied|operator/i.test(out)) throw new Error("Tailscale won't let cmd publish. Run “sudo tailscale set --operator=$USER” in a terminal, then Check Again.");
        throw new Error(`Couldn't publish on your tailnet: ${firstLine(r.stderr || r.stdout) || r.error || `exit ${r.code}`}`);
      }
      ctx.log.info(`tailscale: published ${url(h, port)} → ${target(ctx)}`);
      return { url: url(h, port) };
    },

    async disable(ctx) {
      const cli = await findCli(ctx);
      if (!cli) return;
      const st = await json<Status>(ctx, cli, ["status", "--json"]);
      const h = st.ok ? host(st.value) : null;
      const serve = await json<ServeConfig>(ctx, cli, ["serve", "status", "--json"]);
      // Only our own entry: anything else on the tailnet stays as it is.
      if (!h || !serve.ok || owner(serve.value, h, ctx) !== "ours") return;
      const r = await run(ctx, cli, ["serve", "--yes", `--https=${tsPort(ctx)}`, "off"]);
      if (r.code !== 0) throw new Error(firstLine(r.stderr || r.stdout) || r.error || `exit ${r.code}`);
      ctx.log.info(`tailscale: unpublished port ${tsPort(ctx)}`);
    },
  };
}

export const tailscaleAdapter = createTailscaleAdapter();

/** This Mac's MagicDNS name, without the trailing dot. */
function host(s: Status): string | null {
  return s.Self?.DNSName?.replace(/\.$/, "") || null;
}

/** "http://127.0.0.1:47391/" and "127.0.0.1:47391" alike. */
function normalizeProxy(p: string): string {
  return (p.includes("://") ? p : `http://${p}`).replace(/\/+$/, "").replace("://localhost:", "://127.0.0.1:");
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0]?.trim() ?? "";
}
