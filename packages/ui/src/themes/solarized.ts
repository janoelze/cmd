// Solarized (Ethan Schoonover), from the official table and usage rules
// (github.com/altercation/solarized): only the 16 Solarized colours. Dark:
// base03 background, base02 highlights, base0 body, base01 secondary, base1
// emphasis; light swaps the base tones (base3, base2, base00, base1, base01).
// The terminal uses the official 16-colour mapping, where most brights are the
// base tones, not brighter accents. base02 is only for small highlights; large
// chrome (sidebar, bars, the pane behind windows) uses the darker base03 shade
// from VS Code's built-in Solarized Dark, so the teal doesn't take over.

import type { TerminalColors, Theme } from "./types.ts";

const base03 = "#002b36", base02 = "#073642", base01 = "#586e75", base00 = "#657b83";
const base0 = "#839496", base1 = "#93a1a1", base2 = "#eee8d5", base3 = "#fdf6e3";
const yellow = "#b58900", orange = "#cb4b16", red = "#dc322f", magenta = "#d33682";
const violet = "#6c71c4", blue = "#268bd2", cyan = "#2aa198", green = "#859900";
/** VS Code Solarized Dark's sidebar: base03, darker. */
const chromeDark = "#00212b";

/** ANSI 0–15, the same in dark and light. */
const ansi: Omit<TerminalColors, "foreground" | "cursor" | "selectionBackground"> = {
  black: base02, red, green, yellow, blue, magenta, cyan, white: base2,
  brightBlack: base03, brightRed: orange, brightGreen: base01, brightYellow: base00,
  brightBlue: base0, brightMagenta: violet, brightCyan: base1, brightWhite: base3,
};
const accents = { accent: blue, link: blue, match: yellow };
const states = { stateNeeds: orange, stateDone: green, stateWorking: blue };
// Solarized's own syntax groups: Statement green, Constant cyan, Identifier
// blue, Type yellow, PreProc orange.
const syntax = { keyword: green, string: cyan, number: cyan, function: blue, type: yellow, heading: orange };

export const solarizedDark: Theme = {
  id: "solarized-dark",
  title: "Solarized Dark",
  appearance: "dark",
  colors: {
    bg: chromeDark, bgSidebar: chromeDark, bgElevated: base02, well: base03,
    text: base1, textDim: base0, icon: base0,
    ...accents, ink: base1, scrim: "#000000",
    ...states, stateIdle: base01,
  },
  terminal: { foreground: base0, cursor: base1, selectionBackground: base02, ...ansi },
  syntax: { ...syntax, comment: base01, property: base0, punct: base00, cursor: base1, selection: base02 },
};

export const solarizedLight: Theme = {
  id: "solarized-light",
  title: "Solarized Light",
  appearance: "light",
  colors: {
    bg: base2, bgSidebar: base2, bgElevated: base3, well: base3,
    text: base01, textDim: base00, icon: base00,
    ...accents, ink: base01, scrim: base03,
    ...states, stateIdle: base1,
  },
  terminal: { foreground: base00, cursor: base01, selectionBackground: base2, ...ansi },
  syntax: { ...syntax, comment: base1, property: base00, punct: base0, cursor: base01, selection: base2 },
};
