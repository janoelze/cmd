// DevTools in cmd's theme (docs/59): the front end draws everything from its --sys-color-*
// tokens on :root (design_system_tokens.css; no component sets its own), so a stylesheet put
// into its page overrides them with the app's theme, read off the app's own :root (the
// theme's colours and the tokens mixed from them, tokens.css). Light or dark it decides
// itself, from the appearance cmd gives the app (main/appearance.ts).

/** The stylesheet for the theme the app shows now. */
export function devtoolsThemeCss(root: HTMLElement = document.documentElement): string {
  const cs = getComputedStyle(root);
  const v = (name: string) => cs.getPropertyValue(`--${name}`).trim();
  const mix = (c: string, pct: number, over = "transparent") => `color-mix(in srgb, ${c} ${pct}%, ${over})`;
  const [bg, well, elevated, text, dim, accent, ink] = ["bg", "well", "bg-elevated", "text", "text-dim", "accent", "ink"].map(v) as [string, string, string, string, string, string, string];
  const [blue, green, yellow, purple, cyan, red] = [1, 2, 3, 4, 5, 6].map((i) => v(`chart-${i}`)) as [string, string, string, string, string, string];
  const syn = (k: string) => v(`syn-${k}`) || text;
  const surface = (pct: number) => mix(ink, pct, well);
  const sys: Record<string, string> = {
    // Surfaces: panels are the window's well, bars the window's own background.
    "cdt-base-container": well,
    "cdt-base": bg,
    base: well,
    "base-container": bg,
    "base-container-elevated": elevated,
    surface: well,
    surface1: surface(2),
    surface2: surface(4),
    surface3: surface(6),
    surface4: bg,
    surface5: surface(10),
    "surface-variant": surface(8),
    "header-container": bg,
    "neutral-container": surface(6),
    "omnibox-container": surface(6),
    "inverse-surface": text,
    "inverse-on-surface": well,
    "inverse-primary": accent,
    // Text.
    "on-surface": text,
    "on-base": text,
    "on-surface-subtle": dim,
    "on-surface-secondary": dim,
    "on-surface-light": dim,
    "on-surface-light-graphics": dim,
    "on-surface-primary": text,
    // The accent: selection, focus, links, primary buttons.
    primary: accent,
    "primary-bright": accent,
    "on-primary": v("on-accent"),
    secondary: dim,
    "tonal-container": mix(accent, 28, well),
    "on-tonal-container": text,
    "tonal-outline": mix(accent, 50),
    "gradient-primary": mix(accent, 20, well),
    "gradient-tertiary": mix(accent, 10, well),
    "state-focus-ring": accent,
    "state-focus-select": mix(accent, 30),
    "state-text-highlight": accent,
    "state-on-text-highlight": v("on-accent"),
    "state-header-hover": mix(accent, 30, well),
    "state-on-header-hover": text,
    "state-hover-on-subtle": mix(ink, 6),
    "state-hover-on-prominent": mix(ink, 10),
    "state-ripple-neutral-on-subtle": mix(ink, 10),
    "state-ripple-neutral-on-prominent": mix(ink, 14),
    "state-ripple-primary": mix(accent, 24),
    "state-focus-highlight": mix(ink, 6),
    "state-disabled": mix(text, 38),
    "state-disabled-container": mix(ink, 12),
    // Lines.
    divider: mix(ink, 9),
    "on-base-divider": mix(ink, 9),
    "divider-on-tonal-container": mix(ink, 14),
    "divider-prominent": mix(ink, 16),
    outline: mix(ink, 24),
    "neutral-outline": mix(ink, 14),
    // Colours: the terminal's, as cmd's charts use them.
    blue,
    "blue-bright": blue,
    green,
    "green-bright": green,
    yellow,
    "yellow-bright": yellow,
    "yellow-outline": mix(yellow, 60),
    cyan,
    "cyan-bright": cyan,
    purple,
    "purple-bright": purple,
    pink: purple,
    "pink-bright": purple,
    orange: yellow,
    "orange-bright": yellow,
    error: red,
    "error-bright": red,
    "error-outline": mix(red, 50),
    "error-container": mix(red, 18, well),
    "on-error-container": text,
    "yellow-container": mix(yellow, 18, well),
    "on-yellow-container": text,
    "tertiary-container": mix(green, 18, well),
    "on-tertiary-container": text,
    // The console's warning and error rows.
    "surface-error": mix(red, 12, well),
    "on-surface-error": mix(red, 75, text),
    "surface-yellow": mix(yellow, 12, well),
    "surface-yellow-high": mix(yellow, 20, well),
    "on-surface-yellow": mix(yellow, 75, text),
    "surface-green": mix(green, 12, well),
    "on-surface-green": mix(green, 75, text),
    // Code: the editor's syntax colours.
    "token-keyword": syn("keyword"),
    "token-tag": syn("keyword"),
    "token-string": syn("string"),
    "token-string-special": syn("string"),
    "token-attribute-value": syn("string"),
    "token-number": syn("number"),
    "token-atom": syn("number"),
    "token-builtin": syn("number"),
    "token-comment": syn("comment"),
    "token-meta": syn("comment"),
    "token-subtle": dim,
    "token-type": syn("type"),
    "token-variable-special": syn("type"),
    "token-pseudo-element": syn("type"),
    "token-definition": syn("function"),
    "token-property": syn("property"),
    "token-property-special": syn("property"),
    "token-attribute": syn("property"),
    "token-variable": text,
    "token-deleted": red,
    "token-inserted": green,
  };
  const decls = Object.entries(sys)
    .filter(([, value]) => value)
    .map(([k, value]) => `--sys-color-${k}: ${value} !important;`);
  // Code in the app's monospace font.
  decls.push(`--monospace-font-family: ${v("font-mono")} !important;`, `--source-code-font-family: ${v("font-mono")} !important;`);
  return `:root { ${decls.join(" ")} }`;
}
