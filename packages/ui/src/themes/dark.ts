// The default theme: solid dark, macOS system style.

import type { Theme } from "./types.ts";

export const dark: Theme = {
  id: "dark",
  title: "Dark",
  appearance: "dark",
  colors: {
    bg: "#1e1e1e",
    bgSidebar: "#252527",
    bgElevated: "#2a2a2c",
    well: "#161618",
    text: "#ececec",
    textDim: "#8e8e93",
    // Brighter than secondary text: thin grey strokes on dark read as blurry.
    icon: "#b4b4b9",
    accent: "#0a84ff",
    link: "#5ea8ff",
    match: "#ffd60a",
    ink: "#ffffff",
    scrim: "#000000",
    stateNeeds: "#ff9f0a",
    stateDone: "#30d158",
    stateWorking: "#0a84ff",
    stateIdle: "#636366",
  },
  terminal: {
    foreground: "#e6e6ea",
    cursor: "#9d9dff",
    selectionBackground: "#3a3a6e",
    black: "#16161c", red: "#ff6b5e", green: "#7bd88f", yellow: "#ffd866",
    blue: "#8f8fff", magenta: "#e08cff", cyan: "#6fe0e8", white: "#d6d6dc",
    brightBlack: "#6c6c78", brightRed: "#ff8a7f", brightGreen: "#9be6aa", brightYellow: "#ffe38f",
    brightBlue: "#b0b0ff", brightMagenta: "#eeb0ff", brightCyan: "#9aeef3", brightWhite: "#ffffff",
  },
  syntax: { punct: "#9a9aa6" },
};
