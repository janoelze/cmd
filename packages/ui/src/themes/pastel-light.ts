// Pastel Light: the light counterpart of Pastel Dark (pastel-dark.ts). The same
// hues, deepened until they read on an off-white base; brights are the softer
// in-between tones, the selection a pale wash of Pastel Dark's #3d5a80.

import type { Theme } from "./types.ts";

export const pastelLight: Theme = {
  id: "pastel-light",
  title: "Pastel Light",
  appearance: "light",
  colors: {
    bg: "#eceef1", bgSidebar: "#f1f2f4", bgElevated: "#ffffff", well: "#f8f9fa",
    text: "#24272b", textDim: "#676d76", icon: "#4d535c",
    accent: "#2f80c4", link: "#2a74b3", match: "#e3c75a", ink: "#24272b", scrim: "#24272b",
    stateNeeds: "#b8861c", stateDone: "#4f8f37", stateWorking: "#2f80c4", stateIdle: "#a3a9b2",
  },
  terminal: {
    foreground: "#363a40", cursor: "#676d76", selectionBackground: "#cfe0f3",
    black: "#2e3036", red: "#c0434e", green: "#4f8a35", yellow: "#94771c",
    blue: "#2f7cc0", magenta: "#9c4fb6", cyan: "#1f8893", white: "#b9bfca",
    brightBlack: "#868c96", brightRed: "#d65f67", brightGreen: "#62a347", brightYellow: "#b39431",
    brightBlue: "#4a97d6", brightMagenta: "#b56bcd", brightCyan: "#36a5b0", brightWhite: "#dee3ec",
  },
  syntax: { comment: "#878d97", property: "#2a74b3", punct: "#676d76", cursor: "#363a40" },
};
