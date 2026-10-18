// Icons the core names are Phosphor icons (packages/ui/icons/build.ts): a name that
// isn't one draws nothing in the app, so a window type's or an access mode's icon
// that doesn't exist fails here instead.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ICON_NAMES } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { parseManifest } from "../src/widgets/manifest.ts";
import { fakeFactory } from "./fake-pty.ts";

let core: Core;
beforeEach(() => {
  core = new Core({ socketPath: "/tmp/cmd-test-icons.sock", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0 });
});
afterEach(async () => {
  await core.close();
});

const unknown = (names: string[]) => names.filter((n) => !ICON_NAMES.has(n));

describe("icons", () => {
  it("every window type's icon is a Phosphor icon", () => {
    expect(unknown(core.windowTypes.info().map((t) => t.icon))).toEqual([]);
  });

  it("every access mode's icon is a Phosphor icon", () => {
    expect(unknown(core.remote.modeList().map((m) => m.icon))).toEqual([]);
  });

  it("a widget's icon that isn't one is left out, not an error", () => {
    const base = { cmd: 2, kind: "widget", title: "Weather" };
    const named = parseManifest({ ...base, icon: "cloud-sun" });
    const old = parseManifest({ ...base, icon: "cloud.sun" });
    expect(named.ok && named.manifest.icon).toBe("cloud-sun");
    expect(old.ok && old.manifest.icon).toBeUndefined();
  });
});
