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
import { AccessModes } from "../../core/src/remote/access/mode.ts";
import { registerBuiltinModes } from "../../core/src/remote/access/builtin.ts";
import { checkLines, parseAccess, remoteCommand, sessionLine, statusLine } from "../src/remote.ts";

const registry = new AccessModes();
registerBuiltinModes(registry);
/** What remote.modes answers. */
const modes = registry.info();

const base: RemoteStatus = { enabled: true, state: "online", error: null, access: "relay", address: "https://cmd.example", devices: [], sessions: [], requests: [] };

describe("cmd remote status line", () => {
  it("names the mode, then where phones open cmd, the same in every mode", () => {
    expect(statusLine(base, modes)).toBe("Remote access: ready  ·  Hosted relay  ·  https://cmd.example");
    expect(statusLine({ ...base, state: "off", enabled: false, address: null }, modes)).toBe("Remote access: off  ·  Hosted relay");
    expect(statusLine({ ...base, access: "plugin", address: "https://x.example" }, modes)).toBe("Remote access: ready  ·  plugin  ·  https://x.example");
    expect(statusLine({ ...base, access: "tailscale", address: "https://mac.tailnet.ts.net:8443" }, modes)).toBe("Remote access: ready  ·  Tailscale  ·  https://mac.tailnet.ts.net:8443");
    expect(statusLine({ ...base, access: "url", state: "error", error: "Add your HTTPS address (remote.url).", address: null }, modes)).toBe("Remote access: can't connect (Add your HTTPS address (remote.url).)  ·  Your own URL");
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
    expect(checkLines({ id: "b", title: "Forward the page", state: "error" })[0]).toBe("✗ Forward the page");
  });
});

describe("cmd remote access arguments", () => {
  const none = () => "";
  it("takes a mode, and a value only for a mode with an argument", () => {
    expect(parseAccess(["tailscale"], modes, none)).toEqual({ access: "tailscale" });
    expect(parseAccess(["url", "https://mac.example.com"], modes, none)).toEqual({ access: "url", set: { key: "remote.url", value: "https://mac.example.com" } });
    expect(parseAccess(["url"], modes, (k) => (k === "remote.url" ? "https://saved.example" : ""))).toEqual({ access: "url" });
    expect(parseAccess(["url"], modes, none)).toHaveProperty("error", "Your own URL needs an address: cmd remote access url https://mac.example.com");
    expect(parseAccess(["relay", "https://x.example"], modes, none)).toHaveProperty("error", "Hosted relay takes nothing more (cmd remote access url https://x.example)");
  });

  it("names the modes the core has when it doesn't know one", () => {
    expect(parseAccess(["ngrok"], modes, none)).toHaveProperty("error", 'no access mode "ngrok" (usage: cmd remote access relay|tailscale|url [VALUE])');
    expect(parseAccess([], modes, none)).toHaveProperty("error", "usage: cmd remote access relay|tailscale|url [VALUE]");
    // A mode the core registers later is a choice too: nothing here lists them.
    expect(parseAccess(["ngrok"], [...modes, { ...modes[0]!, id: "ngrok", title: "ngrok" }], none)).toEqual({ access: "ngrok" });
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

  it("lists the core's modes, marking the one in use", async () => {
    const { out } = await run(["modes"]);
    expect(out.map((l) => l.split(":")[0])).toEqual(["  relay      Hosted relay", "  tailscale  Tailscale", "* url        Your own URL"]);
  });

  it("rejects a mode it doesn't know", async () => {
    const r = await run(["setup", "ngrok"]);
    expect(r.code).toBe(1);
    expect(r.err[0]).toMatch(/no access mode "ngrok".*relay\|tailscale\|url/);
  });

  it("says which modes there are when remote.access names none of them", async () => {
    core.settings.set("remote.access", "ngrok");
    core.settings.set("remote.enabled", true);
    await core.remote.ready();
    expect(core.remote.status()).toMatchObject({ state: "error", error: "No access mode “ngrok”. Pick one of relay, tailscale, url." });
    expect((await run([])).out[0]).toBe("Remote access: can't connect (No access mode “ngrok”. Pick one of relay, tailscale, url.)  ·  ngrok");
    await expect(core.call("remote.pair", {})).rejects.toThrow("Remote access isn't ready: No access mode “ngrok”.");
    core.settings.set("remote.enabled", false);
  });
});
