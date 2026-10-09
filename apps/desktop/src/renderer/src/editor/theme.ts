// The editor's look shared by every CodeMirror in the app (text windows, Live
// Code): chrome from the app's design tokens, and the smallest edit that turns
// one text into another, for merging outside changes without moving the cursor.

import { EditorView } from "@codemirror/view";

/** Editor chrome from the app's design tokens. */
export const appTheme = (fontFamily: string, fontSize: number, dark: boolean) =>
  EditorView.theme(
    {
      "&": { height: "100%", color: "var(--text)", backgroundColor: "var(--well)", fontSize: `${fontSize}px` },
      ".cm-scroller": { fontFamily, lineHeight: "1.5" },
      ".cm-content": { caretColor: "var(--syn-cursor)", padding: "8px 0" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--syn-cursor)", borderLeftWidth: "2px" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "var(--syn-selection) !important",
      },
      ".cm-gutters": {
        backgroundColor: "var(--well)",
        color: "var(--text-dim)",
        border: "none",
        borderRight: "1px solid var(--separator)",
      },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px", opacity: "0.6" },
      ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
      ".cm-foldPlaceholder": { backgroundColor: "var(--bg-selected)", border: "none", color: "var(--text-dim)" },
      ".cm-matchingBracket": { backgroundColor: "var(--bg-selected)", outline: "1px solid var(--separator)" },
      ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--match) 18%, transparent)" },
      ".cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--match) 35%, transparent)" },
      ".cm-panels": { backgroundColor: "var(--bg)", color: "var(--text)" },
      ".cm-panels-bottom": { borderTop: "1px solid var(--separator)" },
      ".cm-panel input, .cm-panel button": { font: "12px var(--font-ui)" },
      // Find/replace fields and buttons in the app's input style (styles.css --input-*).
      ".cm-textfield": {
        color: "var(--text)", backgroundColor: "var(--well)", border: "none", borderRadius: "5px",
        padding: "2px 7px", boxShadow: "inset 0 0 0 1px var(--input-edge)", outline: "none",
      },
      ".cm-textfield:focus": { boxShadow: "var(--input-ring)" },
      ".cm-button": {
        color: "var(--text)", backgroundImage: "none", backgroundColor: "var(--input-bg)", border: "none",
        borderRadius: "5px", padding: "2px 8px", boxShadow: "inset 0 0 0 1px var(--input-edge)",
      },
      ".cm-button:active": { backgroundImage: "none", backgroundColor: "var(--bg-selected)" },
      ".cm-button:focus-visible": { outline: "none", boxShadow: "var(--input-ring)" },
      ".cm-panel input[type=checkbox]": { accentColor: "var(--accent)" },
      ".cm-tooltip": { backgroundColor: "var(--bg-elevated)", border: "1px solid var(--separator)" },
      "&.cm-focused": { outline: "none" },
    },
    { dark },
  );

/** The smallest single change turning `a` into `b` (keeps cursor and scroll stable). */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) endA--, endB--;
  return { from: start, to: endA, insert: b.slice(start, endB) };
}
