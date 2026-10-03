// The light counterpart of the default theme: macOS light system colours.

import type { Theme } from "./types.ts";

export const light: Theme = {
  id: "light",
  title: "Light",
  appearance: "light",
  colors: {
    bg: "#f3f3f5",
    bgSidebar: "#ebebee",
    bgElevated: "#ffffff",
    well: "#ffffff",
    text: "#1d1d1f",
    textDim: "#6e6e73",
    icon: "#48484d",
    accent: "#007aff",
    link: "#0066cc",
    match: "#ffcc00",
    ink: "#000000",
    scrim: "#000000",
    stateNeeds: "#f08c00",
    stateDone: "#28a745",
    stateWorking: "#007aff",
    stateIdle: "#a1a1a6",
  },
  terminal: {
    foreground: "#1d1d1f",
    cursor: "#5b5bd6",
    selectionBackground: "#cfd8ff",
    black: "#1d1d1f", red: "#d1242f", green: "#1a7f37", yellow: "#9a6700",
    blue: "#3b5bdb", magenta: "#a626a4", cyan: "#0b7d86", white: "#c7c7cc",
    brightBlack: "#8a8a93", brightRed: "#e5534b", brightGreen: "#2da44e", brightYellow: "#bf8700",
    brightBlue: "#5c7cfa", brightMagenta: "#bf5af2", brightCyan: "#1b9aa3", brightWhite: "#f2f2f7",
  },
};
