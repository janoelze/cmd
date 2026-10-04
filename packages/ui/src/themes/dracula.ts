// Dracula (Zeno Rocha): the official palette and its ANSI colours.

import type { Theme } from "./types.ts";

export const dracula: Theme = {
  id: "dracula",
  title: "Dracula",
  appearance: "dark",
  colors: {
    bg: "#21222c", bgSidebar: "#191a21", bgElevated: "#343746", well: "#282a36",
    text: "#f8f8f2", textDim: "#7e86ae", icon: "#c0c3d6",
    accent: "#bd93f9", link: "#8be9fd", match: "#f1fa8c", ink: "#f8f8f2", scrim: "#000000",
    stateNeeds: "#ffb86c", stateDone: "#50fa7b", stateWorking: "#bd93f9", stateIdle: "#6272a4",
  },
  terminal: {
    foreground: "#f8f8f2", cursor: "#f8f8f2", selectionBackground: "#44475a",
    black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
    blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
    brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5",
    brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
  },
  syntax: {
    keyword: "#ff79c6", string: "#f1fa8c", number: "#bd93f9", comment: "#6272a4",
    function: "#50fa7b", type: "#8be9fd", property: "#ffb86c", heading: "#bd93f9", punct: "#c0c3d6",
  },
  vars: { "on-accent": "#21222c" },
};
