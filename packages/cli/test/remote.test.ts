// `cmd remote`: the status line per access mode, setup checks, and `remote access`
// switching modes against a real core (in memory, remote access left off).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemoteStatus } from "@cmd/protocol";
import { connect, type Connection } from "@cmd/protocol/node";
import { Core } from "../../core/src/core.ts";
import { fakeFactory } from "../../core/test/fake-pty.ts";
import { checkLines, parseAccess, remoteCommand, sessionLine, statusLine } from "../src/remote.ts";

const base: RemoteStatus = { enabled: true, state: "online", error: null, relay: "wss://relay.example", access: "relay", address: null, devices: [], sessions: [], requests: [] };

describe("cmd remote status line", () => {
  it("names the relay only in relay mode", () => {
    expect(statusLine(base)).toBe("Remote access: ready  ·  Hosted relay wss://relay.example");
    expect(statusLine({ ...base, access: "tailscale", address: "https://mac.tailnet.ts.net:8443" })).toBe("Remote access: ready  ·  Tailscale  ·  https://mac.tailnet.ts.net:8443");
    expect(statusLine({ ...base, access: "url", state: "error", error: "Add your HTTPS address (remote.url).", address: null })).toBe("Remote access: can't connect (Add your HTTPS address (remote.url).)  ·  Your own URL");
  });

  it("shows Tailscale's user login when a session has one", () => {
    const s = { id: "s", deviceId: "d", name: "Safari on iPhone", scope: "control" as const, since: 0, ip: "100.64.0.2", user: "lukas@github", watching: [] };
    expect(sessionLine(s, (id) => id)).toMatch(/on its home screen {2}\(lukas@github, 100\.64\.0\.2\)$/);
    expect(sessionLine({ ...s, user: null }, (id) => id)).toMatch(/\(100\.64\.0\.2\)$/);
  });

  it("prints a check with what to do and where, indented", () => {
    expect(checkLines({ id: "https", title: "Turn on HTTPS for your tailnet", state: "todo", detail: "Certificates need it.", link: "https://login.tailscale.com/admin/dns" })).toEqual([
      "• Turn on HTTPS for your tailnet",
      "  Certificates need it.",
      "  https://login.tailscale.com/admin/dns",
    ]);
    expect(checkLines({ id: "a", title: "Tailscale is running", state: "ok" })).toEqual(["✓ Tailscale is running"]);
    expect(checkLines({ id: "b", title: "The page loads", state: "error" })[0]).toBe("✗ The page loads");
  });
});

describe("cmd remote access arguments", () => {
  it("takes a mode, and a URL only for url", () => {
    expect(parseAccess(["tailscale"], "")).toEqual({ access: "tailscale" });
    expect(parseAccess(["url", "https://mac.example.com"], "")).toEqual({ access: "url", url: "https://mac.example.com" });
    expect(parseAccess(["url"], "https://saved.example")).toEqual({ access: "url" });
    expect(parseAccess(["url"], "")).toHaveProperty("error", expect.stringMatching(/needs an address/));
    expect(parseAccess(["url", "not a url"], "")).toHaveProperty("error", expect.stringMatching(/isn't a URL/));
    expect(parseAccess(["relay", "https://x.example"], "")).toHaveProperty("error");
    expect(parseAccess(["ngrok"], "")).toHaveProperty("error", expect.stringMatching(/^usage/));
  });
});

describe("cmd remote against a core", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-cli-remote-"));
  let core: Core;
  let conn: Connection;

  /** What `cmd remote …` prints (stdout and stderr) and its exit code. */
  async function run(pos: string[], opt: Record<string, unknown> = {}): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(s));
    const error = vi.spyOn(console, "error").mockImplementation((s: string) => void err.push(s));
    try {
      return { code: await remoteCommand(conn.client, pos, opt), out, err };
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  }

  beforeAll(async () => {
    core = new Core({ socketPath: path.join(dir, "core.sock"), dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0 });
    await core.listen();
    conn = await connect(path.join(dir, "core.sock"));
  });
  afterAll(async () => {
    conn.close();
    await core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("says what Your own URL needs before switching to it", async () => {
    const r = await run(["access", "url"]);
    expect(r.code).toBe(1);
    expect(r.err[0]).toMatch(/needs an address/);
    expect(core.settings.settings["remote.access"]).toBe("relay");
  });

  it("checks a mode that isn't in use without switching to it", async () => {
    const r = await run(["setup", "url"], { json: true });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out.join("\n"))[0]).toMatchObject({ id: "url", state: "todo" });
    expect(core.settings.settings["remote.access"]).toBe("relay");
  });

  it("has nothing to set up for the relay", async () => {
    expect(await run(["setup"])).toMatchObject({ code: 0, out: ["Hosted relay: nothing to set up"] });
  });

  it("switches to Your own URL and saves the address", async () => {
    const r = await run(["access", "url", "https://mac.example.invalid"]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe("Your own URL  ·  https://mac.example.invalid (was Hosted relay)");
    expect(r.out).toContain("\nnext: cmd remote setup");
    expect(core.settings.settings["remote.access"]).toBe("url");
    expect(core.settings.settings["remote.url"]).toBe("https://mac.example.invalid");
    expect((await run(["access", "url"])).out).toEqual(["already using Your own URL"]);
    expect((await run(["access"])).out).toEqual(["Your own URL  ·  https://mac.example.invalid"]);
  });

  it("shows the access mode, not the relay, in a direct mode", async () => {
    expect((await run([])).out[0]).toMatch(/^Remote access: off {2}· {2}Your own URL/);
  });

  it("rejects a mode it doesn't know", async () => {
    expect((await run(["setup", "ngrok"])).code).toBe(1);
  });
});
