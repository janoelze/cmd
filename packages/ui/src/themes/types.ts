// What a theme is: plain data. One definition drives the CSS tokens (styles.css),
// xterm.js, CodeMirror and the native window (appearance, background), so a
// theme can't be half applied. Built-ins register in ./builtin.ts; user and
// plugin themes will register the same way (registry.ts).

/** Terminal colours, as xterm.js takes them. */
export interface TerminalColors {
  /** Defaults to the theme's `well`, so terminals sit flush in their windows. */
  background?: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** Editor and Markdown syntax colours (--syn-*). Unset ones come from the terminal palette. */
export interface SyntaxColors {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
  type: string;
  property: string;
  heading: string;
  punct: string;
  cursor: string;
  selection: string;
}

/** The tokens every theme sets; each becomes --<kebab-case name> on :root. */
export interface ThemeColors {
  /** Main pane and toolbars. */
  bg: string;
  bgSidebar: string;
  /** Palette, popovers. */
  bgElevated: string;
  /** Window content: terminals, editors, lists. */
  well: string;
  text: string;
  textDim: string;
  icon: string;
  accent: string;
  link: string;
  /** Search matches (used translucent). */
  match: string;
  /** Hover, selection, separators, outlines are this at low opacity: white on dark, black on light. */
  ink: string;
  /** Dimming overlays and recessed areas: usually black. */
  scrim: string;
  stateNeeds: string;
  stateDone: string;
  stateWorking: string;
  stateIdle: string;
}

export interface Theme {
  id: string;
  title: string;
  appearance: "dark" | "light";
  colors: ThemeColors;
  terminal: TerminalColors;
  syntax?: Partial<SyntaxColors>;
  /**
   * Any other token in styles.css, by name without the leading dashes, e.g.
   * { "window-dim": "0.5", "on-accent": "#000" }: overrides what styles.css
   * derives (and, for light themes, the light defaults in registry.ts).
   */
  vars?: Readonly<Record<string, string>>;
}
