// Ayu (ayu-theme/ayu-colors, the `ayu` npm package): Dark, Mirage and Light,
// from its generated schemes: windows on editor.bg, chrome on ui.bg (Light:
// surface.sunk), the accent with its own `on` colour, terminal colours as
// generated except bright black, which Dark and Mirage set to the background
// colour; here it is the comment grey. Translucent selections are flattened.

import type { Theme } from "./types.ts";

export const ayuDark: Theme = {
  id: "ayu-dark",
  title: "Ayu Dark",
  appearance: "dark",
  colors: {
    bg: "#0d1017", bgSidebar: "#0d1017", bgElevated: "#1b1f29", well: "#10141c",
    text: "#bfbdb6", textDim: "#697081", icon: "#828791",
    accent: "#e6b450", link: "#59c2ff", match: "#e6b450", ink: "#bfbdb6", scrim: "#000000",
    stateNeeds: "#ff8f40", stateDone: "#70bf56", stateWorking: "#59c2ff", stateIdle: "#5a6378",
  },
  terminal: {
    foreground: "#bfbdb6", cursor: "#e6b450", selectionBackground: "#193155",
    black: "#0a0000", red: "#e6495a", green: "#97c142", yellow: "#e89d37",
    blue: "#17acf2", magenta: "#c385fe", cyan: "#84ceb5", white: "#ffffff",
    brightBlack: "#5a6673", brightRed: "#f07178", brightGreen: "#aad94c", brightYellow: "#ffb454",
    brightBlue: "#59c2ff", brightMagenta: "#d2a6ff", brightCyan: "#95e6cb", brightWhite: "#ffffff",
  },
  syntax: {
    keyword: "#ff8f40", string: "#aad94c", number: "#d2a6ff", comment: "#5a6673",
    function: "#ffb454", type: "#59c2ff", property: "#39bae6", heading: "#ff8f40", punct: "#f29668",
  },
  vars: { "on-accent": "#765b24" },
};

export const ayuMirage: Theme = {
  id: "ayu-mirage",
  title: "Ayu Mirage",
  appearance: "dark",
  colors: {
    bg: "#1f2430", bgSidebar: "#1f2430", bgElevated: "#2d3443", well: "#242936",
    text: "#cccac2", textDim: "#707a8c", icon: "#8a919e",
    accent: "#ffcc66", link: "#73d0ff", match: "#ffcc66", ink: "#cccac2", scrim: "#000000",
    stateNeeds: "#ffa659", stateDone: "#87d96c", stateWorking: "#73d0ff", stateIdle: "#707a8c",
  },
  terminal: {
    foreground: "#cccac2", cursor: "#ffcc66", selectionBackground: "#2b4668",
    black: "#0a0000", red: "#f06b5c", green: "#bfe76d", yellow: "#e6b752",
    blue: "#3bbbf4", magenta: "#d09ffd", cyan: "#84ceb5", white: "#d2d6dc",
    brightBlack: "#6e7c8f", brightRed: "#f39184", brightGreen: "#d5ff80", brightYellow: "#ffcd66",
    brightBlue: "#73d0ff", brightMagenta: "#dfbfff", brightCyan: "#95e6cb", brightWhite: "#e3e6ea",
  },
  syntax: {
    keyword: "#ffa659", string: "#d5ff80", number: "#dfbfff", comment: "#6e7c8f",
    function: "#ffcd66", type: "#73d0ff", property: "#5ccfe6", heading: "#ffa659", punct: "#f29e74",
  },
  vars: { "on-accent": "#735923" },
};

export const ayuLight: Theme = {
  id: "ayu-light",
  title: "Ayu Light",
  appearance: "light",
  colors: {
    bg: "#ebeef0", bgSidebar: "#f8f9fa", bgElevated: "#ffffff", well: "#fcfcfc",
    text: "#5c6166", textDim: "#828e9f", icon: "#6b7d8f",
    accent: "#f29718", link: "#22a4e6", match: "#f29718", ink: "#5c6166", scrim: "#000000",
    stateNeeds: "#fa8532", stateDone: "#6cbf43", stateWorking: "#22a4e6", stateIdle: "#adaeb1",
  },
  terminal: {
    foreground: "#5c6166", cursor: "#f29718", selectionBackground: "#d7e4f6",
    black: "#86878c", red: "#f07171", green: "#86b300", yellow: "#eba400",
    blue: "#22a4e6", magenta: "#a37acc", cyan: "#4cbf99", white: "#adaeb1",
    brightBlack: "#939498", brightRed: "#f07171", brightGreen: "#86b300", brightYellow: "#eba400",
    brightBlue: "#22a4e6", brightMagenta: "#a37acc", brightCyan: "#4cbf99", brightWhite: "#c5c5c8",
  },
  syntax: {
    keyword: "#fa8532", string: "#86b300", number: "#a37acc", comment: "#adaeb1",
    function: "#eba400", type: "#22a4e6", property: "#55b4d4", heading: "#fa8532", punct: "#f2a191",
  },
  vars: { "on-accent": "#7e4b01" },
};
