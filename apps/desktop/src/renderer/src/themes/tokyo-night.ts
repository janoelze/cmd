// Tokyo Night (enkia, folke's palette): Night and Storm (dark), Day (light).
// Terminal colours from folke/tokyonight.nvim's terminal extras.

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

export const tokyoNightStorm: Theme = {
  id: "tokyo-night-storm",
  title: "Tokyo Night Storm",
  appearance: "dark",
  colors: {
    bg: "#1b1e2d", bgSidebar: "#1f2335", bgElevated: "#292e42", well: "#24283b",
    text: "#c0caf5", textDim: "#737aa2", icon: "#a9b1d6",
    accent: "#7aa2f7", link: "#7dcfff", match: "#e0af68", ink: "#c0caf5", scrim: "#000000",
    stateNeeds: "#ff9e64", stateDone: "#9ece6a", stateWorking: "#7aa2f7", stateIdle: "#565f89",
  },
  terminal: {
    foreground: "#c0caf5", cursor: "#c0caf5", selectionBackground: "#2e3c64",
    black: "#1d202f", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
    blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
    brightBlack: "#414868", brightRed: "#ff899d", brightGreen: "#9fe044", brightYellow: "#faba4a",
    brightBlue: "#8db0ff", brightMagenta: "#c7a9ff", brightCyan: "#a4daff", brightWhite: "#c0caf5",
  },
  syntax: {
    keyword: "#bb9af7", string: "#9ece6a", number: "#ff9e64", comment: "#565f89",
    function: "#7aa2f7", type: "#2ac3de", property: "#73daca", heading: "#7aa2f7", punct: "#89ddff",
  },
  vars: { "on-accent": "#1f2335" },
};

export const tokyoNightDay: Theme = {
  id: "tokyo-night-day",
  title: "Tokyo Night Day",
  appearance: "light",
  colors: {
    bg: "#d0d5e3", bgSidebar: "#d0d5e3", bgElevated: "#e9e9ed", well: "#e1e2e7",
    text: "#3760bf", textDim: "#68709a", icon: "#6172b0",
    accent: "#2e7de9", link: "#007197", match: "#e0af68", ink: "#3760bf", scrim: "#3760bf",
    stateNeeds: "#b15c00", stateDone: "#587539", stateWorking: "#2e7de9", stateIdle: "#848cb5",
  },
  terminal: {
    foreground: "#3760bf", cursor: "#3760bf", selectionBackground: "#b7c1e3",
    black: "#b4b5b9", red: "#f52a65", green: "#587539", yellow: "#8c6c3e",
    blue: "#2e7de9", magenta: "#9854f1", cyan: "#007197", white: "#6172b0",
    brightBlack: "#a1a6c5", brightRed: "#ff4774", brightGreen: "#5c8524", brightYellow: "#a27629",
    brightBlue: "#358aff", brightMagenta: "#a463ff", brightCyan: "#007ea8", brightWhite: "#3760bf",
  },
  syntax: {
    keyword: "#9854f1", string: "#587539", number: "#b15c00", comment: "#848cb5",
    function: "#2e7de9", type: "#188092", property: "#387068", heading: "#2e7de9", punct: "#006a83",
  },
};
