// Kanagawa (rebelot/kanagawa.nvim): Wave and Dragon (dark), Lotus (light), from
// the plugin's palette and theme tables: windows on ui.bg, chrome on the
// bg_m3/bg_m2 shades below it, popovers on bg_p1; terminal colours from each
// theme's `term` list, selection as bg_search (waveBlue2 on the dark themes).

import type { Theme } from "./types.ts";

export const kanagawaWave: Theme = {
  id: "kanagawa-wave",
  title: "Kanagawa Wave",
  appearance: "dark",
  colors: {
    bg: "#16161d", bgSidebar: "#181820", bgElevated: "#2a2a37", well: "#1f1f28",
    text: "#dcd7ba", textDim: "#938aa9", icon: "#c8c093",
    accent: "#7e9cd8", link: "#7fb4ca", match: "#e6c384", ink: "#dcd7ba", scrim: "#000000",
    stateNeeds: "#ffa066", stateDone: "#98bb6c", stateWorking: "#7e9cd8", stateIdle: "#54546d",
  },
  terminal: {
    foreground: "#dcd7ba", cursor: "#c8c093", selectionBackground: "#2d4f67",
    black: "#16161d", red: "#c34043", green: "#76946a", yellow: "#c0a36e",
    blue: "#7e9cd8", magenta: "#957fb8", cyan: "#6a9589", white: "#c8c093",
    brightBlack: "#727169", brightRed: "#e82424", brightGreen: "#98bb6c", brightYellow: "#e6c384",
    brightBlue: "#7fb4ca", brightMagenta: "#938aa9", brightCyan: "#7aa89f", brightWhite: "#dcd7ba",
  },
  syntax: {
    keyword: "#957fb8", string: "#98bb6c", number: "#d27e99", comment: "#727169",
    function: "#7e9cd8", type: "#7aa89f", property: "#e6c384", heading: "#7e9cd8", punct: "#9cabca",
  },
  vars: { "on-accent": "#16161d" },
};

export const kanagawaDragon: Theme = {
  id: "kanagawa-dragon",
  title: "Kanagawa Dragon",
  appearance: "dark",
  colors: {
    bg: "#0d0c0c", bgSidebar: "#12120f", bgElevated: "#282727", well: "#181616",
    text: "#c5c9c5", textDim: "#7a8382", icon: "#a6a69c",
    accent: "#8ba4b0", link: "#7fb4ca", match: "#c4b28a", ink: "#c5c9c5", scrim: "#000000",
    stateNeeds: "#b6927b", stateDone: "#87a987", stateWorking: "#8ba4b0", stateIdle: "#625e5a",
  },
  terminal: {
    foreground: "#c5c9c5", cursor: "#c8c093", selectionBackground: "#2d4f67",
    black: "#0d0c0c", red: "#c4746e", green: "#8a9a7b", yellow: "#c4b28a",
    blue: "#8ba4b0", magenta: "#a292a3", cyan: "#8ea4a2", white: "#c8c093",
    brightBlack: "#a6a69c", brightRed: "#e46876", brightGreen: "#87a987", brightYellow: "#e6c384",
    brightBlue: "#7fb4ca", brightMagenta: "#938aa9", brightCyan: "#7aa89f", brightWhite: "#c5c9c5",
  },
  syntax: {
    keyword: "#8992a7", string: "#8a9a7b", number: "#a292a3", comment: "#737c73",
    function: "#8ba4b0", type: "#8ea4a2", property: "#c4b28a", heading: "#8ba4b0", punct: "#9e9b93",
  },
  vars: { "on-accent": "#0d0c0c" },
};

export const kanagawaLotus: Theme = {
  id: "kanagawa-lotus",
  title: "Kanagawa Lotus",
  appearance: "light",
  colors: {
    bg: "#dcd5ac", bgSidebar: "#e5ddb0", bgElevated: "#f2ecbc", well: "#f2ecbc",
    text: "#545464", textDim: "#716e61", icon: "#43436c",
    accent: "#4d699b", link: "#4d699b", match: "#de9800", ink: "#545464", scrim: "#545464",
    stateNeeds: "#cc6d00", stateDone: "#6f894e", stateWorking: "#4d699b", stateIdle: "#a09cac",
  },
  terminal: {
    foreground: "#545464", cursor: "#43436c", selectionBackground: "#c9cbd1",
    black: "#1f1f28", red: "#c84053", green: "#6f894e", yellow: "#77713f",
    blue: "#4d699b", magenta: "#b35b79", cyan: "#597b75", white: "#545464",
    brightBlack: "#8a8980", brightRed: "#d7474b", brightGreen: "#6e915f", brightYellow: "#836f4a",
    brightBlue: "#6693bf", brightMagenta: "#624c83", brightCyan: "#5e857a", brightWhite: "#43436c",
  },
  syntax: {
    keyword: "#624c83", string: "#6f894e", number: "#b35b79", comment: "#8a8980",
    function: "#4d699b", type: "#597b75", property: "#77713f", heading: "#4d699b", punct: "#4e8ca2",
  },
};
