// Pastel Dark: the Ghostty theme of the same name (~/.config/ghostty/themes),
// its terminal colours exactly, with near-black chrome around #121314 windows
// and the UI's accents taken from the same pastel palette.

import type { Theme } from "./types.ts";

export const pastelDark: Theme = {
  id: "pastel-dark",
  title: "Pastel Dark",
  appearance: "dark",
  colors: {
    bg: "#0a0b0c", bgSidebar: "#0e0f10", bgElevated: "#1b1c1f", well: "#121314",
    text: "#e0e4e8", textDim: "#7d838c", icon: "#a4aab3",
    accent: "#71bef2", link: "#8ad4f5", match: "#dbcb8b", ink: "#c8ccd0", scrim: "#000000",
    stateNeeds: "#eed9a0", stateDone: "#a8cc8c", stateWorking: "#71bef2", stateIdle: "#555a64",
  },
  terminal: {
    foreground: "#c8ccd0", cursor: "#bfbfbf", selectionBackground: "#3d5a80",
    black: "#2e3036", red: "#e88388", green: "#a8cc8c", yellow: "#dbcb8b",
    blue: "#71bef2", magenta: "#d290e4", cyan: "#66c2cd", white: "#b9bfca",
    brightBlack: "#555a64", brightRed: "#f07178", brightGreen: "#b5e4a1", brightYellow: "#eed9a0",
    brightBlue: "#8ad4f5", brightMagenta: "#dfa7f2", brightCyan: "#7fd5de", brightWhite: "#dee3ec",
  },
  // Comments a step lighter than palette 8, which is too faint for code.
  syntax: { comment: "#6c727d", property: "#8ad4f5", punct: "#8b919b", cursor: "#bfbfbf" },
  vars: { "on-accent": "#121314" },
};
