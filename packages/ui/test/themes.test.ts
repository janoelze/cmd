import { describe, expect, it } from "vitest";

import { allThemes } from "../src/themes/registry.ts";
import "../src/themes/builtin.ts";

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("built-in themes", () => {
  const themes = allThemes();

  it("have unique ids", () => {
    expect(new Set(themes.map((t) => t.id)).size).toBe(themes.length);
  });

  it("use #rrggbb colours", () => {
    for (const t of themes) {
      const colours = { ...t.colors, ...t.terminal, ...t.syntax };
      for (const [k, v] of Object.entries(colours)) expect(v, `${t.id} ${k}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  // 4, not WCAG's 4.5: Solarized Light's own body text on base3 is 4.1.
  it("keep text and accent text readable", () => {
    for (const t of themes) {
      expect(contrast(t.colors.text, t.colors.well), `${t.id} text`).toBeGreaterThanOrEqual(4);
      expect(contrast(t.terminal.foreground, t.terminal.background ?? t.colors.well), `${t.id} terminal`).toBeGreaterThanOrEqual(4);
      expect(contrast(t.vars?.["on-accent"] ?? "#ffffff", t.colors.accent), `${t.id} on-accent`).toBeGreaterThanOrEqual(3);
    }
  });
});
