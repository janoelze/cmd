// Every built-in theme has its Dock icon (src/main/dock-icon.ts); `pnpm icons` renders them.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import "@cmd/ui/themes/builtin";
import { allThemes } from "@cmd/ui/themes";

const dir = path.resolve(import.meta.dirname, "../build/themes");

describe("dock icons", () => {
  it("has one per built-in theme, and the default", () => {
    const missing = [...allThemes().map((t) => t.id), "default"].filter((id) => !fs.existsSync(path.join(dir, `${id}.png`)));
    expect(missing, "run `pnpm icons`").toEqual([]);
  });
});
