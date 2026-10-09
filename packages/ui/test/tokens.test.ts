// The design tokens (packages/ui/tokens, DTCG 2025.10) and what's built from them:
// the generated files are current, every override overrides something, and every
// variable the kit's CSS reads is a token or set by the kit itself, so a typo or a
// value made up in a view's CSS shows here instead of falling back silently.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../tokens/build.ts";
import { LIGHT_VARS, SPACE, TOKENS } from "../src/tokens.gen.ts";

const SRC = path.join(import.meta.dirname, "../src");

/** Read by the kit, set by the app: each with a fallback in the kit's CSS. */
const FROM_APP: Record<string, string> = {
  "--window-edge-mix": "the outline contrast setting (ui.windowOutline, look.ts)",
  "--z": "the board's zoom (WindowsView), so outlines stay whole pixels",
};

describe("tokens", () => {
  it("generated files are current (pnpm tokens)", () => {
    const out = build();
    expect(fs.readFileSync(path.join(SRC, "tokens.css"), "utf8")).toBe(out.css);
    expect(fs.readFileSync(path.join(SRC, "tokens.gen.ts"), "utf8")).toBe(out.ts);
  });

  it("names are unique and light overrides exist in the base set", () => {
    const names = TOKENS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const k of Object.keys(LIGHT_VARS)) expect(names).toContain(`--${k}`);
  });

  it("the spacing scale is ordered and on whole pixels", () => {
    const px = SPACE.map((s) => parseFloat(TOKENS.find((t) => t.name === `--space-${s}`)!.value));
    expect(px).toEqual([...px].sort((a, b) => a - b));
    for (const p of px) expect(Number.isInteger(p)).toBe(true);
  });

  it("every variable the kit's CSS reads is a token, set by the kit, or named in FROM_APP", () => {
    const files = fs.readdirSync(SRC, { recursive: true }).map(String);
    const text = (f: string) => fs.readFileSync(path.join(SRC, f), "utf8");
    const kit = files.filter((f) => /\.(css|tsx?)$/.test(f) && f !== "tokens.css" && f !== "tokens.gen.ts").map(text).join("\n");
    const set = new Set([...kit.matchAll(/(--[a-z0-9-]+)\s*:/g), ...kit.matchAll(/["'`](--[a-z0-9-]+)["'`$]/g)].map((m) => m[1]!));
    const tokens = new Set(TOKENS.map((t) => t.name));
    const read = new Set(files.filter((f) => f.endsWith(".css") && f !== "tokens.css").flatMap((f) => [...text(f).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!)));
    const unknown = [...read].filter((v) => !tokens.has(v) && !set.has(v) && !(v in FROM_APP));
    expect(unknown).toEqual([]);
  });
});
