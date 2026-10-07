// Session search over the event log (docs/28 §4, C3): the palette's ?query and
// the Navigator's search. Matches transcript events in the log's full-text
// index (text and body: prompts, answers, tool inputs, titles), ranks their
// sessions (best match; titles weigh more, tools' calls and output less, so a
// session isn't found for a word a command printed; recent sessions a little more),
// tolerates typos through the index's vocabulary, and answers with one hit
// per session from the sessions view. Replaces search.sqlite's Searcher.

import { Worker } from "node:worker_threads";
import type { DataEvent, SearchHit } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { SearchQuery, stem, Vocabulary, words } from "../../search/query.ts";
import { textOf } from "../sources/transcripts.ts";
import type { DataService } from "../service.ts";
import type { SessionRow, SessionsView } from "./sessions.ts";

/**
 * How long a vocabulary is used after the log grew: reading it blocks for a few
 * hundred ms on a big log, and transcripts grow every pass while agents work.
 * Only typo tolerance reads it; words as typed match the index directly.
 */
const VOCAB_MAX_AGE_MS = 5 * 60_000;

const log = logger("search");

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
  #vocabAt = 0;
  #vocabStale = false;
  #vocabLoading = false;
  #vocabTerms = 0;

  constructor(data: DataService, sessions: SessionsView) {
    this.#data = data;
    this.#sessions = sessions;
  }

  /** Call after the log grew so typo tolerance sees new words (within VOCAB_MAX_AGE_MS; at once while there is none, or an empty one from before the first read). */
  invalidate(): void {
    this.#vocabStale = true;
    if (!this.#vocabTerms) this.#vocabulary();
  }

  /** Starts the first read, so the first search has typo tolerance (Core.start). */
  warm(): void {
    this.#vocabulary();
  }

  /**
   * The vocabulary as it is; null until the first read is done. A log on disk is
   * read on a worker (vocab-worker.ts: hundreds of ms on a big log, which would
   * block the core), the old vocabulary serving meanwhile; a log in memory
   * (tests) is read here.
   */
  #vocabulary(): Vocabulary | null {
    const due = !this.#vocab || (this.#vocabStale && (!this.#vocabTerms || Date.now() - this.#vocabAt >= VOCAB_MAX_AGE_MS));
    if (due && !this.#vocabLoading) {
      const file = this.#data.store.file;
      if (file === ":memory:") this.#loaded(this.#data.store.db.prepare(`SELECT term, doc FROM events_vocab`).all() as { term: string; doc: number }[]);
      else {
        this.#vocabLoading = true;
        const w = new Worker(new URL("./vocab-worker.ts", import.meta.url), { workerData: { file } });
        w.unref();
        w.once("message", (m: { terms: string[]; docs: number[] }) => {
          this.#vocabLoading = false;
          this.#loaded(m.terms.map((term, i) => ({ term, doc: m.docs[i]! })));
        });
        w.once("error", (err) => {
          this.#vocabLoading = false;
          log.warn(`could not read the search vocabulary: ${err.message}`);
        });
      }
    }
    return this.#vocab;
  }

  #loaded(rows: { term: string; doc: number }[]): void {
    this.#vocab = new Vocabulary(rows);
    this.#vocabTerms = rows.length;
    this.#vocabAt = Date.now();
    this.#vocabStale = false;
    log.debug("vocabulary read", { terms: rows.length });
  }

  search(text: string, limit = 60, now = Date.now()): SearchHit[] {
    const q = new SearchQuery(text);
    if (q.isEmpty) return [];
    const vocab = this.#vocabulary();
    const expansions = q.terms.map((t) => vocab?.expansions(t) ?? []); // typo tolerance waits for the first read

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
    const terms = [...q.terms, ...q.terms.map(stem), ...expansions.flat(), ...q.phrases.flatMap((p) => p.split(" "))];
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
    let rows: Row[];
    try {
      rows = this.#data.store.db
        .prepare(
          `SELECT e.session_id, e.seq, e.type, bm25(events_fts, 3.0, 1.0) AS bm,
             (SELECT count(*) FROM json_each(e.data, '$.blocks') WHERE json_extract(value, '$.type') = 'text') AS texts,
             json_array_length(e.data, '$.blocks') AS blocks
           FROM events_fts JOIN events e ON e.seq = events_fts.rowid
           WHERE events_fts MATCH ? AND e.session_id IS NOT NULL AND e.type >= 'transcript.' AND e.type < 'transcript.￿'
           ORDER BY bm LIMIT 600`,
        )
        .all(expression) as unknown as Row[];
    } catch {
      return []; // malformed expression
    }
    const by = new Map<string, Candidate & { hits: number }>();
    for (const r of rows) {
      const score = -r.bm * weightOf(r);
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

interface Row {
  session_id: string;
  seq: number;
  type: string;
  bm: number;
  /** Text blocks in a Claude message, and blocks in all (null: no blocks, another agent's line). */
  texts: number | null;
  blocks: number | null;
}

/**
 * How much a match in this event says the session is about the words: a title
 * most, what you and the agent wrote, then the tools' calls and what they printed
 * (a session that ran the tests isn't about every word the tests print).
 * Measured on known-item queries over real history (docs/33).
 */
export function weightOf(r: Pick<Row, "type" | "texts" | "blocks">): number {
  if (r.type === "transcript.title") return 2;
  if (r.type === "transcript.tool_result" || r.type === "transcript.tool_use") return 0.3;
  // A Claude message that is only tool calls.
  if (r.type === "transcript.message" && r.blocks && !r.texts) return 0.3;
  return 1;
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
