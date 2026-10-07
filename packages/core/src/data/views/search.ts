// Session search over the event log (docs/28 §4, C3): the palette's ?query and
// the Navigator's search. Matches transcript events in the log's full-text
// index (text and body: prompts, answers, tool inputs, titles), ranks their
// sessions (best match, titles weigh more, recent sessions a little more),
// tolerates typos through the index's vocabulary, and answers with one hit
// per session from the sessions view. Replaces search.sqlite's Searcher.

import type { DataEvent, SearchHit } from "@cmd/protocol";
import { SearchQuery, Vocabulary, words } from "../../search/query.ts";
import { textOf } from "../sources/transcripts.ts";
import type { DataService } from "../service.ts";
import type { SessionRow, SessionsView } from "./sessions.ts";

const oneLine = (t: string) => (t.split(/\r?\n/)[0] ?? t).trim().slice(0, 200);

interface Candidate {
  key: string;
  seq: number;
  score: number;
}

export class SearchView {
  #data: DataService;
  #sessions: SessionsView;
  #vocab: Vocabulary | null = null;

  constructor(data: DataService, sessions: SessionsView) {
    this.#data = data;
    this.#sessions = sessions;
  }

  /** Call after the log grew so typo tolerance sees new words. */
  invalidate(): void {
    this.#vocab = null;
  }

  search(text: string, limit = 60, now = Date.now()): SearchHit[] {
    const q = new SearchQuery(text);
    if (q.isEmpty) return [];
    this.#vocab ??= new Vocabulary(this.#data.store.db.prepare(`SELECT term, doc FROM events_vocab`).all() as { term: string; doc: number }[]);
    const expansions = q.terms.map((t) => this.#vocab!.expansions(t));

    // Tier 1: every term as typed (prefix). Tier 2: typo-tolerant, only if tier 1 came up short.
    let ranked = this.#match(q.expression(), now);
    let fuzzy = new Set<string>();
    if (ranked.length < 40 && expansions.some((e) => e.length)) {
      const seen = new Set(ranked.map((c) => c.key));
      const more = this.#match(q.expression(expansions), now).filter((c) => !seen.has(c.key));
      fuzzy = new Set(more.map((c) => c.key));
      ranked = [...ranked, ...more];
    }
    // The index is contentless (the words are in the events and their blobs), so the passage is cut here.
    const terms = [...q.terms, ...expansions.flat(), ...q.phrases.flatMap((p) => p.split(" "))];
    const out: SearchHit[] = [];
    for (const c of ranked) {
      const row = this.#sessions.get(c.key);
      if (!row) continue;
      const e = this.#data.store.query({ sessionId: c.key, after: c.seq - 1, limit: 1 })[0];
      out.push({ ...toHit(row), snippet: e ? snippetOf(fullText(this.#data, e), terms) : null, fuzzy: fuzzy.has(c.key) });
      if (out.length === limit) break;
    }
    return out;
  }

  /** Sessions whose transcript events match, best first: one per session, the best event's seq for the snippet. */
  #match(expression: string, now: number): Candidate[] {
    if (!expression) return [];
    let rows: { session_id: string; seq: number; type: string; bm: number }[];
    try {
      rows = this.#data.store.db
        .prepare(
          `SELECT e.session_id, e.seq, e.type, bm25(events_fts, 3.0, 1.0) AS bm
           FROM events_fts JOIN events e ON e.seq = events_fts.rowid
           WHERE events_fts MATCH ? AND e.session_id IS NOT NULL AND e.type >= 'transcript.' AND e.type < 'transcript.￿'
           ORDER BY bm LIMIT 600`,
        )
        .all(expression) as { session_id: string; seq: number; type: string; bm: number }[];
    } catch {
      return []; // malformed expression
    }
    const by = new Map<string, Candidate & { hits: number }>();
    for (const r of rows) {
      const w = r.type === "transcript.title" ? 2 : 1;
      const score = -r.bm * w;
      const c = by.get(r.session_id);
      if (!c) by.set(r.session_id, { key: r.session_id, seq: r.seq, score, hits: 1 });
      else {
        c.hits++;
        if (score > c.score) (c.score = score), (c.seq = r.seq);
      }
    }
    const out: Candidate[] = [];
    for (const c of by.values()) {
      const row = this.#sessions.get(c.key);
      // Recent sessions get up to 60% more weight, fading over a few weeks; more matching events a little.
      const ageDays = row?.updated ? Math.max(0, now - row.updated) / 86_400_000 : 365;
      const recency = 1 + 0.6 * Math.exp(-ageDays / 21);
      out.push({ key: c.key, seq: c.seq, score: c.score * recency * (1 + Math.min(c.hits, 10) * 0.03) });
    }
    return out.sort((a, b) => b.score - a.score);
  }
}

/** The words of an event: its message's text when inline, else from the blob, else its line. */
function fullText(data: DataService, e: DataEvent): string {
  const d = e.data as Record<string, unknown>;
  const msg = d.message as Record<string, unknown> | undefined;
  if (msg?.content !== undefined) return textOf(msg.content) || (e.text ?? "");
  if (e.blob) {
    try {
      const line = JSON.parse(data.store.blob(e.blob)!.toString("utf8")) as Record<string, unknown>;
      const m = (line.message ?? line.payload) as Record<string, unknown> | undefined;
      const t = textOf(m?.content ?? m?.message);
      if (t) return t;
    } catch {}
  }
  return e.text ?? "";
}

/** A passage around the first matching word, the matches wrapped in \x01…\x02 (what the palette highlights). */
export function snippetOf(text: string, terms: string[], span = 18): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const tokens = flat.split(" ");
  const wanted = terms.filter(Boolean);
  const matches = (tok: string) => {
    const w = words(tok)[0] ?? "";
    return wanted.some((t) => (t.length >= 3 ? w.startsWith(t) : w === t));
  };
  let first = tokens.findIndex(matches);
  if (first < 0) return tokens.slice(0, span).join(" ") + (tokens.length > span ? "…" : "");
  const start = Math.max(0, first - Math.floor(span / 3));
  const end = Math.min(tokens.length, start + span);
  const part = tokens.slice(start, end).map((tok) => (matches(tok) ? `\x01${tok}\x02` : tok));
  return `${start > 0 ? "…" : ""}${part.join(" ")}${end < tokens.length ? "…" : ""}`;
}

function toHit(r: SessionRow): SearchHit {
  return {
    sessionId: r.id,
    agent: r.agent as SearchHit["agent"],
    path: r.path ?? "",
    env: r.env ? (JSON.parse(r.env) as Record<string, string>) : null,
    cwd: r.cwd,
    branch: r.branch,
    title: oneLine(r.title ?? r.first_prompt ?? ""),
    updatedAt: r.updated,
    snippet: null,
    fuzzy: false,
  };
}
