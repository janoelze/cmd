// Catppuccin: soothing pastels. Mocha (darkest flavour) and Latte (light), with
// mauve as the accent, as in the official ports.

import type { Theme } from "./types.ts";

export const catppuccinMocha: Theme = {
  id: "catppuccin-mocha",
  title: "Catppuccin Mocha",
  appearance: "dark",
  colors: {
    bg: "#11111b", bgSidebar: "#181825", bgElevated: "#313244", well: "#1e1e2e",
    text: "#cdd6f4", textDim: "#9399b2", icon: "#bac2de",
    accent: "#cba6f7", link: "#89b4fa", match: "#f9e2af", ink: "#cdd6f4", scrim: "#000000",
    stateNeeds: "#fab387", stateDone: "#a6e3a1", stateWorking: "#89b4fa", stateIdle: "#6c7086",
  },
  terminal: {
    foreground: "#cdd6f4", cursor: "#f5e0dc", selectionBackground: "#45475a",
    black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
    blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
    brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1", brightYellow: "#f9e2af",
    brightBlue: "#89b4fa", brightMagenta: "#f5c2e7", brightCyan: "#94e2d5", brightWhite: "#a6adc8",
  },
  syntax: {
    keyword: "#cba6f7", string: "#a6e3a1", number: "#fab387", comment: "#9399b2",
    function: "#89b4fa", type: "#f9e2af", property: "#b4befe", heading: "#f38ba8", punct: "#9399b2",
  },
  vars: { "on-accent": "#1e1e2e" },
};

export const catppuccinLatte: Theme = {
  id: "catppuccin-latte",
  title: "Catppuccin Latte",
  appearance: "light",
  colors: {
    bg: "#e6e9ef", bgSidebar: "#dce0e8", bgElevated: "#eff1f5", well: "#eff1f5",
    text: "#4c4f69", textDim: "#6c6f85", icon: "#5c5f77",
    accent: "#8839ef", link: "#1e66f5", match: "#df8e1d", ink: "#4c4f69", scrim: "#4c4f69",
    stateNeeds: "#fe640b", stateDone: "#40a02b", stateWorking: "#1e66f5", stateIdle: "#9ca0b0",
  },
  terminal: {
    foreground: "#4c4f69", cursor: "#dc8a78", selectionBackground: "#ccd0da",
    black: "#5c5f77", red: "#d20f39", green: "#40a02b", yellow: "#df8e1d",
    blue: "#1e66f5", magenta: "#ea76cb", cyan: "#179299", white: "#acb0be",
    brightBlack: "#6c6f85", brightRed: "#d20f39", brightGreen: "#40a02b", brightYellow: "#df8e1d",
    brightBlue: "#1e66f5", brightMagenta: "#ea76cb", brightCyan: "#179299", brightWhite: "#bcc0cc",
  },
  syntax: {
    keyword: "#8839ef", string: "#40a02b", number: "#fe640b", comment: "#7c7f93",
    function: "#1e66f5", type: "#df8e1d", property: "#7287fd", heading: "#d20f39", punct: "#7c7f93",
  },
};
