// Transcript search index (SQLite FTS5). Port of the fork's SessionIndex.swift.
// Indexing (indexPass) runs in a worker thread (worker.ts); searching uses a
// separate read connection in the core (WAL mode allows both at once).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isEmpty, parseClaude, parseCodex, PARSER_VERSION, type SessionDocument, type TranscriptAgent } from "./parser.ts";
import { identifierParts, SearchQuery, Vocabulary } from "./query.ts";

export interface TranscriptRoot {
  agent: TranscriptAgent;
  dir: string;
  /** Claude config dir the transcripts belong to (for resume); null for archives and Codex. */
  configDir: string | null;
  /** "projects": projects/<project>/<session>.jsonl · "flat": <dir>/*.jsonl · "tree": recursive. */
  layout: "projects" | "flat" | "tree";
}

export interface SearchHit {
  sessionId: string;
  agent: TranscriptAgent;
  path: string;
  configDir: string | null;
  cwd: string | null;
  branch: string | null;
  title: string;
  updatedAt: number | null;
  /** Matching passage; \x01…\x02 mark highlighted terms. */
  snippet: string | null;
  fuzzy: boolean;
}

export interface IndexStatus {
  sessions: number;
  files: number;
  indexing: boolean;
  /** Files done / to do in the running pass. */
  done: number;
  total: number;
}

const SCHEMA_VERSION = 2; // 2: sessions.msg_first/msg_last

/**
 * Where transcripts live: every Claude config dir (default, $CLAUDE_CONFIG_DIR,
 * ~/.claude-profiles/*), extra archive dirs (flat <uuid>.jsonl), and Codex sessions.
 */
export function defaultRoots(archiveDirs: string[] = [], home = process.env.CMD_TRANSCRIPTS_HOME ?? os.homedir()): TranscriptRoot[] {
  const claudeDirs = [path.join(home, ".claude")];
  if (process.env.CLAUDE_CONFIG_DIR && !process.env.CMD_TRANSCRIPTS_HOME) claudeDirs.push(process.env.CLAUDE_CONFIG_DIR);
  const profiles = path.join(home, ".claude-profiles");
  try {
    for (const p of fs.readdirSync(profiles)) claudeDirs.push(path.join(profiles, p));
  } catch {}
  const roots: TranscriptRoot[] = [];
  const seen = new Set<string>();
  for (const d of claudeDirs) {
    let real: string;
    try {
      real = fs.realpathSync(d);
    } catch {
      continue;
    }
    const projects = path.join(real, "projects");
    if (seen.has(projects) || !fs.existsSync(projects)) continue;
    seen.add(projects);
    roots.push({ agent: "claude", dir: projects, configDir: real, layout: "projects" });
  }
  for (const a of archiveDirs) {
    const dir = a.replace(/^~(?=$|\/)/, home);
    if (fs.existsSync(dir)) roots.push({ agent: "claude", dir, configDir: null, layout: "flat" });
  }
  const codex = path.join((!process.env.CMD_TRANSCRIPTS_HOME && process.env.CODEX_HOME) || path.join(home, ".codex"), "sessions");
  if (fs.existsSync(codex)) roots.push({ agent: "codex", dir: codex, configDir: null, layout: "tree" });
  return roots;
}

export interface TranscriptFile {
  path: string;
  root: TranscriptRoot;
  size: number;
  mtime: number;
}

export function transcriptFiles(roots: TranscriptRoot[]): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  const add = (p: string, root: TranscriptRoot) => {
    if (!p.endsWith(".jsonl")) return;
    try {
      const st = fs.statSync(p);
      if (st.isFile()) out.push({ path: p, root, size: st.size, mtime: st.mtimeMs });
    } catch {}
  };
  const list = (d: string) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  };
  for (const root of roots) {
    if (root.layout === "projects") {
      // projects/<project>/<session>.jsonl; deeper files are subagent logs.
      for (const project of list(root.dir)) {
        const pd = path.join(root.dir, project);
        for (const f of list(pd)) add(path.join(pd, f), root);
      }
    } else if (root.layout === "flat") {
      for (const f of list(root.dir)) add(path.join(root.dir, f), root);
    } else {
      for (const f of fs.readdirSync(root.dir, { recursive: true }) as string[]) add(path.join(root.dir, f), root);
    }
  }
  return out;
}

export function openIndex(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);`);
  const version = `${SCHEMA_VERSION}.${PARSER_VERSION}`;
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'version'`).get() as { value: string } | undefined;
  if (row?.value !== version) {
    // Schema or parser changed: rebuild from scratch.
    db.exec(`DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS session_fts;
      DROP TABLE IF EXISTS message_fts; DROP TABLE IF EXISTS vocab;`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, size INTEGER, mtime REAL);
    CREATE TABLE IF NOT EXISTS sessions(
      rowid INTEGER PRIMARY KEY, id TEXT, agent TEXT, path TEXT UNIQUE, config_dir TEXT,
      cwd TEXT, branch TEXT, title TEXT, first_prompt TEXT, started REAL, updated REAL,
      msg_first INTEGER, msg_last INTEGER);
    CREATE INDEX IF NOT EXISTS sessions_id ON sessions(id);
    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      title, prompts, responses, tools, idents, tokenize = 'unicode61 remove_diacritics 2');
    CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
      text, session UNINDEXED, kind UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
    CREATE VIRTUAL TABLE IF NOT EXISTS vocab USING fts5vocab(session_fts, 'row');
  `);
  db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('version', ?)`).run(version);
  return db;
}

function deleteByPath(db: DatabaseSync, p: string): void {
  const row = db.prepare(`SELECT rowid, msg_first, msg_last FROM sessions WHERE path = ?`).get(p) as
    | { rowid: number; msg_first: number | null; msg_last: number | null }
    | undefined;
  if (row) {
    db.prepare(`DELETE FROM session_fts WHERE rowid = ?`).run(row.rowid);
    // By rowid range: `session` is an UNINDEXED FTS column, so deleting by it scans
    // every message in the index (~160 ms at 150k messages, per changed transcript).
    if (row.msg_first !== null && row.msg_last !== null)
      db.prepare(`DELETE FROM message_fts WHERE rowid BETWEEN ? AND ?`).run(row.msg_first, row.msg_last);
    db.prepare(`DELETE FROM sessions WHERE rowid = ?`).run(row.rowid);
  }
}

function insert(db: DatabaseSync, d: SessionDocument): void {
  const r = db
    .prepare(
      `INSERT INTO sessions(id, agent, path, config_dir, cwd, branch, title, first_prompt, started, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      d.id,
      d.agent,
      d.path,
      d.configDir,
      d.cwd ?? null,
      d.branch ?? null,
      d.title ?? null,
      d.prompts[0]?.slice(0, 500) ?? null,
      d.startedAt ?? null,
      d.updatedAt ?? null,
    );
  const rowid = Number(r.lastInsertRowid);
  const everything = [...d.prompts, ...d.responses, ...d.tools, d.title ?? "", d.cwd ?? ""];
  db.prepare(`INSERT INTO session_fts(rowid, title, prompts, responses, tools, idents) VALUES (?, ?, ?, ?, ?, ?)`).run(
    rowid,
    [d.title, d.cwd?.split("/").pop(), d.branch].filter(Boolean).join(" "),
    d.prompts.join("\n"),
    d.responses.join("\n"),
    d.tools.join("\n"),
    identifierParts(everything),
  );
  // A session's messages get consecutive rowids (one writer, inside a transaction);
  // remember the range so deleteByPath can remove them without a scan.
  const msg = db.prepare(`INSERT INTO message_fts(text, session, kind) VALUES (?, ?, ?)`);
  let first: number | null = null;
  let last: number | null = null;
  for (const [kind, texts] of [["p", d.prompts], ["r", d.responses], ["t", d.tools]] as const) {
    for (const t of texts) {
      last = Number(msg.run(t, rowid, kind).lastInsertRowid);
      first ??= last;
    }
  }
  if (first !== null) db.prepare(`UPDATE sessions SET msg_first = ?, msg_last = ? WHERE rowid = ?`).run(first, last, rowid);
}

export function parseFile(f: TranscriptFile): SessionDocument | null {
  let text: string;
  try {
    text = fs.readFileSync(f.path, "utf8");
  } catch {
    return null;
  }
  const doc = f.root.agent === "codex" ? parseCodex(text, f.path) : parseClaude(text, f.path, f.root.configDir);
  return doc && !isEmpty(doc) ? doc : null;
}

/**
 * One incremental pass: (re)index files whose size or mtime changed, drop removed
 * ones. Commits in batches so readers see progress.
 */
export function indexPass(db: DatabaseSync, roots: TranscriptRoot[], onProgress?: (done: number, total: number) => void): { changed: number; removed: number } {
  const files = transcriptFiles(roots);
  const known = new Map<string, { size: number; mtime: number }>();
  for (const r of db.prepare(`SELECT path, size, mtime FROM files`).all() as { path: string; size: number; mtime: number }[]) {
    known.set(r.path, r);
  }
  const changed = files.filter((f) => {
    const k = known.get(f.path);
    return !k || k.size !== f.size || Math.abs(k.mtime - f.mtime) > 1;
  });
  const present = new Set(files.map((f) => f.path));
  const removed = [...known.keys()].filter((p) => !present.has(p));

  const BATCH = 25;
  db.exec("BEGIN");
  try {
    for (const p of removed) {
      deleteByPath(db, p);
      db.prepare(`DELETE FROM files WHERE path = ?`).run(p);
    }
    changed.forEach((f, i) => {
      deleteByPath(db, f.path);
      const doc = parseFile(f);
      if (doc) insert(db, doc);
      db.prepare(`INSERT OR REPLACE INTO files(path, size, mtime) VALUES (?, ?, ?)`).run(f.path, f.size, f.mtime);
      if ((i + 1) % BATCH === 0) {
        db.exec("COMMIT");
        onProgress?.(i + 1, changed.length);
        db.exec("BEGIN");
      }
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  onProgress?.(changed.length, changed.length);
  return { changed: changed.length, removed: removed.length };
}

export function indexCounts(db: DatabaseSync): { sessions: number; files: number } {
  const s = db.prepare(`SELECT count(*) AS n FROM sessions`).get() as { n: number };
  const f = db.prepare(`SELECT count(*) AS n FROM files`).get() as { n: number };
  return { sessions: s.n, files: f.n };
}

const oneLine = (t: string) => (t.split(/\r?\n/)[0] ?? t).trim().slice(0, 200);

/** Searcher over a read connection; caches the vocabulary until the index changes. */
export class Searcher {
  #db: DatabaseSync;
  #vocab: Vocabulary | null = null;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  counts(): { sessions: number; files: number } {
    return indexCounts(this.#db);
  }

  close(): void {
    this.#db.close();
  }

  /** Call after the index changed so typo tolerance sees new words. */
  invalidate(): void {
    this.#vocab = null;
  }

  search(text: string, limit = 60, now = Date.now()): SearchHit[] {
    const q = new SearchQuery(text);
    if (q.isEmpty) return [];
    this.#vocab ??= new Vocabulary(this.#db.prepare(`SELECT term, doc FROM vocab`).all() as { term: string; doc: number }[]);
    const expansions = q.terms.map((t) => this.#vocab!.expansions(t));

    // Tier 1: every term as typed (prefix). Tier 2: typo-tolerant, only if tier 1 came up short.
    let ranked = this.#match(q.expression(), false, now);
    if (ranked.length < 40 && expansions.some((e) => e.length)) {
      const seen = new Set(ranked.map((c) => c.rowid));
      ranked = [...ranked, ...this.#match(q.expression(expansions), true, now).filter((c) => !seen.has(c.rowid))];
    }
    // One result per session: resumed or archived sessions can span several files.
    const ids = new Set<string>();
    ranked = ranked.filter((c) => !ids.has(c.sessionId) && ids.add(c.sessionId));

    const snippetExpr = q.anyTermExpression(expansions);
    const snip = this.#db.prepare(
      `SELECT snippet(message_fts, 0, char(1), char(2), '…', 18) AS s FROM message_fts
       WHERE message_fts MATCH ? AND session = ? ORDER BY rank LIMIT 1`,
    );
    return ranked.slice(0, limit).map((c) => {
      let snippet: string | null = null;
      try {
        snippet = ((snip.get(snippetExpr, c.rowid) as { s: string } | undefined)?.s ?? null)?.replace(/\n/g, " ") ?? null;
      } catch {}
      const { rowid: _r, score: _s, ...hit } = c;
      return { ...hit, snippet };
    });
  }

  #match(expression: string, fuzzy: boolean, now: number) {
    if (!expression) return [];
    // Column weights: title, prompts, responses, tools, identifier parts.
    let rows: Record<string, unknown>[];
    try {
      rows = this.#db
        .prepare(
          `SELECT s.rowid, s.id, s.agent, s.path, s.config_dir, s.cwd, s.branch,
                  coalesce(s.title, s.first_prompt, '') AS title, s.updated,
                  bm25(session_fts, 10.0, 5.0, 1.0, 2.0, 1.5) AS bm
           FROM session_fts JOIN sessions s ON s.rowid = session_fts.rowid
           WHERE session_fts MATCH ? ORDER BY bm LIMIT 300`,
        )
        .all(expression) as Record<string, unknown>[];
    } catch {
      return []; // malformed expression
    }
    return rows
      .map((r) => {
        const updated = typeof r.updated === "number" ? r.updated : null;
        // Recent sessions get up to 60% more weight, fading over a few weeks.
        const ageDays = updated ? Math.max(0, now - updated) / 86_400_000 : 365;
        const recency = 1 + 0.6 * Math.exp(-ageDays / 21);
        return {
          rowid: r.rowid as number,
          sessionId: String(r.id ?? ""),
          agent: (r.agent === "codex" ? "codex" : "claude") as TranscriptAgent,
          path: String(r.path),
          configDir: (r.config_dir as string | null) ?? null,
          cwd: (r.cwd as string | null) ?? null,
          branch: (r.branch as string | null) ?? null,
          title: oneLine(String(r.title ?? "")),
          updatedAt: updated,
          fuzzy,
          score: -(r.bm as number) * recency,
        };
      })
      .sort((a, b) => b.score - a.score);
  }
}
