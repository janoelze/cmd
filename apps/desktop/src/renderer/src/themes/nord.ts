// Nord (Arctic Ice Studio): Polar Night backgrounds, Snow Storm text, Frost
// accents, Aurora for state.

import type { Theme } from "./types.ts";

export const nord: Theme = {
  id: "nord",
  title: "Nord",
  appearance: "dark",
  colors: {
    bg: "#272c36", bgSidebar: "#2b303b", bgElevated: "#3b4252", well: "#2e3440",
    text: "#eceff4", textDim: "#8892a6", icon: "#aeb6c6",
    accent: "#88c0d0", link: "#88c0d0", match: "#ebcb8b", ink: "#eceff4", scrim: "#0f1217",
    stateNeeds: "#d08770", stateDone: "#a3be8c", stateWorking: "#81a1c1", stateIdle: "#4c566a",
  },
  terminal: {
    foreground: "#d8dee9", cursor: "#d8dee9", selectionBackground: "#434c5e",
    black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
    blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
    brightBlack: "#616e88", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
  },
  syntax: {
    keyword: "#81a1c1", string: "#a3be8c", number: "#b48ead", comment: "#616e88",
    function: "#88c0d0", type: "#8fbcbb", property: "#d8dee9", heading: "#88c0d0", punct: "#aeb6c6",
  },
  vars: { "on-accent": "#2e3440" },
};
