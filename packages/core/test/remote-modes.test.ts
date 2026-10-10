// Access modes (docs/38): the registry, and RemoteService driving a fake port
// publisher wrapped by publishedMode(): when it publishes, unpublishes when its
// settings change or it's switched off, retries on Check Again, hands a
// publication to the next run, settles enable() racing a stop, and that each
// mode speaks for itself (no relay wording in a direct mode).
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@cmd/protocol";
import { SettingsService } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { AccessAdapter } from "../src/remote/access/adapter.ts";
import { registerBuiltinModes } from "../src/remote/access/builtin.ts";
import { AccessModes, type ModeContext } from "../src/remote/access/mode.ts";
import { publishedMode } from "../src/remote/access/published.ts";
import { relayMode } from "../src/remote/access/relay.ts";
import { HostKeys } from "../src/remote/keys.ts";
import { RelayLink, webClient } from "../src/remote/link.ts";
import { RemoteService } from "../src/remote/service.ts";

/** A publisher that records what it's asked, fails while `fail` says why, and holds enable() while `hold` is set. */
function fakeAdapter() {
  const calls: string[] = [];
  const a: AccessAdapter & { fail: string | null; hold: Promise<void> | null; calls: string[] } = {
    id: "fake",
    title: "Fake",
    icon: "link",
    description: "A pretend proxy.",
    settings: ["remote.tailscale.port"],
    connecting: "Faking it…",
    fail: null,
    hold: null,
    calls,
    detect: async (ctx) => [{ id: "published", title: "Publish", state: a.fail ? "todo" : "ok", detail: String(ctx.port) }],
    enable: async (ctx) => {
      calls.push(`enable ${ctx.port} ${ctx.settings["remote.tailscale.port"]}`);
      await a.hold;
      if (a.fail) throw new Error(a.fail);
      return { url: "https://fake.example" };
    },
    disable: async (ctx) => void calls.push(`disable ${ctx.port} ${ctx.settings["remote.tailscale.port"]}`),
  };
  return a;
}

let svc: RemoteService | null = null;
afterEach(() => {
  svc?.close();
  svc = null;
});

async function service(port = 0) {
  const adapter = fakeAdapter();
  const modes = new AccessModes();
  modes.register(relayMode());
  modes.register(publishedMode(adapter));
  const settings = new SettingsService(null);
  settings.set("remote.port", port);
  svc = new RemoteService({ store: new Store(":memory:"), settings, stateDir: null, serve: () => ({}) as never, broadcast: () => {}, modes, webDir: null });
  const online = async () => {
    await svc!.ready();
    for (let i = 0; i < 100 && svc!.status().state === "connecting"; i++) await new Promise((r) => setTimeout(r, 10));
    return svc!.status();
  };
  return { adapter, settings, svc, online };
}

const freePort = () => 47000 + Math.floor(Math.random() * 2000);

describe("access mode registry", () => {
  it("refuses a second mode with the same id, and lists what the UI needs", () => {
    const modes = new AccessModes();
    registerBuiltinModes(modes);
    expect(() => modes.register(relayMode())).toThrow(/already registered: relay/);
    expect(modes.ids()).toEqual(["relay", "tailscale", "url"]);
    expect(modes.info().find((m) => m.id === "url")).toEqual({
      id: "url",
      title: "Your own URL",
      icon: "link",
      description: expect.any(String),
      settings: ["remote.url", "remote.port"],
      argument: "remote.url",
      setup: true,
      connecting: expect.any(String),
    });
    expect(modes.info().find((m) => m.id === "relay")).toMatchObject({ settings: ["remote.relay", "remote.client"], argument: null, setup: false });
  });

  it("shares its stateless modes between registries", () => {
    const a = new AccessModes();
    const b = new AccessModes();
    registerBuiltinModes(a);
    registerBuiltinModes(b);
    expect(a.get("tailscale")).toBe(b.get("tailscale"));
  });

  it("follows the settings of a mode registered after the service started", async () => {
    const adapter = fakeAdapter();
    const modes = new AccessModes();
    modes.register(relayMode());
    const settings = new SettingsService(null);
    settings.set("remote.port", freePort());
    svc = new RemoteService({ store: new Store(":memory:"), settings, stateDir: null, serve: () => ({}) as never, broadcast: () => {}, modes, webDir: null });
    settings.set("remote.access", "fake");
    settings.set("remote.enabled", true);
    await svc.ready();
    expect(svc.status()).toMatchObject({ state: "error", error: expect.stringMatching(/No access mode “fake”/) });

    modes.register(publishedMode(adapter));
    await svc.ready();
    expect(adapter.calls).toHaveLength(1);
    // remote.tailscale.port is only the new mode's: it restarts it.
    settings.set("remote.tailscale.port", 9443);
    await svc.ready();
    expect(adapter.calls.slice(1)).toEqual([expect.stringMatching(/^disable .* 8443$/), expect.stringMatching(/^enable .* 9443$/)]);
  });
});

describe("a published mode", () => {
  it("publishes when on, unpublishes when one of its settings changes or it's switched away from", async () => {
    const { adapter, settings, online } = await service(freePort());
    const port = settings.settings["remote.port"];
    settings.set("remote.access", "fake");
    settings.set("remote.enabled", true);
    expect(await online()).toMatchObject({ state: "online", address: "https://fake.example", access: "fake" });
    expect(adapter.calls).toEqual([`enable ${port} 8443`]);

    // Check Again on a mode that's online changes nothing.
    await svc!.setup();
    expect(adapter.calls).toEqual([`enable ${port} 8443`]);

    // A setting it publishes with: unpublish with the old value first.
    settings.set("remote.tailscale.port", 9443);
    await online();
    expect(adapter.calls.slice(1)).toEqual([`disable ${port} 8443`, `enable ${port} 9443`]);

    settings.set("remote.access", "relay");
    await svc!.ready();
    expect(adapter.calls.at(-1)).toBe(`disable ${port} 9443`);
  });

  it("unpublishes when turned off, and says why it isn't ready in its own words", async () => {
    const { adapter, settings, svc, online } = await service(freePort());
    adapter.fail = "Turn on HTTPS certificates in Tailscale's admin console.";
    settings.set("remote.access", "fake");
    settings.set("remote.enabled", true);
    expect(await online()).toMatchObject({ state: "error", error: adapter.fail });
    expect(() => svc.pair("view")).toThrow(`Remote access isn't ready: ${adapter.fail}`);
    expect(() => svc.pair("view")).not.toThrow(/relay/);

    // Check Again: publishes again, then the checklist.
    adapter.fail = null;
    expect(await svc.setup()).toEqual([{ id: "published", title: "Publish", state: "ok", detail: String(settings.settings["remote.port"]) }]);
    expect(await online()).toMatchObject({ state: "online" });
    expect(adapter.calls.filter((c) => c.startsWith("enable"))).toHaveLength(2);

    settings.set("remote.enabled", false);
    await svc.ready();
    expect(adapter.calls.at(-1)).toMatch(/^disable/);
    expect(svc.status()).toMatchObject({ state: "off", error: null });
  });
});

describe("Check Again on a published mode", () => {
  it("listens again when its port was taken, without publishing again", async () => {
    const port = freePort();
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", r));
    const { adapter, settings, svc, online } = await service(port);
    settings.set("remote.access", "fake");
    settings.set("remote.enabled", true);
    expect(await online()).toMatchObject({ state: "error", error: expect.stringMatching(/is in use/) });
    await new Promise((r) => blocker.close(r));
    await svc.setup();
    expect(await online()).toMatchObject({ state: "online", address: "https://fake.example" });
    expect(adapter.calls).toEqual([`enable ${port} 8443`]);
  });

  it("listens again when its port was taken and the adapter published after that", async () => {
    const port = freePort();
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", r));
    const { adapter, settings, svc, online } = await service(port);
    let release!: () => void;
    adapter.hold = new Promise<void>((r) => (release = r));
    settings.set("remote.access", "fake");
    settings.set("remote.enabled", true);
    expect(await online()).toMatchObject({ state: "error", error: expect.stringMatching(/is in use/) });
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.status()).toMatchObject({ state: "error", error: expect.stringMatching(/is in use/) });
    await new Promise((r) => blocker.close(r));
    await svc.setup();
    expect(await online()).toMatchObject({ state: "online", address: "https://fake.example" });
  });
});

describe("the relay mode's web client", () => {
  it("is an address only when it's an http(s) URL", () => {
    expect(webClient(" https://cmd.example.com/ ")).toBe("https://cmd.example.com");
    expect(webClient("http://localhost:5173")).toBe("http://localhost:5173");
    expect(webClient("cmd.example.com")).toBeNull();
    expect(webClient("ftp://cmd.example.com")).toBeNull();
    expect(webClient("")).toBeNull();
    const link = new RelayLink({ relay: "wss://relay.example", client: () => "cmd.example.com", route: null, secret: null, onRegistered: () => {} });
    expect(link.endpoint()).toBeNull();
  });
});

describe("the relay mode", () => {
  it("says what it's missing in its own words", async () => {
    const { settings, svc } = await service();
    settings.set("remote.relay", " ");
    settings.set("remote.enabled", true);
    await svc.ready();
    expect(svc.status()).toMatchObject({ state: "error", error: "Set a relay (remote.relay)." });
    expect(await svc.checks("relay")).toEqual([]);
    expect(await svc.setup()).toEqual([]);
  });
});

describe("a published mode's runs", () => {
  /** One mode, run by hand: what the service does, with the races laid bare. */
  async function runs() {
    const adapter = fakeAdapter();
    const mode = publishedMode(adapter);
    let settings: Settings = { ...DEFAULT_SETTINGS, "remote.port": freePort(), "remote.enabled": true, "remote.access": "fake" };
    const keys = new HostKeys(null);
    await keys.load();
    const ctx: ModeContext = {
      get settings() {
        return settings;
      },
      selected: true,
      exec: async () => ({ code: 0, stdout: "", stderr: "", error: null }),
      keys,
      webDir: null,
      log: { info: () => {}, warn: () => {} },
      audit: () => {},
    };
    let release = () => {};
    const hold = () => (adapter.hold = new Promise<void>((r) => (release = r)));
    const settle = async () => {
      adapter.hold = null;
      release();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    };
    const set = (s: Partial<Settings>) => (settings = { ...settings, ...s });
    return { adapter, mode, ctx, hold, settle, set, port: settings["remote.port"] };
  }

  it("checks never make a route", async () => {
    const { mode, ctx } = await runs();
    await mode.detect!(ctx);
    expect(ctx.keys.peekDirectRoute("fake")).toBeNull();
    mode.start(ctx, null).transport.close();
    expect(ctx.keys.peekDirectRoute("fake")).toEqual(expect.any(String));
  });

  it("unpublishes once when turned off while enable() is pending", async () => {
    const { adapter, mode, ctx, hold, settle, port } = await runs();
    hold();
    const run = mode.start(ctx, null);
    expect(await run.stop({ restart: false })).toBeNull();
    run.transport.close();
    await settle();
    expect(adapter.calls).toEqual([`enable ${port} 8443`, `disable ${port} 8443`]);
  });

  it("leaves the publication alone on a restart with the same settings, even while enable() is pending", async () => {
    const { adapter, mode, ctx, hold, settle, port } = await runs();
    hold();
    const first = mode.start(ctx, null);
    const carried = await first.stop({ restart: true });
    first.transport.close();
    const second = mode.start(ctx, carried);
    await settle();
    expect(adapter.calls).toEqual([`enable ${port} 8443`, `enable ${port} 8443`]);
    expect(second.transport.state).not.toBe("error");

    // Published: the next run gets it, and undoes it once when turned off, its own enable() pending.
    const published = await second.stop({ restart: true });
    second.transport.close();
    expect(published).toMatchObject({ ctx: { port } });
    hold();
    const third = mode.start(ctx, published);
    await third.stop({ restart: false });
    third.transport.close();
    await settle();
    expect(adapter.calls.slice(2)).toEqual([`enable ${port} 8443`, `disable ${port} 8443`]);
  });

  it("unpublishes with the old settings when a restart changes them, even while enable() is pending", async () => {
    const { adapter, mode, ctx, hold, settle, set, port } = await runs();
    hold();
    const run = mode.start(ctx, null);
    set({ "remote.tailscale.port": 9443 });
    expect(await run.stop({ restart: true })).toBeNull();
    run.transport.close();
    await settle();
    const next = mode.start(ctx, null);
    await settle();
    next.transport.close();
    expect(adapter.calls).toEqual([`enable ${port} 8443`, `disable ${port} 8443`, `enable ${port} 9443`]);
  });
});
