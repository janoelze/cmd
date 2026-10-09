// Access modes (docs/38): the registry, and RemoteService driving a fake port
// publisher wrapped by publishedMode(): when it publishes, unpublishes when its
// settings change or it's switched off, retries on Check Again, and that each mode
// speaks for itself (no relay wording in a direct mode).
import { afterEach, describe, expect, it } from "vitest";
import { SettingsService } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { AccessAdapter } from "../src/remote/access/adapter.ts";
import { registerBuiltinModes } from "../src/remote/access/builtin.ts";
import { AccessModes } from "../src/remote/access/mode.ts";
import { publishedMode } from "../src/remote/access/published.ts";
import { relayMode } from "../src/remote/access/relay.ts";
import { RemoteService } from "../src/remote/service.ts";

/** A publisher that records what it's asked, and fails while `fail` says why. */
function fakeAdapter() {
  const calls: string[] = [];
  const a: AccessAdapter & { fail: string | null; calls: string[] } = {
    id: "fake",
    title: "Fake",
    icon: "link",
    description: "A pretend proxy.",
    settings: ["remote.tailscale.port"],
    connecting: "Faking it…",
    fail: null,
    calls,
    detect: async (ctx) => [{ id: "published", title: "Publish", state: a.fail ? "todo" : "ok", detail: String(ctx.port) }],
    enable: async (ctx) => {
      calls.push(`enable ${ctx.port} ${ctx.settings["remote.tailscale.port"]}`);
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

  it("makes fresh modes per registry, so two services don't share a run", () => {
    const a = new AccessModes();
    const b = new AccessModes();
    registerBuiltinModes(a);
    registerBuiltinModes(b);
    expect(a.get("tailscale")).not.toBe(b.get("tailscale"));
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
