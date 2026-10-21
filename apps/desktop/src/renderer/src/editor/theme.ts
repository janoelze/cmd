// The editor's look shared by every CodeMirror in the app (text windows, Live
// Code): chrome from the app's design tokens, and the smallest edit that turns
// one text into another, for merging outside changes without moving the cursor.

import { EditorView } from "@codemirror/view";

/** Editor chrome from the app's design tokens. */
export const appTheme = (fontFamily: string, fontSize: number, dark: boolean) =>
  EditorView.theme(
    {
      "&": { height: "100%", color: "var(--text)", backgroundColor: "var(--well)", fontSize: `${fontSize}px` },
      // No rubber band at the ends (a bounce drags the sticky gutter along). Sideways the scroller
      // chains as usual: a swipe it can't use, short lines or at an edge, scrolls the strip.
      ".cm-scroller": { fontFamily, lineHeight: "1.5", overscrollBehaviorY: "none" },
      ".cm-content": { caretColor: "var(--syn-cursor)", padding: "8px 0 32px" },
      ".cm-line": { padding: "0 12px 0 10px" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--syn-cursor)", borderLeftWidth: "2px" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "var(--syn-selection) !important",
      },
      // The gutter is opaque, so text scrolled sideways passes under it, not through it.
      ".cm-gutters": {
        backgroundColor: "var(--well)",
        color: "var(--text-faint)",
        border: "none",
        borderRight: "1px solid var(--separator)",
      },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 14px", fontVariantNumeric: "tabular-nums" },
      ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
      "&:not(.cm-focused) .cm-activeLine": { backgroundColor: "transparent" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
      "&:not(.cm-focused) .cm-activeLineGutter": { color: "inherit" },
      // Fold markers: quiet chevrons that show on hover over the gutter (and where a range is folded).
      ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", color: "var(--text-faint)", opacity: "0", transition: "opacity var(--dur-fast) var(--ease)" },
      ".cm-gutters:hover .cm-foldGutter .cm-gutterElement, .cm-foldGutter .cm-gutterElement.cm-folded": { opacity: "1" },
      ".cm-foldGutter .cm-gutterElement:hover": { color: "var(--text)" },
      ".cm-fold-marker": { display: "inline-block", width: "1em", textAlign: "center", cursor: "pointer" },
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
      ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--match) 14%, transparent)" },
      ".cm-tooltip": {
        backgroundColor: "var(--popover-bg)", color: "var(--text)", border: "1px solid var(--popover-edge)",
        borderRadius: "var(--radius-md)", boxShadow: "var(--popover-shadow)", overflow: "hidden",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily, maxHeight: "16em", padding: "var(--space-0-5)" },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "1px var(--space-1-5)", borderRadius: "var(--radius-sm)", lineHeight: "1.6" },
      ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--on-accent)" },
      ".cm-completionIcon": { opacity: "0.6" },
      ".cm-completionDetail": { color: "var(--text-dim)", fontStyle: "normal" },
      ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "600" },
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
