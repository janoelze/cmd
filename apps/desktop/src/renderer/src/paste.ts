// What comes in from outside the keyboard: pasted text (checked before it goes
// into a terminal), dropped files (typed as shell words) and dropped links
// (text/uri-list, drops.ts). Pure, for tests.

/**
 * A path as one shell word (dropped files), escaped with backslashes like
 * Terminal.app, iTerm and Ghostty do: agents (Claude Code, Codex) recognise
 * those as dropped files, images become attachments. A name with a control
 * character (a newline) is single-quoted instead, as a backslash would join lines.
 */
export function shellWord(p: string): string {
  if (/[\x00-\x1f\x7f]/.test(p)) return `'${p.replace(/'/g, "'\\''")}'`;
  return p.replace(/[\s\\'"`()[\]{}<>!#$&;|*?~^]/g, "\\$&");
}

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

/** URLs from text/uri-list (one per line, # comments); file: URLs become paths. */
export function parseUriList(list: string): { files: string[]; urls: string[] } {
  const files: string[] = [];
  const urls: string[] = [];
  for (const line of list.split(/\r?\n/)) {
    const u = line.trim();
    if (!u || u.startsWith("#")) continue;
    if (/^file:/i.test(u)) {
      try {
        files.push(decodeURIComponent(new URL(u).pathname));
      } catch {}
    } else urls.push(u);
  }
  return { files, urls };
}
