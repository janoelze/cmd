// Session and history search (docs/33) on its own thread: the queries over the
// log's full-text index, the vocabulary for typo tolerance and the snippets,
// answered from a long-lived worker with read-only connections to the log and
// the views file, so a common word typed in the palette never blocks the core
// (search.ts forwards to it). The index narrows by kind before anything is
// joined (`kind : transcript AND …`, fts.ts) and ranks inside its own
// subquery (`ORDER BY rank LIMIT n`): a join over every match of "the" took
// seconds. A log whose index is older (rebuilt by a startup job) is asked the
// old way until the new one is in place. In memory (tests) SearchEngine runs on
// the caller's thread.

import { DatabaseSync } from "node:sqlite";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { DataEvent, HistoryHit, SearchHit } from "@cmd/protocol";
import { SearchQuery, stem, Vocabulary, words } from "../../search/query.ts";
import { FTS_VERSION, HISTORY_TYPES, wordsOnly } from "../fts.ts";
import { textOf } from "../sources/transcripts.ts";
import { blobFrom, type Row as EventRow, toEvent } from "../store.ts";
import type { SessionRow } from "./sessions.ts";

/**
 * How long a vocabulary is used after the log grew: reading it takes a few
 * hundred ms on a big log, and transcripts grow every pass while agents work.
 * Only typo tolerance reads it; words as typed match the index directly.
 */
const VOCAB_MAX_AGE_MS = 5 * 60_000;

/** A vocabulary this small is read again as soon as the log grows: it costs a few ms (a fresh install, whose first pass comes after the startup read). */
export const VOCAB_EAGER_TERMS = 20_000;

/** Candidates the index hands over per tier, best first. */
const SESSION_CANDIDATES = 600;
const HISTORY_CANDIDATES = 400;

const oneLine = (t: string) => (t.split(/\r?\n/)[0] ?? t).trim().slice(0, 200);

interface Candidate {
  key: string;
  seq: number;
  score: number;
}

interface MatchRow {
  session_id: string;
  seq: number;
  type: string;
  bm: number;
  /** Text blocks in a Claude message, and blocks in all (null: no blocks, another agent's line). */
  texts: number | null;
  blocks: number | null;
}

export interface SearchEngineOptions {
  /** A vocabulary up to this many terms is read again as soon as the log grows. */
  eagerTerms?: number;
}

/** The searches over one log (events) and its sessions view. */
export class SearchEngine {
  #db: DatabaseSync;
  #sessionOf: (key: string) => SessionRow | null;
  #vocab: Vocabulary | null = null;
  #vocabAt = 0;
  #vocabStale = false;
  #vocabTerms = 0;
  #eagerTerms: number;

  constructor(db: DatabaseSync, sessionOf: (key: string) => SessionRow | null, o: SearchEngineOptions = {}) {
    this.#db = db;
    this.#sessionOf = sessionOf;
    this.#eagerTerms = o.eagerTerms ?? VOCAB_EAGER_TERMS;
  }

  /** The log grew: typo tolerance sees new words within VOCAB_MAX_AGE_MS (at once while the vocabulary is small). */
  invalidate(): void {
    this.#vocabStale = true;
    if (this.#vocabTerms <= this.#eagerTerms) this.#vocabulary();
  }

  /** Reads the vocabulary now, so the first search has typo tolerance. */
  warm(): void {
    this.#vocabulary();
  }

  #vocabulary(): Vocabulary {
    const due = !this.#vocab || (this.#vocabStale && (this.#vocabTerms <= this.#eagerTerms || Date.now() - this.#vocabAt >= VOCAB_MAX_AGE_MS));
    if (due) {
      this.#vocabStale = false;
      const rows = this.#db.prepare(`SELECT term, doc FROM events_vocab`).all() as { term: string; doc: number }[];
      this.#vocab = new Vocabulary(rows);
      this.#vocabTerms = rows.length;
      this.#vocabAt = Date.now();
    }
    return this.#vocab!;
  }

  /** Whether the index has the kind column (FTS_VERSION); an older one is asked the old way until its rebuild is done. */
  #kinds(): boolean {
    return (this.#db.prepare(`SELECT value FROM meta WHERE key = 'fts.version'`).get() as { value: string } | undefined)?.value === String(FTS_VERSION);
  }

  /** Sessions by full text, one hit per session, best first; a passage around the words as the snippet. */
  search(text: string, limit = 60, now = Date.now()): SearchHit[] {
    const q = new SearchQuery(text);
    if (q.isEmpty) return [];
    const vocab = this.#vocabulary();
    const expansions = q.terms.map((t) => vocab.expansions(t));
    const kinds = this.#kinds();

    // Tier 1: every term as typed (prefix). Tier 2: typo-tolerant, only if tier 1 came up short.
    let ranked = this.#match(q.expression(), kinds, now);
    let fuzzy = new Set<string>();
    if (ranked.length < 40 && expansions.some((e) => e.length)) {
      const seen = new Set(ranked.map((c) => c.key));
      const more = this.#match(q.expression(expansions), kinds, now).filter((c) => !seen.has(c.key));
      fuzzy = new Set(more.map((c) => c.key));
      ranked = [...ranked, ...more];
    }
    // The index is contentless (the words are in the events and their blobs), so the passage is cut here.
    const terms = [...q.terms, ...q.terms.map(stem), ...expansions.flat(), ...q.phrases.flatMap((p) => p.split(" "))];
    const out: SearchHit[] = [];
    for (const c of ranked) {
      const row = this.#sessionOf(c.key);
      if (!row) continue;
      const e = this.#event(c.seq);
      out.push({ ...toHit(row), snippet: e ? snippetOf(this.#fullText(e), terms) : null, fuzzy: fuzzy.has(c.key) });
      if (out.length === limit) break;
    }
    return out;
  }

  /**
   * What happened, by full text (the palette's search): commands (one row per
   * command line and folder, with how often it ran), pages (per address) and files
   * opened in cmd (per path). Best match first within each kind, recent ones a
   * little more; `limit` per kind.
   */
  history(text: string, o: { workspaceId?: string | null; limit?: number } = {}, now = Date.now()): HistoryHit[] {
    const q = new SearchQuery(text);
    if (q.isEmpty) return [];
    let rows: { e: DataEvent; bm: number }[];
    try {
      rows = this.#historyMatches(q.expression(), o.workspaceId ?? null);
    } catch {
      return []; // malformed expression
    }
    const terms = [...q.terms, ...q.terms.map(stem), ...q.phrases.flatMap((p) => p.split(" "))];
    const limit = o.limit ?? 5;
    const groups = new Map<string, { hit: HistoryHit; score: number; e: DataEvent }>();
    for (const { e, bm } of rows) {
      const d = (e.data ?? {}) as Record<string, unknown>;
      const ageDays = Math.max(0, now - e.at) / 86_400_000;
      const score = -bm * (1 + 0.6 * Math.exp(-ageDays / 21));
      let key: string;
      let hit: HistoryHit;
      if (e.type === "command") {
        const command = typeof d.command === "string" ? d.command : (e.text ?? "");
        if (!command.trim()) continue;
        const cwd = typeof d.cwd === "string" ? d.cwd : null;
        key = `c\0${command}\0${cwd}`;
        hit = { kind: "command", command: command.split("\n")[0]!.slice(0, 300), cwd, exitCode: typeof d.exitCode === "number" ? d.exitCode : null, at: e.at, paneId: e.paneId, runs: 1, snippet: null };
      } else if (e.type === "browser.visit") {
        const url = typeof d.url === "string" ? d.url : null;
        if (!url) continue;
        key = `p\0${url}`;
        hit = { kind: "page", url, title: typeof d.title === "string" ? d.title : null, at: e.at };
      } else {
        const p = typeof d.path === "string" ? d.path : null;
        if (!p) continue;
        key = `f\0${p}`;
        hit = { kind: "file", path: p, at: e.at };
      }
      const g = groups.get(key);
      if (!g) groups.set(key, { hit, score, e });
      else {
        if (g.hit.kind === "command") g.hit.runs++;
        // The best match ranks the row; the newest run is the one it shows.
        if (score > g.score) g.score = score;
        if (e.at > g.hit.at) (g.e = e), (g.hit = g.hit.kind === "command" && hit.kind === "command" ? { ...hit, runs: g.hit.runs } : hit);
      }
    }
    const out: HistoryHit[] = [];
    const per = new Map<string, number>();
    for (const g of [...groups.values()].sort((a, b) => b.score - a.score)) {
      const n = per.get(g.hit.kind) ?? 0;
      if (n >= limit) continue;
      per.set(g.hit.kind, n + 1);
      // A command's snippet: where its output has the words, if the line doesn't.
      if (g.hit.kind === "command" && g.e.blob && !terms.some((t) => g.hit.kind === "command" && g.hit.command.toLowerCase().includes(t))) {
        const output = this.#blob(g.e.blob)?.toString("utf8");
        if (output) g.hit.snippet = snippetOf(output, terms);
      }
      out.push(g.hit);
    }
    return out;
  }

  /**
   * History events matching, best first, with their bm25 (lower is better). The
   * index narrows to history and ranks; only its best are joined to their rows,
   * unless a workspace narrows further (history's matches are few next to transcripts').
   */
  #historyMatches(expression: string, workspaceId: string | null): { e: DataEvent; bm: number }[] {
    const ws = workspaceId ? [workspaceId] : [];
    let rows: (EventRow & { bm: number })[];
    if (this.#kinds()) {
      rows = this.#db
        .prepare(
          `SELECT e.*, json(e.data) AS data_json, f.bm FROM (SELECT rowid, rank AS bm FROM events_fts WHERE events_fts MATCH ? ORDER BY rank${workspaceId ? "" : " LIMIT ?"}) f
           JOIN events e ON e.seq = f.rowid${workspaceId ? " WHERE e.workspace_id = ?" : ""} ORDER BY f.bm LIMIT ?`,
        )
        .all(`kind : history AND ${wordsOnly(expression)}`, ...(workspaceId ? ws : [HISTORY_CANDIDATES]), HISTORY_CANDIDATES) as unknown as (EventRow & { bm: number })[];
    } else {
      rows = this.#db
        .prepare(
          `SELECT e.*, json(e.data) AS data_json, bm25(events_fts, 3.0, 1.0) AS bm FROM events_fts JOIN events e ON e.seq = events_fts.rowid
           WHERE events_fts MATCH ? AND e.type IN (${HISTORY_TYPES.map(() => "?").join(",")})${workspaceId ? " AND e.workspace_id = ?" : ""} ORDER BY bm LIMIT ?`,
        )
        .all(expression, ...HISTORY_TYPES, ...ws, HISTORY_CANDIDATES) as unknown as (EventRow & { bm: number })[];
    }
    return rows.map((r) => ({ e: toEvent(r), bm: r.bm }));
  }

  /** Sessions whose transcript events match, best first: one per session, the best event's seq for the snippet. */
  #match(expression: string, kinds: boolean, now: number): Candidate[] {
    if (!expression) return [];
    const blocks = `(SELECT count(*) FROM json_each(e.data, '$.blocks') WHERE json_extract(value, '$.type') = 'text') AS texts, json_array_length(e.data, '$.blocks') AS blocks`;
    let rows: MatchRow[];
    try {
      rows = (
        kinds
          ? this.#db
              .prepare(
                `SELECT e.session_id, e.seq, e.type, f.bm, ${blocks}
                 FROM (SELECT rowid, rank AS bm FROM events_fts WHERE events_fts MATCH ? ORDER BY rank LIMIT ${SESSION_CANDIDATES}) f
                 JOIN events e ON e.seq = f.rowid WHERE e.session_id IS NOT NULL ORDER BY f.bm`,
              )
              .all(`kind : transcript AND ${wordsOnly(expression)}`)
          : this.#db
              .prepare(
                `SELECT e.session_id, e.seq, e.type, bm25(events_fts, 3.0, 1.0) AS bm, ${blocks}
                 FROM events_fts JOIN events e ON e.seq = events_fts.rowid
                 WHERE events_fts MATCH ? AND e.session_id IS NOT NULL AND e.type >= 'transcript.' AND e.type < 'transcript.￿'
                 ORDER BY bm LIMIT ${SESSION_CANDIDATES}`,
              )
              .all(expression)
      ) as unknown as MatchRow[];
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
      const row = this.#sessionOf(c.key);
      // Recent sessions get up to 60% more weight, fading over a few weeks; more matching events a little.
      const ageDays = row?.updated ? Math.max(0, now - row.updated) / 86_400_000 : 365;
      const recency = 1 + 0.6 * Math.exp(-ageDays / 21);
      out.push({ key: c.key, seq: c.seq, score: c.score * recency * (1 + Math.min(c.hits, 10) * 0.03) });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  #event(seq: number): DataEvent | null {
    const r = this.#db.prepare(`SELECT *, json(data) AS data_json FROM events WHERE seq = ?`).get(seq) as unknown as EventRow | undefined;
    return r ? toEvent(r) : null;
  }

  #blob(hash: string): Buffer | null {
    return blobFrom(this.#db.prepare(`SELECT enc, bytes FROM blobs WHERE hash = ?`).get(hash) as { enc: string; bytes: Uint8Array } | undefined);
  }

  /** The words of an event: its message's text when inline, else from the blob, else its line. */
  #fullText(e: DataEvent): string {
    const d = e.data as Record<string, unknown>;
    const msg = d.message as Record<string, unknown> | undefined;
    if (msg?.content !== undefined) return textOf(msg.content) || (e.text ?? "");
    if (e.blob) {
      try {
        const line = JSON.parse(this.#blob(e.blob)!.toString("utf8")) as Record<string, unknown>;
        const m = (line.message ?? line.payload) as Record<string, unknown> | undefined;
        const t = textOf(m?.content ?? m?.message);
        if (t) return t;
      } catch {}
    }
    return e.text ?? "";
  }
}

/**
 * How much a match in this event says the session is about the words: a title
 * most, what you and the agent wrote, then the tools' calls and what they printed
 * (a session that ran the tests isn't about every word the tests print).
 * Measured on known-item queries over real history (docs/33).
 */
export function weightOf(r: Pick<MatchRow, "type" | "texts" | "blocks">): number {
  if (r.type === "transcript.title") return 2;
  if (r.type === "transcript.tool_result" || r.type === "transcript.tool_use") return 0.3;
  // A Claude message that is only tool calls.
  if (r.type === "transcript.message" && r.blocks && !r.texts) return 0.3;
  return 1;
}

/** A passage around the first matching word, the matches wrapped in \x01…\x02 (what the palette highlights). */
export function snippetOf(text: string, terms: string[], span = 18): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const tokens = flat.split(" ");
  const wanted = terms.filter(Boolean);
  const wordMatches = (w: string) => wanted.some((t) => (t.length >= 3 ? w.startsWith(t) : w === t));
  // Any word in the token: "flaky" is in packages/test/flaky.test.ts; only that word is marked.
  const matches = (tok: string) => words(tok).some(wordMatches);
  const mark = (tok: string) => tok.replace(/[\p{L}\p{N}]+/gu, (w) => (wordMatches(words(w)[0] ?? "") ? `\x01${w}\x02` : w));
  let first = tokens.findIndex(matches);
  if (first < 0) return tokens.slice(0, span).join(" ") + (tokens.length > span ? "…" : "");
  const start = Math.max(0, first - Math.floor(span / 3));
  const end = Math.min(tokens.length, start + span);
  const part = tokens.slice(start, end).map((tok) => (matches(tok) ? mark(tok) : tok));
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

/** What search.ts sends the worker. */
export type SearchRequest =
  | { id: number; op: "search"; text: string; limit?: number; now?: number }
  | { id: number; op: "history"; text: string; workspaceId?: string | null; limit?: number; now?: number }
  | { op: "invalidate" }
  | { op: "warm" };

/** What the worker answers a request with an id. */
export type SearchReply = { id: number; result: unknown } | { id: number; error: string };

export interface SearchWorkerData {
  search: { events: string; views: string | null; eagerTerms?: number };
}

// The worker: started by search.ts with the files to open; answers in order, one request at a time.
const wd = workerData as Partial<SearchWorkerData> | null;
if (!isMainThread && parentPort && wd?.search) {
  const port = parentPort;
  const db = new DatabaseSync(wd.search.events, { readOnly: true, timeout: 5000 });
  const views = wd.search.views ? new DatabaseSync(wd.search.views, { readOnly: true, timeout: 5000 }) : null;
  const session = views?.prepare(`SELECT * FROM sessions WHERE key = ?`);
  const engine = new SearchEngine(db, (key) => (session?.get(key) as SessionRow | undefined) ?? null, { eagerTerms: wd.search.eagerTerms });
  port.on("message", (m: SearchRequest) => {
    if (m.op === "invalidate" || m.op === "warm") {
      try {
        if (m.op === "invalidate") engine.invalidate();
        else engine.warm();
      } catch {} // the next search reads it again
      return;
    }
    try {
      const result = m.op === "search" ? engine.search(m.text, m.limit, m.now) : engine.history(m.text, { workspaceId: m.workspaceId, limit: m.limit }, m.now);
      port.postMessage({ id: m.id, result } satisfies SearchReply);
    } catch (err) {
      port.postMessage({ id: m.id, error: (err as Error).message } satisfies SearchReply);
    }
  });
}
