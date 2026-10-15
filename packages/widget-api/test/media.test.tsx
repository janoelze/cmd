// useMedia and Picture (API 1.3) in a widget's process, against the fake host: what plays,
// live (a change of track or a pause pushed at once, nothing playing as null), the cover kept
// when the core leaves it out of a value (it sends it only when it changed), and a Picture of
// the cover found by its alt and pressed.

import { describe, expect, it } from "vitest";
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import { Picture, Stack, Text, useMedia } from "@cmd/widget-api";
import { keepCover } from "../src/hooks.ts";

const COVER = "data:image/png;base64,iVBORw0KGgo=";

function Player({ onCover }: { onCover?: () => void }) {
  const np = useMedia();
  if (!np) return <Text>Nothing playing</Text>;
  return (
    <Stack>
      <Picture src={np.artwork} alt={`${np.album ?? np.title} cover`} size={64} icon="music.note" onClick={onCover} />
      <Text>{`${np.title} · ${np.playing ? "playing" : "paused"}`}</Text>
    </Stack>
  );
}

describe("useMedia", () => {
  it("shows what plays, live: a pause, a new track, then nothing", async () => {
    const host = createHost({ media: fixtures.playing({ title: "Blue", album: "Kind of Blue", artwork: COVER }) });
    const tree = await render(<Player />, host);
    expect(tree.text()).toContain("Blue · playing");
    expect(tree.find("Picture", "Kind of Blue cover")!.props.src).toBe(COVER);
    expect(host.subscriptions().map((s) => s.topic)).toEqual(["media"]);

    host.set({ media: fixtures.playing({ title: "Blue", album: "Kind of Blue", artwork: COVER, playing: false }) });
    await tree.idle();
    expect(tree.text()).toContain("Blue · paused");

    host.set({ media: fixtures.playing({ title: "So What", album: null, artwork: null }) });
    await tree.idle();
    expect(tree.text()).toContain("So What · playing");
    expect(tree.find("Picture", "So What cover")!.props.src).toBeNull();

    host.set({ media: null });
    await tree.idle();
    expect(tree.text()).toBe("Nothing playing");
    // 1.2's name for it reaches the hook too.
    host.set({ media: undefined, playing: fixtures.playing({ title: "Freddie" }) });
    await tree.idle();
    expect(tree.text()).toContain("Freddie");
  });

  it("presses a Picture", async () => {
    let pressed = 0;
    const tree = await render(<Player onCover={() => pressed++} />, createHost({ media: fixtures.playing({ title: "Blue" }) }));
    await tree.press(tree.find("Picture")!);
    expect(pressed).toBe(1);
  });

  it("keeps the cover when a value comes without one (the core sends it only when it changed)", () => {
    const a = fixtures.playing({ title: "Blue", artwork: COVER });
    const { artwork: _, ...paused } = { ...a, playing: false };
    expect(keepCover(a, paused as never)).toEqual({ ...a, playing: false });
    expect(keepCover(a, { ...a, artwork: null })!.artwork).toBeNull();
    expect(keepCover(a, null)).toBeNull();
    expect(keepCover(null, paused as never)!.artwork).toBeNull();
  });
});
