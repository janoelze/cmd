// GitHub Dark and Light: the "Default" pair of GitHub's VS Code theme
// (primer/github-vscode-theme), from @primer/primitives. Windows on
// canvas.default, chrome on canvas.inset (the theme's sidebar), Primer's ANSI
// colours and syntax tokens, selection as accent.fg at 20%.

import type { Theme } from "./types.ts";

export const githubDark: Theme = {
  id: "github-dark",
  title: "GitHub Dark",
  appearance: "dark",
  colors: {
    bg: "#010409", bgSidebar: "#010409", bgElevated: "#161b22", well: "#0d1117",
    text: "#e6edf3", textDim: "#848d97", icon: "#b1bac4",
    accent: "#2f81f7", link: "#2f81f7", match: "#d29922", ink: "#e6edf3", scrim: "#000000",
    stateNeeds: "#d29922", stateDone: "#3fb950", stateWorking: "#2f81f7", stateIdle: "#6e7681",
  },
  terminal: {
    foreground: "#e6edf3", cursor: "#2f81f7", selectionBackground: "#142744",
    black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922",
    blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
    brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364", brightYellow: "#e3b341",
    brightBlue: "#79c0ff", brightMagenta: "#d2a8ff", brightCyan: "#56d4dd", brightWhite: "#ffffff",
  },
  syntax: {
    keyword: "#ff7b72", string: "#a5d6ff", number: "#79c0ff", comment: "#8b949e",
    function: "#d2a8ff", type: "#ffa657", property: "#79c0ff", heading: "#79c0ff", punct: "#c9d1d9",
  },
};

export const githubLight: Theme = {
  id: "github-light",
  title: "GitHub Light",
  appearance: "light",
  colors: {
    bg: "#f6f8fa", bgSidebar: "#f6f8fa", bgElevated: "#ffffff", well: "#ffffff",
    text: "#1f2328", textDim: "#656d76", icon: "#57606a",
    accent: "#0969da", link: "#0969da", match: "#d4a72c", ink: "#1f2328", scrim: "#1f2328",
    stateNeeds: "#bf8700", stateDone: "#1a7f37", stateWorking: "#0969da", stateIdle: "#8c959f",
  },
  terminal: {
    foreground: "#1f2328", cursor: "#0969da", selectionBackground: "#cee1f8",
    black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#4d2d00",
    blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
    brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01",
    brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
  },
  syntax: {
    keyword: "#cf222e", string: "#0a3069", number: "#0550ae", comment: "#6e7781",
    function: "#8250df", type: "#953800", property: "#0550ae", heading: "#0550ae", punct: "#424a53",
  },
};
