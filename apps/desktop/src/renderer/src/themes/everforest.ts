// Everforest (sainnhe/everforest), medium contrast, dark and light: windows on
// bg0, chrome on bg_dim, selection as bg_visual. Terminal colours as the
// plugin sets them, except bright black, which there is bg3 and unreadable as
// dim text; here it is grey0. Syntax as in the plugin (keywords red, functions
// and strings green, types yellow). Light uses blue as the accent: white text
// on Everforest's light green doesn't read.

import type { Theme } from "./types.ts";

export const everforestDark: Theme = {
  id: "everforest-dark",
  title: "Everforest Dark",
  appearance: "dark",
  colors: {
    bg: "#232a2e", bgSidebar: "#232a2e", bgElevated: "#3d484d", well: "#2d353b",
    text: "#d3c6aa", textDim: "#859289", icon: "#9da9a0",
    accent: "#a7c080", link: "#7fbbb3", match: "#dbbc7f", ink: "#d3c6aa", scrim: "#000000",
    stateNeeds: "#e69875", stateDone: "#a7c080", stateWorking: "#7fbbb3", stateIdle: "#7a8478",
  },
  terminal: {
    foreground: "#d3c6aa", cursor: "#d3c6aa", selectionBackground: "#543a48",
    black: "#475258", red: "#e67e80", green: "#a7c080", yellow: "#dbbc7f",
    blue: "#7fbbb3", magenta: "#d699b6", cyan: "#83c092", white: "#d3c6aa",
    brightBlack: "#7a8478", brightRed: "#e67e80", brightGreen: "#a7c080", brightYellow: "#dbbc7f",
    brightBlue: "#7fbbb3", brightMagenta: "#d699b6", brightCyan: "#83c092", brightWhite: "#d3c6aa",
  },
  syntax: {
    keyword: "#e67e80", string: "#a7c080", number: "#d699b6", comment: "#859289",
    function: "#a7c080", type: "#dbbc7f", property: "#7fbbb3", heading: "#e69875", punct: "#9da9a0",
  },
  vars: { "on-accent": "#2d353b" },
};

export const everforestLight: Theme = {
  id: "everforest-light",
  title: "Everforest Light",
  appearance: "light",
  colors: {
    bg: "#efebd4", bgSidebar: "#f4f0d9", bgElevated: "#fffbef", well: "#fdf6e3",
    text: "#5c6a72", textDim: "#829181", icon: "#708089",
    accent: "#3a94c5", link: "#3a94c5", match: "#dfa000", ink: "#5c6a72", scrim: "#5c6a72",
    stateNeeds: "#f57d26", stateDone: "#8da101", stateWorking: "#3a94c5", stateIdle: "#a6b0a0",
  },
  terminal: {
    foreground: "#5c6a72", cursor: "#5c6a72", selectionBackground: "#eaedc8",
    black: "#5c6a72", red: "#f85552", green: "#8da101", yellow: "#dfa000",
    blue: "#3a94c5", magenta: "#df69ba", cyan: "#35a77c", white: "#e6e2cc",
    brightBlack: "#a6b0a0", brightRed: "#f85552", brightGreen: "#8da101", brightYellow: "#dfa000",
    brightBlue: "#3a94c5", brightMagenta: "#df69ba", brightCyan: "#35a77c", brightWhite: "#e6e2cc",
  },
  syntax: {
    keyword: "#f85552", string: "#8da101", number: "#df69ba", comment: "#939f91",
    function: "#8da101", type: "#dfa000", property: "#3a94c5", heading: "#f57d26", punct: "#829181",
  },
};
