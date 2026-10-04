// One Dark: Atom's default dark syntax and UI theme.

import type { Theme } from "./types.ts";

export const oneDark: Theme = {
  id: "one-dark",
  title: "One Dark",
  appearance: "dark",
  colors: {
    bg: "#1b1d23", bgSidebar: "#21252b", bgElevated: "#2c313a", well: "#282c34",
    text: "#d7dae0", textDim: "#7f848e", icon: "#abb2bf",
    accent: "#528bff", link: "#61afef", match: "#e5c07b", ink: "#d7dae0", scrim: "#000000",
    stateNeeds: "#d19a66", stateDone: "#98c379", stateWorking: "#61afef", stateIdle: "#5c6370",
  },
  terminal: {
    foreground: "#abb2bf", cursor: "#528bff", selectionBackground: "#3e4451",
    black: "#3f4451", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
    blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
    brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379", brightYellow: "#d19a66",
    brightBlue: "#61afef", brightMagenta: "#c678dd", brightCyan: "#56b6c2", brightWhite: "#ffffff",
  },
  syntax: {
    keyword: "#c678dd", string: "#98c379", number: "#d19a66", comment: "#5c6370",
    function: "#61afef", type: "#e5c07b", property: "#e06c75", heading: "#e06c75", punct: "#abb2bf",
  },
};
