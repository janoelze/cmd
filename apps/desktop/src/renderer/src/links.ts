// Finds URLs and file paths in a line of terminal text, for ⌘-click links.
// Pure: paths are only candidates here; the terminal checks which exist (fs.resolve).

export interface LinkMatch {
  kind: "url" | "path";
  /** Index range in the text, end exclusive. */
  start: number;
  end: number;
  /** URL, or the path without a :line:col / (line,col) suffix. */
  target: string;
}

const URL_RE = /\b(?:https?|file):\/\/[^\s"'`<>]+/g;
// Runs of path characters, from a delimiter (start, space, quote, bracket, =) on.
const PATH_RE = /(?<=^|[\s"'`(\[{<=:])(?:~|\.{1,2})?[\w.@%+,\-~/]*[\w/][\w.@%+,\-~/]*/g;
const TRAILING = /[.,;:!?'"`)\]}>]+$/;
const POSITION = /(?::\d+(?::\d+)?|\(\d+(?:,\d+)?\))$/;

/** Drop trailing punctuation, keeping a closing paren that has its opening one (wiki URLs). */
function trim(s: string): string {
  let t = s.replace(TRAILING, "");
  while (t.length < s.length && s[t.length] === ")" && count(t, "(") > count(t, ")")) t += ")";
  return t;
}
const count = (s: string, c: string) => s.split(c).length - 1;

/** A token worth checking on disk: has a slash, starts with ~ or ., or looks like name.ext. */
function pathLike(s: string): boolean {
  if (s.includes("//")) return false;
  if (/^(~|\.{1,2})(\/|$)/.test(s) || s.startsWith("/")) return s.length > 1;
  if (s.includes("/")) return /[\w]/.test(s) && !/^\d+(\/\d+)+$/.test(s); // not a date or fraction
  return /^[\w@+\-.]*\w\.[A-Za-z][\w]{0,9}$/.test(s) && !/^\d+(\.\d+)+$/.test(s); // name.ext, not 1.2.3
}

export function findLinks(text: string): LinkMatch[] {
  const out: LinkMatch[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = trim(m[0]);
    if (url.length > m[0].indexOf("//") + 2) {
      const file = url.startsWith("file://");
      out.push({ kind: file ? "path" : "url", start: m.index, end: m.index + url.length, target: file ? decodeURIComponent(url.slice(7)) : url });
    }
  }
  const taken = (i: number) => out.some((l) => i >= l.start && i < l.end);
  for (const m of text.matchAll(PATH_RE)) {
    if (taken(m.index)) continue;
    // Include a :12:5 or (12,5) right after it, then trim punctuation.
    const rest = text.slice(m.index + m[0].length).match(/^(?::\d+(?::\d+)?|\(\d+(?:,\d+)?\))/)?.[0] ?? "";
    const raw = trim(m[0] + rest);
    const target = raw.replace(POSITION, "").replace(TRAILING, "");
    if (!pathLike(target)) continue;
    out.push({ kind: "path", start: m.index, end: m.index + raw.length, target });
  }
  return out.sort((a, b) => a.start - b.start);
}
