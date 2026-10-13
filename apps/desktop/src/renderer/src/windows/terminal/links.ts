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

/** A terminal row: its text, each character's cell (1-based, as xterm's), and whether it continues the row above (soft wrap). */
export interface Row {
  text: string;
  cells: { x: number; y: number }[];
  wrapped: boolean;
}

// Programs that draw their own screen (Claude Code, other TUIs) wrap a long URL
// or path with real line breaks, so the terminal sees separate rows. A row
// continues a URL from the row above when that row ends inside a URL at the
// right edge (or a few columns short after a /, - or ?, where wrappers like to
// break), and it starts, after a little indent, with URL characters (not a new
// URL). Paths are joined more freely (`paths`), since the disk check decides
// between the joined path and the rows' own (lineLinks).
const OPEN_URL = /\b(?:https?|file):\/\/\S*$/;
const CONTINUES = /^ {0,8}(?=[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%])/;
const BREAK_AFTER = /[/\-?&=#_~+]$/;
const OPEN_PATH = /[\w.@%+,\-~/]$/;
const CONTINUES_PATH = /^ {0,10}(?=[\w.@%+,\-~/])/;
const PATH_GAP = 12; // columns a wrapper may leave free at the right

function continues(line: Row, next: Row, cols: number, paths: boolean): number | null {
  const text = line.text.trimEnd();
  if (!text || next.wrapped) return null;
  const gap = cols - line.cells[text.length - 1]!.x;
  if (OPEN_URL.test(text)) {
    if (gap > 1 && !(gap <= 12 && BREAK_AFTER.test(text))) return null;
    const indent = next.text.match(CONTINUES)?.[0].length;
    return indent === undefined || /^[a-z]+:\/\//i.test(next.text.slice(indent)) ? null : indent; // not a URL of its own
  }
  if (!paths || gap > PATH_GAP || !OPEN_PATH.test(text)) return null;
  return next.text.match(CONTINUES_PATH)?.[0].length ?? null;
}

/**
 * The logical line holding row `at` (an index into rows): soft-wrapped rows
 * joined, and URLs a program wrapped itself (with `paths`, any row ending in
 * path characters near the edge and the next row's leading ones too).
 */
export function logicalLine(rows: Row[], at: number, cols: number, paths = false): Row {
  let line: Row | null = null;
  for (const [i, row] of rows.entries()) {
    const indent: number | null = line && i > 0 ? (row.wrapped ? 0 : continues(line, row, cols, paths)) : null;
    if (line && indent !== null) {
      const keep = row.wrapped ? line.text.length : line.text.trimEnd().length;
      line = { text: line.text.slice(0, keep) + row.text.slice(indent), cells: [...line.cells.slice(0, keep), ...row.cells.slice(indent)], wrapped: line.wrapped };
    } else {
      if (i > at) break;
      line = { ...row, cells: [...row.cells] };
    }
  }
  return line ?? { text: "", cells: [], wrapped: false };
}

type Cell = { x: number; y: number };
/** A link found in the rows, by the cells it covers (first and last, inclusive). */
export interface CellLink {
  kind: "url" | "path";
  target: string;
  text: string;
  start: Cell;
  end: Cell;
}

/**
 * The links in the logical line holding row `at`. URLs come out final; paths
 * are candidates for the disk check, those that only reading across
 * program-wrapped rows finds first, then the rows' own: pickPaths keeps the first that exists of
 * each overlapping set.
 */
export function lineLinks(rows: Row[], at: number, cols: number, maxChars = Infinity): { urls: CellLink[]; paths: CellLink[] } {
  const read = (line: Row) => {
    const text = line.text.slice(0, maxChars);
    return findLinks(text.trimEnd()).map((m) => ({ kind: m.kind, target: m.target, text: text.slice(m.start, m.end), start: line.cells[m.start]!, end: line.cells[m.end - 1]! }));
  };
  const own = read(logicalLine(rows, at, cols));
  const joined = read(logicalLine(rows, at, cols, true)).filter((l) => l.kind === "path" && l.start.y !== l.end.y);
  const key = (l: CellLink) => `${l.target}\0${l.start.x},${l.start.y}`;
  const seen = new Set(own.map(key));
  return {
    urls: own.filter((l) => l.kind === "url"),
    paths: [...joined.filter((l) => !seen.has(key(l))), ...own.filter((l) => l.kind === "path")],
  };
}

const pos = (c: Cell) => c.y * 1e5 + c.x;
const overlaps = (a: CellLink, b: CellLink) => pos(a.start) <= pos(b.end) && pos(b.start) <= pos(a.end);

/** The candidates that exist (`exists[i]` for `paths[i]`), earlier ones winning where they overlap. */
export function pickPaths<T>(paths: CellLink[], exists: (T | null)[]): { link: CellLink; abs: T }[] {
  const out: { link: CellLink; abs: T }[] = [];
  paths.forEach((link, i) => {
    const abs = exists[i];
    if (abs != null && !out.some((o) => overlaps(o.link, link))) out.push({ link, abs });
  });
  return out;
}
