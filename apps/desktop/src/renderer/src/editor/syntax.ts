// Syntax colours shared by text windows (CodeMirror) and Markdown code blocks:
// the terminal palette, as CSS variables (--syn-* in styles.css) so themes can
// override them in one place.

import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** Syntax colours: the terminal palette, as CSS variables so themes can override. */
export const syntax = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--syn-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: "var(--syn-property)" },
  { tag: [t.heading, t.strong], color: "var(--syn-heading)", fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.link, t.url], color: "var(--syn-string)", textDecoration: "underline" },
  { tag: [t.meta, t.processingInstruction, t.punctuation, t.separator], color: "var(--syn-punct)" },
  { tag: t.invalid, color: "var(--state-needs)" },
]);

