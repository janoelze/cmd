// useSize and the box in a widget's env (API 1.3, docs/57 A2), against the fake host: the box as
// the core sends it (each side rounded down to 8; the renderer sends it at most every 200 ms, tested in
// apps/desktop/test/widget-adapt.test.tsx), null before cmd has measured the window, a resize
// re-rendering the widget; and the fake host's per-size env: each reference window (the
// Workbench's Sizes, `cmd widget preview --sizes`) with its own size class and box.

import { describe, expect, it } from "vitest";
import { render, createHost, sizeEnv } from "@cmd/widget-api/testing";
import { BOX_EVERY_MS, BOX_STEP, PREVIEW_SIZES, WINDOW_BAR_H, roundBox } from "@cmd/protocol";
import { Adapt, Case, Text, View, useEnv, useSize } from "@cmd/widget-api";

function Size() {
  const box = useSize();
  const env = useEnv();
  return <Text>{box ? `${env.size} ${box.width}×${box.height}` : "not measured"}</Text>;
}

describe("useSize", () => {
  it("is the window content's box, rounded down to 8, and follows a resize", async () => {
    const host = createHost({ env: { size: "regular", box: { width: 563, height: 437 } } });
    const tree = await render(Size, host);
    expect(tree.text()).toBe("regular 560×432");
    host.set({ env: { size: "narrow", box: { width: 300.4, height: 213 } } });
    await tree.idle();
    expect(tree.text()).toBe("narrow 296×208");
  });

  it("is null until cmd has measured the window", async () => {
    const tree = await render(Size, createHost({ env: { box: null } }));
    expect(tree.text()).toBe("not measured");
  });

  it("rounds as the spec says: down to 8 px, never negative, nothing for what isn't a box; sent at most every 200 ms", () => {
    expect(BOX_STEP).toBe(8);
    expect(BOX_EVERY_MS).toBe(200);
    expect(roundBox({ width: 3, height: 4 })).toEqual({ width: 0, height: 0 });
    expect(roundBox({ width: -20, height: 1001 })).toEqual({ width: 0, height: 1000 });
    expect(roundBox({ width: Number.NaN, height: 1 })).toBeNull();
    expect(roundBox("320x200")).toBeNull();
  });
});

describe("the fake host's sizes", () => {
  it("gives each reference window its own env: size class and box", async () => {
    const at = async (s: "narrow" | "regular" | "wide") => (await render(Size, createHost({ env: sizeEnv(s) }))).text();
    expect(await at("narrow")).toBe("narrow 320×488");
    expect(await at("regular")).toBe("regular 560×432");
    expect(await at("wide")).toBe("wide 896×528");
    // The window's size less its title bar, rounded.
    expect(sizeEnv("regular").box).toEqual({ width: PREVIEW_SIZES.regular[0], height: roundBox({ width: 0, height: PREVIEW_SIZES.regular[1] - WINDOW_BAR_H })!.height });
  });

  it("gives a size class without a box its reference window's box, and the regular one by default", async () => {
    expect((await render(Size, createHost({ env: { size: "wide" } }))).text()).toBe("wide 896×528");
    expect((await render(Size, createHost())).text()).toBe("regular 560×432");
  });

  it("sends every case of an Adapt in the tree: the app picks one, not the widget", async () => {
    const tree = await render(
      () => (
        <View>
          <Adapt>
            <Case maxWidth={359}>
              <Text>compact</Text>
            </Case>
            <Case>
              <Text>regular</Text>
            </Case>
          </Adapt>
        </View>
      ),
      createHost({ env: sizeEnv("narrow") }),
    );
    expect(tree.findAll("Case").map((c) => c.props.maxWidth ?? null)).toEqual([359, null]);
    expect(tree.text()).toContain("compact");
    expect(tree.text()).toContain("regular");
  });
});
