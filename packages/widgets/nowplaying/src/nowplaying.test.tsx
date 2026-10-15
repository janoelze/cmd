// Media Controls against the fake host (@cmd/widget-api/testing): the native Now Playing's job
// and faces. Each face (short, large, the regular one between) at the native view's numbers,
// with its cover, title and controls; the track, the scrubber at the reported position with
// the time gone and left, the title bar's line; live through useMedia: a pause, a new track,
// the cover appearing and changing, nothing playing; Previous, Play/Pause, Next and a seek,
// each one media.control, and a control that fails (refused, or the player not answering);
// a track without a length; reading refused; a cmd before API 1.3.

import { describe, expect, it } from "vitest";
import { render, createHost, fixtures, textOf, type Element, type FakeHost, type RenderedTree } from "@cmd/widget-api/testing";
import MediaControls, { LARGE, SHORT, clock, position } from "./nowplaying.tsx";

const COVER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN4k+AAAAPIAY1v6B/nAAAAAElFTkSuQmCC";
const OTHER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPw0eoBAAHIAQMW+JJnAAAAAElFTkSuQmCC";
const track = (over: Parameters<typeof fixtures.playing>[0] = {}) => fixtures.playing({ app: "com.spotify.client", title: "Teardrop", artist: "Massive Attack", album: "Mezzanine", duration: 330, elapsed: 75, at: Date.now(), artwork: COVER, ...over });

/** The face the app draws in a box of this size: the first Case it fits, as the kit's Adapt picks. */
function face(tree: RenderedTree, width: number, height: number): Element {
  const fits = (c: Element) => {
    const p = c.props as { minWidth?: number; maxWidth?: number; minHeight?: number; maxHeight?: number };
    return (p.minWidth ?? 0) <= width && width <= (p.maxWidth ?? Infinity) && (p.minHeight ?? 0) <= height && height <= (p.maxHeight ?? Infinity);
  };
  const c = tree.findAll("Case").find(fits);
  if (!c) throw new Error(`no face fits ${width}×${height}`);
  return c;
}

/** Every element of `type` inside `n`. */
function inside(n: Element, type: string): Element[] {
  const out: Element[] = [];
  const go = (x: Element) => (x.type === type && out.push(x), x.children.forEach((c) => c.type !== "#text" && go(c as Element)));
  n.children.forEach((c) => c.type !== "#text" && go(c as Element));
  return out;
}

const buttons = (n: Element) => inside(n, "IconButton").map((b) => b.props.label);

describe("Media Controls", () => {
  it("has the native view's three faces: short, large and the one between", async () => {
    const tree = await render(<MediaControls />, createHost({ media: track() }));
    expect(tree.findAll("Adapt")).toHaveLength(1);
    expect(tree.findAll("Case").map((c) => c.props)).toMatchObject([{ maxHeight: SHORT }, { minWidth: LARGE.width, minHeight: LARGE.height }, {}]);
    expect([SHORT, LARGE.width, LARGE.height]).toEqual([280, 340, 440]);
    const short = face(tree, 240, 200);
    const large = face(tree, 480, 520);
    const regular = face(tree, 320, 360);
    expect(face(tree, 600, 240)).toBe(short);
    expect(face(tree, 900, 560)).toBe(large);
    expect(face(tree, 339, 600)).toBe(regular);
    expect(face(tree, 600, 439)).toBe(regular);

    // Short: a 44 px thumbnail in front of the title, which stays at its size.
    expect(inside(short, "Picture")[0]!.props).toMatchObject({ size: 44, radius: "sm", src: COVER, alt: "Mezzanine cover" });
    expect(inside(short, "Text").find((t) => textOf(t) === "Teardrop")!.props).toMatchObject({ size: "lg", truncate: true });
    // The others: the cover takes the room left, the title grows with its column.
    for (const f of [regular, large]) {
      expect(inside(f, "Picture")[0]!.props).toMatchObject({ size: "fill", src: COVER });
      expect(inside(f, "Text").find((t) => textOf(t) === "Teardrop")!.props).toMatchObject({ size: "lg", fit: true });
    }
    // Large is a centred column: the track and the controls centred, the controls apart.
    expect(inside(large, "Stack").some((s) => s.props.align === "center" && textOf(s).includes("Teardrop"))).toBe(true);
    expect(inside(large, "Inline").find((i) => inside(i, "IconButton").length === 3)!.props.gap).toBe(6);
    // Smaller, the controls spread across the width.
    for (const f of [short, regular]) expect(inside(f, "Inline").find((i) => inside(i, "IconButton").length === 3)!.props.justify).toBe("between");
    for (const f of [short, regular, large]) {
      expect(buttons(f)).toEqual(["Previous", "Pause", "Next"]);
      expect(textOf(f)).toContain("Massive Attack · Mezzanine");
      expect(inside(f, "TimeBar")).toHaveLength(1);
    }
  });

  it("shows the track, where it is on the scrubber and the time gone and left", async () => {
    const tree = await render(<MediaControls />, createHost({ media: track() }));
    const bar = tree.find("TimeBar");
    expect(bar.props).toMatchObject({ duration: 330, playing: true, rate: 1 });
    expect(Math.round(bar.props.time as number)).toBe(75);
    expect(tree.text()).toMatch(/1:1[5-6]/);
    expect(tree.text()).toMatch(/−4:1[4-5]/);
    expect(tree.find("Window").props.status).toBe("Teardrop · Massive Attack");
    // No footer naming the app, as the native view.
    expect(tree.findAll("StatusLine")).toHaveLength(0);
    expect(tree.text()).not.toContain("Spotify");
  });

  it("follows the player live: a pause, a new track, then nothing", async () => {
    const host = createHost({ media: track() });
    const tree = await render(<MediaControls />, host);
    expect(host.subscriptions().map((s) => s.topic)).toEqual(["media"]);
    host.set({ media: track({ playing: false, elapsed: 80 }) });
    await tree.idle();
    expect(tree.find("TimeBar").props).toMatchObject({ playing: false, time: 80 });
    expect(buttons(face(tree, 320, 360))).toContain("Play");
    host.set({ media: track({ title: "Angel", elapsed: 0 }) });
    await tree.idle();
    expect(tree.find("Window").props.status).toBe("Angel · Massive Attack");
    host.set({ media: null });
    await tree.idle();
    expect(tree).toShowState("empty", "Nothing playing");
    expect(tree.find("Window").props.status).toBeNull();
    expect(tree.findAll("IconButton")).toHaveLength(0);
    // It never asks: what plays is pushed.
    expect(host.requests.some((r) => r[0] === "media.get")).toBe(false);
  });

  it("shows the cover when it comes and when it changes, and its box with a note without one", async () => {
    const host = createHost({ media: track({ artwork: null, album: null }) });
    const tree = await render(<MediaControls />, host);
    const covers = () => tree.findAll("Picture").map((p) => p.props.src);
    expect(covers()).toEqual([null, null, null]);
    expect(tree.find("Picture").props).toMatchObject({ icon: "music.note", alt: "Cover" });
    host.set({ media: track({ artwork: COVER }) });
    await tree.idle();
    expect(covers()).toEqual([COVER, COVER, COVER]);
    expect(tree.find("Picture").props.alt).toBe("Mezzanine cover");
    host.set({ media: track({ title: "Angel", artwork: OTHER }) });
    await tree.idle();
    expect(covers()).toEqual([OTHER, OTHER, OTHER]);
  });

  it("sends each control and a seek as one media.control", async () => {
    const host = createHost({ media: track() });
    const tree = await render(<MediaControls />, host);
    const regular = () => face(tree, 320, 360);
    const button = (label: string) => inside(regular(), "IconButton").find((b) => b.props.label === label)!;
    await tree.press(button("Pause"));
    await tree.press(button("Next"));
    await tree.press(button("Previous"));
    await tree.pick(inside(regular(), "TimeBar")[0]!, 200);
    expect(host.calls).toEqual([["media.control", "toggle"], ["media.control", "next"], ["media.control", "previous"], ["media.control", null, { seek: 200 }]]);
  });

  it("says so below when a control is refused, and the player stays", async () => {
    const host = createHost({ media: track(), deny: { "media.control": 'media: ["control"]' } });
    const tree = await render(<MediaControls />, host);
    await tree.press(tree.find("IconButton", (b) => b.props.label === "Next"));
    expect(tree.find("StatusLine").children.map((c) => textOf(c)).join("")).toBe("Controlling what plays isn't allowed for this widget");
    expect(tree.text()).toContain("Teardrop");
  });

  it("says so below when the player doesn't answer, and clears it once a control goes through", async () => {
    let fail = true;
    const host = createHost({ media: track() });
    const flaky = Object.create(host) as FakeHost;
    Object.defineProperty(flaky, "transport", {
      value: { listen: host.transport.listen, send: (m: Parameters<FakeHost["transport"]["send"]>[0]) => (fail && m.kind === "call" && m.method === "media.control" ? host.deliver({ kind: "result", id: m.id, ok: false, error: { code: "failed", message: "The player didn't answer." } }) : host.transport.send(m)) },
    });
    const tree = await render(<MediaControls />, flaky);
    await tree.press(tree.find("IconButton", (b) => b.props.label === "Pause"));
    expect(tree.text()).toContain("Couldn't reach the player: The player didn't answer.");
    fail = false;
    await tree.press(tree.find("IconButton", (b) => b.props.label === "Pause"));
    expect(tree.findAll("StatusLine")).toHaveLength(0);
  });

  it("leaves the scrubber out for a stream without a length", async () => {
    const tree = await render(<MediaControls />, createHost({ media: track({ duration: null, title: "Radio Paradise", artist: null, album: null }) }));
    expect(tree.findAll("TimeBar")).toHaveLength(0);
    expect(tree.find("Window").props.status).toBe("Radio Paradise");
    expect(buttons(face(tree, 320, 360))).toHaveLength(3);
  });

  it("puts the whole line in the title bar, which cuts it where it runs out of room", async () => {
    const long = track({ title: "Concerto for Two Violins in D Minor, BWV 1043: II. Largo ma non tanto" });
    const tree = await render(<MediaControls />, createHost({ media: long, env: { size: "narrow" } }));
    expect(tree.find("Window").props.status).toBe("Concerto for Two Violins in D Minor, BWV 1043: II. Largo ma non tanto · Massive Attack");
  });

  it("leaves a refused read to the runtime: useMedia throws it", async () => {
    const tree = await render(<MediaControls />, createHost({ media: track(), deny: { "media.get": 'media: ["read"]' } }));
    expect(tree.find("Callout").props.title).toBe("This widget hit an error");
    expect(tree.text()).not.toContain("Teardrop");
  });

  it("says it needs a newer cmd on one before API 1.3, and listens to nothing", async () => {
    const older = createHost({ env: { api: { major: 1, minor: 2 }, elements: undefined }, media: track() });
    const tree = await render(<MediaControls />, older);
    expect(tree).toShowState("empty", "Needs a newer cmd");
    expect(older.subscriptions()).toHaveLength(0);
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
