// Reference windows (docs/40-window-design.md): the stage the *.story.tsx files
// here draw a window's content in. A real window shell (Window, WindowBar) at a
// size the story picks, or at three sizes side by side, so a layout is judged
// where it has to hold up: a narrow strip, a regular tile, a wide one.
// The contents are built from @cmd/ui only; these files hold no view CSS.

import { Window, WindowBar, WindowBody, WindowFrame } from "@cmd/ui";
import type { ReactNode } from "react";

export const SIZES = { narrow: [320, 520], regular: [560, 460], wide: [900, 560] } as const;
export type SizeName = keyof typeof SIZES;

export function RefWindow({ icon, name, size = "wide", children }: { icon: string; name: string; size?: SizeName | readonly [number, number]; children: ReactNode }) {
  const [width, height] = typeof size === "string" ? SIZES[size] : size;
  return (
    <Window selected style={{ width, height, position: "relative", flex: "none" }}>
      <WindowBody style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <WindowBar icon={icon} name={name} />
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>{children}</div>
      </WindowBody>
      <WindowFrame />
    </Window>
  );
}

/** The same window at each size, side by side. */
export function AllSizes({ render }: { render: (size: SizeName) => ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
      {(["narrow", "regular", "wide"] as const).map((s) => (
        <div key={s}>{render(s)}</div>
      ))}
    </div>
  );
}

/** Stand-in pictures: a landscape in a hue, as an SVG data URL, so media stories need no files. */
export function photo(hue: number, seed = 0): string {
  const h2 = (hue + 40) % 360;
  const peak = 30 + ((seed * 37) % 40);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 160 100">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 72%)"/><stop offset="1" stop-color="hsl(${h2} 60% 86%)"/></linearGradient></defs>
<rect width="160" height="100" fill="url(#s)"/><circle cx="${110 - seed * 9}" cy="${28 + seed * 3}" r="9" fill="hsl(${h2} 90% 94%)"/>
<path d="M0 72 L${peak} ${40 + seed} L${peak + 30} 64 L${peak + 60} 34 L160 70 L160 100 L0 100Z" fill="hsl(${hue} 30% 38%)"/>
<path d="M0 84 L50 70 L95 82 L160 74 L160 100 L0 100Z" fill="hsl(${hue} 35% 24%)"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Deterministic noise for stand-in data. */
export function series(n: number, seed: number, base: number, swing: number): number[] {
  let x = seed;
  const out: number[] = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    x = (x * 9301 + 49297) % 233280;
    v = Math.max(0, v + ((x / 233280) - 0.5) * swing);
    out.push(Math.round(v * 10) / 10);
  }
  return out;
}
