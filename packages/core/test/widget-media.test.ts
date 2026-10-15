// API 1.3's live `media` topic (docs/57 C1; widgets/api/topics.ts subscribeMedia): with
// `media: ["read"]` it pushes what plays at once and again on each change of the Now Playing
// stream (what the app hears as nowPlaying.changed), holding the stream while subscribed and
// letting it go when the last subscriber leaves; the cover crosses only when it changed.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noPermissions, type CoreEvent, type NowPlaying, type WidgetPermissions, type WireValue } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { ApiRefusal } from "../src/widgets/api/access.ts";
import { AiUsage } from "../src/widgets/api/ai.ts";
import { widgetApi, type WidgetApi } from "../src/widgets/api/adapter.ts";
import type { NowPlayingHold } from "../src/nowplaying/feature.ts";
import { fakeFactory } from "./fake-pty.ts";
import { tmp, until, writePackage } from "./fake-widget-runtime.ts";

let core: Core;
let windowId: string;
const COVER = "data:image/png;base64,iVBORw0KGgo=";
const PLAYING: NowPlaying = { app: "com.apple.Music", title: "Song", artist: "Artist", album: null, playing: true, duration: 200, elapsed: 10, at: 1, rate: 1, artwork: COVER };

/** A fake Now Playing stream: what plays, its listeners, and how many hold it. */
const stream = {
  now: PLAYING as NowPlaying | null,
  holds: 0,
  fns: new Set<() => void>(),
  change(n: NowPlaying | null) {
    this.now = n;
    for (const fn of [...this.fns]) fn();
  },
  hold(): NowPlayingHold {
    stream.holds++;
    let held = true;
    return {
      read: async () => stream.now,
      on: (fn) => (stream.fns.add(fn), () => void stream.fns.delete(fn)),
      release: () => void (held && (stream.holds--, (held = false))),
    };
  },
};

function adapter(permissions: Partial<WidgetPermissions>): WidgetApi {
  const pkg = core.library.packages.forKind("pkg:demo/main")!;
  const ctx = { agents: core.agents, panes: core.panes, windows: core.windows, windowTypes: core.windowTypes, workspaces: core.workspaces, data: core.data, actions: core.actions, notifications: core.notifications, ai: core.ai, settings: core.settings, resources: core.resources, stats: core.stats, journal: core.journal, broadcast: (e: CoreEvent) => core.server.broadcast(e), opened: <W>(w: W) => w, call: core.call.bind(core) as never };
  return widgetApi(ctx, {
    windowId,
    workspaceId: () => core.workspaces.home().id,
    pkg,
    widget: pkg.widgets[0]!,
    permissions: { ...noPermissions(), ...permissions },
    press: { at: () => 0, remote: () => false, take: () => {} },
    secret: () => null,
    aiUsage: new AiUsage(null),
    media: { get: async () => stream.now, control: async () => {}, hold: () => stream.hold() },
  });
}

beforeAll(async () => {
  const home = tmp("cmd-widgets-home-");
  writePackage(home);
  process.env.CMD_WIDGETS_HOME = home;
  core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0 });
  delete process.env.CMD_WIDGETS_HOME;
  core.start();
  await core.scheduler.idle();
  core.library.packages.start();
  windowId = core.windows.open("pkg:demo/main", {}, core.workspaces.home()).id;
});

afterAll(async () => {
  await core?.close();
});

describe("the media topic", () => {
  it("is refused without media: [\"read\"]", () => {
    let e: unknown;
    try {
      adapter({}).subscribe("media", null, () => {});
    } catch (x) {
      e = x;
    }
    expect((e as ApiRefusal).error).toMatchObject({ code: "permission", permission: 'media: ["read"]' });
    expect(stream.holds).toBe(0);
  });

  it("pushes what plays now and on each change, the cover only when it changed", async () => {
    const api = adapter({ media: ["read"] });
    const got: WireValue[] = [];
    const off = api.subscribe("media", null, (d) => got.push(d));
    await until(() => got.length === 1, "the first value");
    expect(got[0]).toEqual(PLAYING);
    // A pause: the same cover, so it isn't sent again.
    stream.change({ ...PLAYING, playing: false, elapsed: 42 });
    await until(() => got.length === 2, "the pause");
    expect(got[1]).toEqual({ app: "com.apple.Music", title: "Song", artist: "Artist", album: null, playing: false, duration: 200, elapsed: 42, at: 1, rate: 1 });
    expect(got[1]).not.toHaveProperty("artwork");
    // Nothing that differs: nothing sent.
    stream.change({ ...PLAYING, playing: false, elapsed: 42 });
    // A new track with another cover: sent with it.
    stream.change({ ...PLAYING, title: "Next", artwork: "data:image/png;base64,AAAA" });
    await until(() => got.length === 3, "the next track");
    expect(got[2]).toMatchObject({ title: "Next", artwork: "data:image/png;base64,AAAA" });
    // Nothing plays, then something with the last cover again: sent whole (null in between).
    stream.change(null);
    await until(() => got.length === 4, "nothing");
    expect(got[3]).toBeNull();
    stream.change({ ...PLAYING, artwork: "data:image/png;base64,AAAA" });
    await until(() => got.length === 5, "playing again");
    expect(got[4]).toMatchObject({ artwork: "data:image/png;base64,AAAA" });
    off();
  });

  it("holds the Now Playing stream while subscribed and lets it go when the last subscriber leaves", async () => {
    stream.change(PLAYING);
    const a = adapter({ media: ["read"] });
    const b = adapter({ media: ["read"] });
    const offA = a.subscribe("media", null, () => {});
    const offB = b.subscribe("media", null, () => {});
    expect(stream.holds).toBe(2);
    expect(stream.fns.size).toBe(2);
    offA();
    expect(stream.holds).toBe(1);
    offB();
    expect(stream.holds).toBe(0);
    expect(stream.fns.size).toBe(0);
    // A process that ends lets its subscriptions' holds go with them (host.ts unsubscribes each).
    const offC = a.subscribe("media", null, () => {});
    expect(stream.holds).toBe(1);
    offC();
    offC();
    expect(stream.holds).toBe(0);
  });
});
