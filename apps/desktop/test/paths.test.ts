import { afterEach, describe, expect, it } from "vitest";
import { homeOf, shortPath } from "../src/renderer/src/model.ts";

describe("shortPath", () => {
  afterEach(() => delete (globalThis as { cmd?: unknown }).cmd);
  it("shortens the user's home, wherever it is", () => {
    (globalThis as { cmd?: unknown }).cmd = { homeDir: "/private/tmp/demo-home" };
    expect(shortPath("/private/tmp/demo-home/src/atlas")).toBe("~/src/atlas");
    expect(shortPath("/private/tmp/demo-home")).toBe("~");
    expect(shortPath("/private/tmp/demo-home-2/x")).toBe("/private/tmp/demo-home-2/x");
  });
  it("falls back to any /Users/<name>", () => {
    expect(shortPath("/Users/sam/src/cmd")).toBe("~/src/cmd");
    expect(homeOf("/etc/hosts")).toBe(null);
  });
});
