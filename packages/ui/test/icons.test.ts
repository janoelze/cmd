// The icons (Phosphor, packages/ui/icons): the generated name lists and fonts are
// current with @phosphor-icons/core and /web, and both lists hold the same names.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build, FONTS } from "../icons/build.ts";
import { ICONS } from "../src/icons.gen.ts";

const UI = path.join(import.meta.dirname, "..");

describe("icons", () => {
  it("generated files are current (pnpm symbols)", () => {
    const out = build();
    expect(fs.readFileSync(path.join(UI, "src/icons.gen.ts"), "utf8")).toBe(out.ts);
    expect(fs.readFileSync(path.join(UI, "../protocol/src/icons.gen.ts"), "utf8")).toBe(out.names);
    for (const [weight, src] of Object.entries(FONTS)) {
      const font = fs.readFileSync(path.join(UI, `src/fonts/phosphor-${weight}.woff2`));
      expect(font.equals(fs.readFileSync(path.join(UI, "node_modules/@phosphor-icons/web/src", src))), weight).toBe(true);
    }
  });

  it("the core and the kit know the same icons", () => {
    // Read, not imported: the kit imports no other package (test/imports.test.ts).
    const names = fs.readFileSync(path.join(UI, "../protocol/src/icons.gen.ts"), "utf8").split("`")[3]!.trim().split(/\s+/);
    expect(names.sort()).toEqual(Object.keys(ICONS).sort());
  });
});
