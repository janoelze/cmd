// Search query parsing, FTS5 expressions, identifier splitting and typo
// tolerance. Port of the fork's SearchQuery, identifierParts and Vocabulary.

/** Splits like the FTS tokenizer (unicode61, remove_diacritics): lowercase, folded, on non-alphanumerics. */
export function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const quoted = (t: string) => `"${t.replace(/"/g, '""')}"`;
/** Words under three letters match too much as a prefix ("am" → "amplitude"); they match whole words. */
const prefixed = (t: string) => (t.length >= 3 ? `${quoted(t)}*` : quoted(t));

/**
 * A word with its English ending off, for the prefix match: "timestamps" finds
 * "timestamp" (the prefix already finds the other way), "matches" "match",
 * "libraries" "library", "locked" "lock". Five letters or more, and at least four left.
 */
export function stem(t: string): string {
  if (t.length < 5) return t;
  const cut = (n: number) => (t.length - n >= 4 ? t.slice(0, -n) : t);
  if (t.endsWith("ies")) return cut(3);
  if (/(ss|us|is)$/.test(t)) return t;
  if (/(ches|shes|xes|zes|sses)$/.test(t)) return cut(2);
  if (t.endsWith("ing")) return cut(3);
  if (t.endsWith("ed")) return cut(2);
  if (t.endsWith("s")) return cut(1);
  return t;
}

/** Terms (prefix-matched, typo-tolerant), "quoted phrases" (exact), -excluded terms. All terms must match. */
export class SearchQuery {
  terms: string[] = [];
  phrases: string[] = [];
  excluded: string[] = [];

  constructor(text: string) {
    let rest = text;
    for (;;) {
      const open = rest.indexOf('"');
      if (open < 0) break;
      const close = rest.indexOf('"', open + 1);
      if (close < 0) break;
      const w = words(rest.slice(open + 1, close));
      if (w.length) this.phrases.push(w.join(" "));
      rest = rest.slice(0, open) + " " + rest.slice(close + 1);
    }
    for (const token of rest.split(/\s+/).filter(Boolean)) {
      if (token.startsWith("-") && token.length > 1) this.excluded.push(...words(token.slice(1)));
      else this.terms.push(...words(token));
    }
  }

  get isEmpty(): boolean {
    return this.terms.length === 0 && this.phrases.length === 0;
  }

  /** FTS5 expression; with expansions each term also accepts its typo-tolerant variants. */
  expression(expansions?: string[][]): string {
    const parts = this.terms.map((t, i) => {
      const v = expansions?.[i] ?? [];
      return v.length ? `(${[prefixed(stem(t)), ...v.map(quoted)].join(" OR ")})` : prefixed(stem(t));
    });
    parts.push(...this.phrases.map(quoted));
    if (!parts.length) return "";
    let e = parts.join(" AND ");
    for (const t of this.excluded) e += ` NOT ${prefixed(t)}`;
    return e;
  }

  /** Any term matching, for picking the passage to show. */
  anyTermExpression(expansions: string[][]): string {
    const parts = this.phrases.map(quoted);
    this.terms.forEach((t, i) => parts.push(prefixed(stem(t)), ...(expansions[i] ?? []).map(quoted)));
    return parts.join(" OR ");
  }
}

/** Parts of compound identifiers, so `monitor` finds AgentMonitor, agent_monitor, src/monitor/x.ts. */
export function identifierParts(texts: string[]): string {
  const parts = new Set<string>();
  const isAlnum = (c: string) => /[\p{L}\p{N}]/u.test(c);
  for (const text of texts) {
    for (const token of text.split(/[^\p{L}\p{N}_\-./]+/u)) {
      if (token.length < 4) continue;
      const pieces: string[] = [];
      let piece = "";
      let prev = "";
      for (const ch of token) {
        const boundary = !isAlnum(ch);
        const camel = ch !== ch.toLowerCase() && prev !== "" && prev === prev.toLowerCase() && prev !== prev.toUpperCase();
        if (boundary || camel) {
          if (piece) pieces.push(piece);
          piece = boundary ? "" : ch;
        } else piece += ch;
        prev = ch;
      }
      if (piece) pieces.push(piece);
      if (pieces.length < 2) continue;
      for (const p of pieces) if (p.length >= 3) parts.add(p.toLowerCase());
    }
  }
  return [...parts].join(" ");
}

/** Optimal string alignment distance (Levenshtein + adjacent swaps), giving up past `limit`. */
export function osaDistance(a: string, b: string, limit: number): number {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > limit) return limit + 1;
  if (!n || !m) return Math.max(n, m);
  let p2 = new Array<number>(m + 1).fill(0);
  let p1 = Array.from({ length: m + 1 }, (_, j) => j);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(p1[j]! + 1, cur[j - 1]! + 1, p1[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, p2[j - 2]! + 1);
      cur[j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > limit) return limit + 1;
    [p2, p1, cur] = [p1, cur, p2];
  }
  return p1[m]!;
}

/** The index vocabulary, for finding words within a small edit distance of a query term. */
export class Vocabulary {
  #byLength = new Map<number, { term: string; docs: number }[]>();
  #maxLength = 0;
  /** A prefix found in at least this many sessions is taken as intended. */
  static TYPO_THRESHOLD = 3;

  constructor(entries: { term: string; doc: number }[]) {
    for (const { term, doc } of entries) {
      if (term.length < 3 || term.length > 40) continue;
      const list = this.#byLength.get(term.length) ?? [];
      list.push({ term, docs: doc });
      this.#byLength.set(term.length, list);
      this.#maxLength = Math.max(this.#maxLength, term.length);
    }
  }

  /**
   * Words that are probably what was meant: within one edit (two for long words), or —
   * while still typing — whose beginning is one edit away. Words already starting with
   * the term are left out; the prefix match covers them.
   */
  expansions(term: string): string[] {
    if (term.length < 4) return [];
    const maxD = term.length >= 8 ? 2 : 1;
    // Only guess at typos when what was typed is rare as a prefix.
    let prefixDocs = 0;
    for (let len = term.length; len <= this.#maxLength; len++) {
      for (const e of this.#byLength.get(len) ?? []) if (e.term.startsWith(term)) prefixDocs += e.docs;
      if (prefixDocs >= Vocabulary.TYPO_THRESHOLD) return [];
    }
    const found: { term: string; d: number; docs: number }[] = [];
    for (let len = Math.max(3, term.length - maxD); len <= Math.min(this.#maxLength, term.length + maxD); len++) {
      for (const e of this.#byLength.get(len) ?? []) {
        if (e.term.startsWith(term)) continue;
        const d = osaDistance(term, e.term, maxD);
        if (d <= maxD) found.push({ term: e.term, d, docs: e.docs });
      }
    }
    // As-you-type: "sidba" should still find "sidebar". Compare with the word's
    // prefixes one shorter, as long and one longer than what was typed, so a missing
    // letter ("sidba" vs "sideba") counts as one edit. (The fork compared only the
    // same-length prefix, which misses exactly this case.)
    for (let len = term.length + 1; len <= this.#maxLength; len++) {
      for (const e of this.#byLength.get(len) ?? []) {
        if (e.term.startsWith(term)) continue;
        let d = 2;
        for (let k = term.length - 1; k <= term.length + 1 && k <= e.term.length; k++) {
          d = Math.min(d, osaDistance(term, e.term.slice(0, k), 1));
        }
        if (d <= 1) found.push({ term: e.term, d: d + 1, docs: e.docs });
      }
    }
    const seen = new Set<string>();
    return found
      .sort((a, b) => a.d - b.d || b.docs - a.docs)
      .filter((f) => !seen.has(f.term) && seen.add(f.term))
      .slice(0, 12)
      .map((f) => f.term);
  }
}
