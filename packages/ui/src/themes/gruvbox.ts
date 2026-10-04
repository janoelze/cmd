// Gruvbox (Pavel Pertsev): retro groove, warm earth tones. Dark uses the bright
// accents, light the faded ones.

import type { Theme } from "./types.ts";

export const gruvboxDark: Theme = {
  id: "gruvbox-dark",
  title: "Gruvbox Dark",
  appearance: "dark",
  colors: {
    bg: "#1d2021", bgSidebar: "#32302f", bgElevated: "#3c3836", well: "#282828",
    text: "#ebdbb2", textDim: "#a89984", icon: "#d5c4a1",
    accent: "#83a598", link: "#83a598", match: "#fabd2f", ink: "#ebdbb2", scrim: "#000000",
    stateNeeds: "#fe8019", stateDone: "#b8bb26", stateWorking: "#83a598", stateIdle: "#7c6f64",
  },
  terminal: {
    foreground: "#ebdbb2", cursor: "#ebdbb2", selectionBackground: "#504945",
    black: "#282828", red: "#cc241d", green: "#98971a", yellow: "#d79921",
    blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#a89984",
    brightBlack: "#928374", brightRed: "#fb4934", brightGreen: "#b8bb26", brightYellow: "#fabd2f",
    brightBlue: "#83a598", brightMagenta: "#d3869b", brightCyan: "#8ec07c", brightWhite: "#ebdbb2",
  },
  syntax: {
    keyword: "#fb4934", string: "#b8bb26", number: "#d3869b", comment: "#928374",
    function: "#8ec07c", type: "#fabd2f", property: "#83a598", heading: "#fabd2f", punct: "#a89984",
  },
  vars: { "on-accent": "#1d2021" },
};

export const gruvboxLight: Theme = {
  id: "gruvbox-light",
  title: "Gruvbox Light",
  appearance: "light",
  colors: {
    bg: "#f2e5bc", bgSidebar: "#ebdbb2", bgElevated: "#f9f5d7", well: "#fbf1c7",
    text: "#3c3836", textDim: "#7c6f64", icon: "#504945",
    accent: "#076678", link: "#076678", match: "#d79921", ink: "#3c3836", scrim: "#282828",
    stateNeeds: "#af3a03", stateDone: "#79740e", stateWorking: "#076678", stateIdle: "#a89984",
  },
  terminal: {
    foreground: "#3c3836", cursor: "#3c3836", selectionBackground: "#d5c4a1",
    black: "#3c3836", red: "#9d0006", green: "#79740e", yellow: "#b57614",
    blue: "#076678", magenta: "#8f3f71", cyan: "#427b58", white: "#d5c4a1",
    brightBlack: "#928374", brightRed: "#cc241d", brightGreen: "#98971a", brightYellow: "#d79921",
    brightBlue: "#458588", brightMagenta: "#b16286", brightCyan: "#689d6a", brightWhite: "#f9f5d7",
  },
  syntax: {
    keyword: "#9d0006", string: "#79740e", number: "#8f3f71", comment: "#928374",
    function: "#427b58", type: "#b57614", property: "#076678", heading: "#af3a03", punct: "#7c6f64",
  },
  vars: { "on-accent": "#fbf1c7" },
};
