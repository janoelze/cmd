// Rosé Pine (rose-pine/palette): Main and Moon (dark), Dawn (light). Windows on
// base, chrome on the darker non-current shade from rose-pine/neovim (_nc),
// popovers on overlay; iris as the accent. Terminal colours as in the official
// terminal ports (pine as green, foam as blue, rose as cyan; brights repeat the
// normals); syntax as in rose-pine/neovim.

import type { Theme } from "./types.ts";

interface Variant {
  base: string; surface: string; overlay: string; nc: string;
  muted: string; subtle: string; text: string;
  love: string; gold: string; rose: string; pine: string; foam: string; iris: string;
  highlightMed: string;
}

function rosePine(id: string, title: string, appearance: "dark" | "light", v: Variant): Theme {
  const light = appearance === "light";
  return {
    id, title, appearance,
    colors: {
      bg: light ? v.overlay : v.nc, bgSidebar: v.nc, bgElevated: light ? v.surface : v.overlay, well: v.base,
      text: v.text, textDim: v.subtle, icon: v.subtle,
      accent: v.iris, link: v.foam, match: v.gold, ink: v.text, scrim: light ? v.text : "#000000",
      stateNeeds: v.gold, stateDone: v.foam, stateWorking: v.iris, stateIdle: v.muted,
    },
    terminal: {
      foreground: v.text, cursor: v.text, selectionBackground: v.highlightMed,
      black: v.overlay, red: v.love, green: v.pine, yellow: v.gold,
      blue: v.foam, magenta: v.iris, cyan: v.rose, white: v.text,
      brightBlack: v.muted, brightRed: v.love, brightGreen: v.pine, brightYellow: v.gold,
      brightBlue: v.foam, brightMagenta: v.iris, brightCyan: v.rose, brightWhite: v.text,
    },
    syntax: {
      keyword: v.pine, string: v.gold, number: v.gold, comment: v.muted,
      function: v.rose, type: v.foam, property: v.foam, heading: v.iris, punct: v.subtle,
    },
    vars: light ? undefined : { "on-accent": v.base },
  };
}

export const rosePineMain = rosePine("rose-pine", "Rosé Pine", "dark", {
  base: "#191724", surface: "#1f1d2e", overlay: "#26233a", nc: "#16141f",
  muted: "#6e6a86", subtle: "#908caa", text: "#e0def4",
  love: "#eb6f92", gold: "#f6c177", rose: "#ebbcba", pine: "#31748f", foam: "#9ccfd8", iris: "#c4a7e7",
  highlightMed: "#403d52",
});

export const rosePineMoon = rosePine("rose-pine-moon", "Rosé Pine Moon", "dark", {
  base: "#232136", surface: "#2a273f", overlay: "#393552", nc: "#1f1d30",
  muted: "#6e6a86", subtle: "#908caa", text: "#e0def4",
  love: "#eb6f92", gold: "#f6c177", rose: "#ea9a97", pine: "#3e8fb0", foam: "#9ccfd8", iris: "#c4a7e7",
  highlightMed: "#44415a",
});

export const rosePineDawn = rosePine("rose-pine-dawn", "Rosé Pine Dawn", "light", {
  base: "#faf4ed", surface: "#fffaf3", overlay: "#f2e9e1", nc: "#f8f0e7",
  muted: "#9893a5", subtle: "#797593", text: "#464261",
  love: "#b4637a", gold: "#ea9d34", rose: "#d7827e", pine: "#286983", foam: "#56949f", iris: "#907aa9",
  highlightMed: "#dfdad9",
});
