// What goes into a terminal from outside the keyboard: pasted text (checked
// before it goes in) and dropped files (typed as shell words). Pure, for tests.

/** A path as one shell word (dropped files): plain if safe, else single-quoted. */
export const shellWord = (p: string): string => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);

/**
 * Why pasting this could do something unintended, or null. Without bracketed
 * paste every newline runs what's before it; text that contains the
 * end-of-paste sequence could break out of a bracketed one.
 */
export function pasteRisk(text: string, bracketed: boolean): string | null {
  if (text.includes("\x1b[201~")) return "It contains a sequence that ends a paste early, so the rest would run as typed.";
  if (bracketed) return null;
  const lines = text.split(/\r\n|\r|\n/).filter((l, i, a) => l || i < a.length - 1).length;
  if (/[\r\n]/.test(text)) return `It has ${lines > 1 ? `${lines} lines` : "a line break"}, and the program in this terminal runs each line as soon as it arrives.`;
  return null;
}

/** The start of what's being pasted, for the confirmation. */
export function preview(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const shown = lines.slice(0, 6).map((l) => (l.length > 100 ? l.slice(0, 100) + "…" : l));
  return shown.join("\n") + (lines.length > 6 ? `\n… ${lines.length - 6} more lines` : "");
}
