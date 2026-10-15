// Media Controls against the fake host (@cmd/widget-api/testing): the native Now Playing's job.
// The track, artist and album, the scrubber at the reported position with the time gone and
// left, the title bar's line; Previous, Play/Pause and Next and a seek, each one media.control;
// it asks again every 2 seconds and follows a new track; nothing playing, loading, refused
// (reading, and controlling), failed; a track without a length; a cmd before API 1.2.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, createHost, fixtures, type FakeHost } from "@cmd/widget-api/testing";
import MediaControls, { EVERY, clock, position } from "./nowplaying.tsx";

const { playing } = fixtures;
const track = (over: Parameters<typeof playing>[0] = {}) => playing({ app: "com.spotify.client", title: "Teardrop", artist: "Massive Attack", album: "Mezzanine", duration: 330, elapsed: 75, at: Date.now(), ...over });

/** A host whose answers to `method` are held until `release()`. */
function holding(host: FakeHost, method: string) {
  const held: Parameters<FakeHost["transport"]["send"]>[0][] = [];
  const h = Object.create(host) as FakeHost;
  Object.defineProperty(h, "transport", { value: { listen: host.transport.listen, send: (m: (typeof held)[number]) => (m.kind === "call" && m.method === method ? held.push(m) : host.transport.send(m)) } });
  return { host: h, release: () => held.splice(0).forEach((m) => host.transport.send(m)) };
}

afterEach(() => vi.useRealTimers());

describe("Media Controls", () => {
  it("shows the track, where it is on the scrubber and the time gone and left", async () => {
    const tree = await render(<MediaControls />, createHost({ playing: track() }));
    expect(tree.text()).toContain("Teardrop");
    expect(tree.text()).toContain("Massive Attack · Mezzanine");
    const bar = tree.find("TimeBar");
    expect(bar.props).toMatchObject({ duration: 330, playing: true, rate: 1 });
    expect(Math.round(bar.props.time as number)).toBe(75);
    expect(tree.text()).toMatch(/1:1[5-6]/);
    expect(tree.text()).toMatch(/−4:1[4-5]/);
    expect(tree.find("Window").props.status).toBe("Teardrop · Massive Attack");
    // No footer naming the app, as the native view.
    expect(tree.findAll("StatusLine")).toHaveLength(0);
    expect(tree.text()).not.toContain("Spotify");
    expect(tree.findAll("IconButton").map((b) => b.props.label)).toEqual(["Previous", "Pause", "Next"]);
  });

  it("sends each control and a seek as one media.control, then looks again", async () => {
    const host = createHost({ playing: track() });
    const tree = await render(<MediaControls />, host);
    const asked = () => host.requests.filter((r) => r[0] === "media.get").length;
    const before = asked();
    await tree.press(tree.find("IconButton", (b) => b.props.label === "Pause"));
    await tree.press(tree.find("IconButton", (b) => b.props.label === "Next"));
    await tree.press(tree.find("IconButton", (b) => b.props.label === "Previous"));
    await tree.pick(tree.find("TimeBar"), 200);
    expect(host.calls).toEqual([["media.control", "toggle"], ["media.control", "next"], ["media.control", "previous"], ["media.control", null, { seek: 200 }]]);
    expect(asked()).toBe(before + 4);
  });

  it("asks again every 2 seconds and follows the player: paused, then a new track", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const host = createHost({ playing: track() });
    const tree = await render(<MediaControls />, host);
    host.set({ playing: track({ playing: false, elapsed: 80 }) });
    vi.advanceTimersByTime(EVERY * 1000);
    await tree.idle();
    expect(tree.find("TimeBar").props).toMatchObject({ playing: false, time: 80 });
    expect(tree.findAll("IconButton").map((b) => b.props.label)).toContain("Play");
    host.set({ playing: track({ title: "Angel", elapsed: 0 }) });
    vi.advanceTimersByTime(EVERY * 1000);
    await tree.idle();
    expect(tree.find("Window").props.status).toBe("Angel · Massive Attack");
  });

  it("says nothing plays, and that it is looking while the first answer is on its way", async () => {
    const { host, release } = holding(createHost({ playing: null }), "media.get");
    const tree = await render(<MediaControls />, host);
    expect(tree).toShowState("loading", "Looking for what's playing");
    release();
    await tree.idle();
    expect(tree).toShowState("empty", "Nothing playing");
    expect(tree.find("Window").props.status).toBeNull();
    expect(tree.findAll("IconButton")).toHaveLength(0);
  });

  it("says what it needs when reading what plays is refused", async () => {
    const tree = await render(<MediaControls />, createHost({ playing: track(), deny: { "media.get": 'media: ["read"]' } }));
    expect(tree).toShowState("error", "What's playing isn't shared with this widget");
  });

  it("says so below when a control is refused, and the player stays", async () => {
    const host = createHost({ playing: track(), deny: { "media.control": 'media: ["control"]' } });
    const tree = await render(<MediaControls />, host);
    await tree.press(tree.find("IconButton", (b) => b.props.label === "Next"));
    expect(tree.text()).toContain("Controlling what plays isn't allowed for this widget");
    expect(tree.text()).toContain("Teardrop");
  });

  it("says it couldn't see what's playing, with Try Again", async () => {
    let fail = true;
    const host = createHost({ playing: track() });
    const flaky = Object.create(host) as FakeHost;
    Object.defineProperty(flaky, "transport", {
      value: { listen: host.transport.listen, send: (m: Parameters<FakeHost["transport"]["send"]>[0]) => (fail && m.kind === "call" && m.method === "media.get" ? host.deliver({ kind: "result", id: m.id, ok: false, error: { code: "failed", message: "The player didn't answer." } }) : host.transport.send(m)) },
    });
    const tree = await render(<MediaControls />, flaky);
    expect(tree).toShowState("error", "Couldn't see what's playing");
    fail = false;
    await tree.choose(tree.find("View"), "Try Again", "state");
    expect(tree.text()).toContain("Teardrop");
  });

  it("leaves the scrubber out for a stream without a length", async () => {
    const tree = await render(<MediaControls />, createHost({ playing: track({ duration: null, title: "Radio Paradise", artist: null, album: null }) }));
    expect(tree.findAll("TimeBar")).toHaveLength(0);
    expect(tree.find("Window").props.status).toBe("Radio Paradise");
    expect(tree.findAll("IconButton")).toHaveLength(3);
  });

  it("cuts a long line in the title bar short, and leaves it out in a narrow window", async () => {
    const long = track({ title: "Concerto for Two Violins in D Minor, BWV 1043: II. Largo ma non tanto" });
    const tree = await render(<MediaControls />, createHost({ playing: long }));
    expect(tree.find("Window").props.status).toBe("Concerto for Two Violins in D Minor, BW…");
    const narrow = await render(<MediaControls />, createHost({ playing: long, env: { size: "narrow" } }));
    expect(narrow.find("Window").props.status).toBeNull();
    expect(narrow.text()).toContain("BWV 1043");
  });

  it("says it needs a newer cmd on one before API 1.2, and asks nothing", async () => {
    const older = createHost({ env: { api: { major: 1, minor: 1 }, verbs: ["events.query"], elements: undefined }, playing: track() });
    const tree = await render(<MediaControls />, older);
    expect(tree).toShowState("empty", "Needs a newer cmd");
    expect(older.requests.some((r) => r[0] === "media.get")).toBe(false);
  });

  it("moves the position on while playing, within the track", () => {
    const n = { elapsed: 10, at: 1_000, rate: 1, playing: true, duration: 20 };
    expect(position(n, 6_000)).toBe(15);
    expect(position(n, 60_000)).toBe(20);
    expect(position({ ...n, playing: false }, 60_000)).toBe(10);
    expect(position({ ...n, rate: 2 }, 3_000)).toBe(14);
    expect(position({ ...n, elapsed: null })).toBeNull();
    expect(clock(187)).toBe("3:07");
    expect(clock(3729)).toBe("1:02:09");
  });
});
