// Tokyo Night (enkia, folke's palette): the Night variant.

import type { Theme } from "./types.ts";

export const tokyoNight: Theme = {
  id: "tokyo-night",
  title: "Tokyo Night",
  appearance: "dark",
  colors: {
    bg: "#16161e", bgSidebar: "#1f2335", bgElevated: "#24283b", well: "#1a1b26",
    text: "#c0caf5", textDim: "#737aa2", icon: "#a9b1d6",
    accent: "#7aa2f7", link: "#7dcfff", match: "#e0af68", ink: "#c0caf5", scrim: "#000000",
    stateNeeds: "#ff9e64", stateDone: "#9ece6a", stateWorking: "#7aa2f7", stateIdle: "#565f89",
  },
  terminal: {
    foreground: "#c0caf5", cursor: "#c0caf5", selectionBackground: "#283457",
    black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
    blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
    brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a", brightYellow: "#e0af68",
    brightBlue: "#7aa2f7", brightMagenta: "#bb9af7", brightCyan: "#7dcfff", brightWhite: "#c0caf5",
  },
  syntax: {
    keyword: "#bb9af7", string: "#9ece6a", number: "#ff9e64", comment: "#565f89",
    function: "#7aa2f7", type: "#2ac3de", property: "#73daca", heading: "#7aa2f7", punct: "#89ddff",
  },
  vars: { "on-accent": "#16161e" },
};
