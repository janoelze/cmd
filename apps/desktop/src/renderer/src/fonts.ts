// The font settings as CSS tokens on :root, so every window type's styles can use
// them: --font-code / --font-code-size (terminals, editor, code in
// Markdown) and --font-text / --font-text-size (Markdown prose). xterm.js and
// CodeMirror take the same values directly (terminals.ts, TextView.tsx).

import type { Settings } from "@cmd/protocol";

/** A user font list with the app's own font as the last fallback. */
const family = (list: string, fallback: string) => (list.trim() ? `${list}, ${fallback}` : fallback);

export function applyFonts(s: Settings): void {
  const root = document.documentElement.style;
  root.setProperty("--font-code", family(s["font.code"], "var(--font-mono)"));
  root.setProperty("--font-code-size", `${s["font.codeSize"]}px`);
  root.setProperty("--font-text", family(s["font.text"], "var(--font-ui)"));
  root.setProperty("--font-text-size", `${s["font.textSize"]}px`);
}
