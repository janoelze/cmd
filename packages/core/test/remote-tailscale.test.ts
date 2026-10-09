// The Tailscale access adapter against `tailscale status --json` and `serve
// status --json` as the CLI prints them (trimmed to the fields it reads),
// through a fake exec: which checks it reports, what it runs to publish, and
// that it never touches what isn't its own.
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@cmd/protocol";
import type { ExecResult } from "../src/loginpath.ts";
import type { AdapterContext } from "../src/remote/access/adapter.ts";
import { createTailscaleAdapter, DOWNLOAD_URL } from "../src/remote/access/tailscale.ts";

const APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const HOST = "mac.tail1234.ts.net";

const status = (o: Record<string, unknown> = {}) => ({
  Version: "1.90.1",
  BackendState: "Running",
  AuthURL: "",
  TailscaleIPs: ["100.101.102.103"],
  Self: { DNSName: `${HOST}.`, HostName: "mac", Online: true },
  MagicDNSSuffix: "tail1234.ts.net",
  CurrentTailnet: { Name: "lukas@github", MagicDNSSuffix: "tail1234.ts.net", MagicDNSEnabled: true },
  CertDomains: [HOST],
  ...o,
});

const ours = (port = 8443, local = 47391) => ({
  TCP: { [port]: { HTTPS: true } },
  Web: { [`${HOST}:${port}`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${local}` } } } },
});

const ok = (stdout: unknown): ExecResult => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "", error: null });

/** A fake CLI: answers by subcommand, records every call. */
function fake(o: { status?: ExecResult; serve?: ExecResult; publish?: ExecResult; installed?: boolean; settings?: Partial<Settings> } = {}) {
  const calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const ctx: AdapterContext = {
    settings: { ...DEFAULT_SETTINGS, "remote.enabled": true, "remote.access": "tailscale", ...o.settings } as Settings,
    port: 47391,
    route: "r".repeat(22),
    log: { info: () => {}, warn: () => {} },
    exec: async (cmd, args, e) => {
      calls.push({ cmd, args, env: e?.env });
      if (cmd === "tailscale") return { code: null, stdout: "", stderr: "", error: "ENOENT" };
      const a = args.join(" ");
      if (a === "status --json") return o.status ?? ok(status());
      if (a === "serve status --json") return o.serve ?? ok({});
      if (a.startsWith("serve --bg")) return o.publish ?? ok("");
      return ok("");
    },
  };
  const probed: string[] = [];
  const adapter = createTailscaleAdapter({
    exists: (p) => (o.installed ?? true) && p === APP,
    probe: async (url) => (probed.push(url), null),
  });
  return { adapter, ctx, calls, probed };
}

const states = (cs: { id: string; state: string }[]) => cs.map((c) => `${c.id}:${c.state}`);

describe("tailscale adapter", () => {
  it("asks to install Tailscale when there's no CLI anywhere", async () => {
    const { adapter, ctx } = fake({ installed: false });
    const checks = await adapter.detect(ctx);
    expect(states(checks)).toEqual(["installed:todo", "running:todo", "magicdns:todo", "https:todo", "published:todo", "reachable:todo"]);
    expect(checks[0]).toMatchObject({ link: DOWNLOAD_URL });
    await expect(adapter.enable(ctx)).rejects.toThrow(/Install Tailscale/);
  });

  it("runs the app's binary as a CLI", async () => {
    const { adapter, ctx, calls } = fake();
    await adapter.detect(ctx);
    expect(calls[0]).toMatchObject({ cmd: APP, env: { TAILSCALE_BE_CLI: "1" } });
  });

  it("says to open Tailscale when it isn't running, and to log in with its link", async () => {
    const down = fake({ status: { code: 1, stdout: "", stderr: "failed to connect to local Tailscale service; is Tailscale running?\n", error: null } });
    expect((await down.adapter.detect(down.ctx))[1]).toMatchObject({ id: "running", state: "todo", detail: "Tailscale isn't running. Open it and connect." });
    const login = fake({ status: ok(status({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc" })) });
    expect((await login.adapter.detect(login.ctx))[1]).toMatchObject({ detail: "Log in to Tailscale.", link: "https://login.tailscale.com/a/abc" });
    await expect(login.adapter.enable(login.ctx)).rejects.toThrow(/Log in/);
    const app = fake({ status: ok(status({ BackendState: "NeedsLogin" })) });
    expect((await app.adapter.detect(app.ctx))[1]).toMatchObject({ detail: "Open Tailscale and log in." });
  });

  it("tells a CLI-only install (Homebrew) to run tailscale up", async () => {
    // Recorded from Homebrew's tailscale 1.104.1, logged out.
    const { ctx } = fake({ status: ok(status({ BackendState: "NeedsLogin", Self: { DNSName: "", Online: false }, CurrentTailnet: null, CertDomains: null, Health: ["Tailscale is stopped."] })) });
    const cli = createTailscaleAdapter({ exists: (p) => p === "/opt/homebrew/bin/tailscale", probe: async () => null });
    expect((await cli.detect(ctx))[1]).toMatchObject({ id: "running", state: "todo", detail: "Run “tailscale up” in a terminal to connect." });
  });

  it("asks for MagicDNS, then HTTPS certificates, in the admin console", async () => {
    const dns = fake({ status: ok(status({ CurrentTailnet: { Name: "t", MagicDNSEnabled: false } })) });
    expect(states(await dns.adapter.detect(dns.ctx)).slice(0, 3)).toEqual(["installed:ok", "running:ok", "magicdns:todo"]);
    const certs = fake({ status: ok(status({ CertDomains: null })) });
    const checks = await certs.adapter.detect(certs.ctx);
    expect(states(checks).slice(0, 4)).toEqual(["installed:ok", "running:ok", "magicdns:ok", "https:todo"]);
    expect(checks[3]!.link).toMatch(/admin\/dns/);
    await expect(certs.adapter.enable(certs.ctx)).rejects.toThrow(/Turn on HTTPS/);
  });

  it("publishes with serve --bg on its port, proxying to the listener", async () => {
    const { adapter, ctx, calls } = fake();
    expect(await adapter.enable(ctx)).toEqual({ url: `https://${HOST}:8443` });
    expect(calls.at(-1)!.args).toEqual(["serve", "--bg", "--yes", "--https=8443", "http://127.0.0.1:47391"]);
  });

  it("leaves an existing publish of its own alone, and drops the port for 443", async () => {
    const { adapter, ctx, calls } = fake({ serve: ok(ours(443)), settings: { "remote.tailscale.port": 443 } });
    expect(await adapter.enable(ctx)).toEqual({ url: `https://${HOST}` });
    expect(calls.some((c) => c.args[0] === "serve" && c.args[1] !== "status")).toBe(false);
  });

  it("never takes a port that serves something else", async () => {
    const theirs = { TCP: { 8443: { HTTPS: true } }, Web: { [`${HOST}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } };
    const { adapter, ctx, calls } = fake({ serve: ok(theirs) });
    await expect(adapter.enable(ctx)).rejects.toThrow(/already serves something else/);
    expect(states(await adapter.detect(ctx)).at(-2)).toBe("published:error");
    await adapter.disable(ctx);
    expect(calls.some((c) => c.args.includes("off") || c.args.includes("reset"))).toBe(false);
  });

  it("turns Serve being off for the tailnet into what to do, with its link", async () => {
    const out = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc\n";
    const { adapter, ctx } = fake({ publish: { code: null, stdout: out, stderr: "", error: "timeout" } });
    await expect(adapter.enable(ctx)).rejects.toThrow("Turn on Serve for your tailnet: https://login.tailscale.com/f/serve?node=abc");
  });

  it("reports published and reachable once it's up", async () => {
    const { adapter, ctx, probed } = fake({ serve: ok(ours()) });
    const checks = await adapter.detect(ctx);
    expect(states(checks)).toEqual(["installed:ok", "running:ok", "magicdns:ok", "https:ok", "published:ok", "reachable:ok"]);
    expect(probed).toEqual([`https://${HOST}:8443`]);
  });

  it("says to turn remote access on when nothing is published yet", async () => {
    const { adapter, ctx } = fake({ settings: { "remote.enabled": false } });
    expect((await adapter.detect(ctx)).at(-2)).toMatchObject({ id: "published", state: "todo", detail: "Turn on remote access through Tailscale to publish it." });
  });

  it("unpublishes only its own entry, with off, never reset", async () => {
    const mine = fake({ serve: ok(ours()) });
    await mine.adapter.disable(mine.ctx);
    expect(mine.calls.at(-1)!.args).toEqual(["serve", "--yes", "--https=8443", "off"]);
    const moved = fake({ serve: ok(ours(8443, 9999)) });
    await moved.adapter.disable(moved.ctx);
    expect(moved.calls.some((c) => c.args.includes("off"))).toBe(false);
    expect([...mine.calls, ...moved.calls].some((c) => c.args.includes("reset"))).toBe(false);
  });
});
