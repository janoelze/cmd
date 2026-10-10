// The log's full-text index (events_fts): its table, the kind each event is
// indexed under and the words a rebuild indexes for an event. The kind column
// lets FTS5 narrow a search to transcripts or history before anything is joined
// (`kind : history AND {text body} : (…)`); the rank is bm25 with the kind's
// weight 0, so `ORDER BY rank LIMIT n` stays inside the index. The index is
// contentless, so a rebuild takes each event's words from the event again
// (bodyOf): what the recorder indexed, re-derived from the stored row and blob.

import type { DataEvent } from "@cmd/protocol";
import { commandBody } from "../commands.ts";
import { identifierParts } from "../search/query.ts";
import { claudeLine, codexLine } from "./sources/transcripts.ts";

/** The index's format: a log whose `fts.version` is older is rebuilt once (DataStore.buildFts, a startup job). 2: the kind column and the rank config. */
export const FTS_VERSION = 2;

/** Words indexed per event are cut here (as transcripts.ts does). */
const BODY_CAP = 20_000;

/** The index under `name` (events_fts, or events_fts_next while a rebuild fills it). Contentless: rowid = seq. */
export const ftsSql = (name: string) => `
CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(
  text, body, kind, content='', contentless_delete=1, detail=full, tokenize='unicode61 remove_diacritics 2'
);
INSERT INTO ${name}(${name}, rank) VALUES ('rank', 'bm25(3.0, 1.0, 0.0)');
`;

export const VOCAB_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS events_vocab USING fts5vocab(events_fts, 'row');`;

/** What a search narrows to: sessions (transcripts), history (commands, pages, files), agents' hooks and notes, the rest. */
export type FtsKind = "transcript" | "history" | "agent" | "other";

export const HISTORY_TYPES = ["command", "browser.visit", "file.open"];

export function ftsKind(type: string, sessionId: string | null | undefined): FtsKind {
  if (type.startsWith("transcript.")) return sessionId ? "transcript" : "other";
  if (HISTORY_TYPES.includes(type)) return "history";
  if (type.startsWith("agent.")) return "agent";
  return "other";
}

/** A text expression over the words only, so a query never matches an event's kind ("history", "t*"). */
export const wordsOnly = (expression: string) => `{text body} : (${expression})`;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const NO_FILE = { agent: null, path: "", env: null };

/**
 * The body an event was indexed with, from what the log kept: a transcript line
 * parsed again (the verbatim line from its blob when it was big, else the
 * message kept inline), a command's line and the end of its output, a page's
 * title, a hook's prompt or answer. A summary's text past its first line isn't
 * kept, so it's found by that line only.
 */
export function bodyOf(e: DataEvent, blob: (hash: string) => Buffer | null): string | null {
  const d = (isObj(e.data) ? e.data : {}) as Obj;
  const raw = () => (e.blob ? (blob(e.blob)?.toString("utf8") ?? null) : null);
  if (e.type.startsWith("transcript.")) {
    if (d.whole === true) {
      // A session read whole (docEvents): the prompt, answer or tool call is in data.
      const t = e.type === "transcript.title" ? str(d.title) : isObj(d.message) ? str(d.message.content) : str(d.tool);
      if (!t) return null;
      return e.type === "transcript.title" ? t : cap(`${t}\n${identifierParts([t])}`);
    }
    if (e.type === "transcript.title") return str(d.title);
    if (e.type === "transcript.summary") return e.text;
    const codex = e.source.startsWith("transcript:codex");
    const line = raw() ?? JSON.stringify(codex ? { type: d.line, payload: d.payload } : { type: d.line, message: d.message, isSidechain: d.isSidechain, isMeta: d.isMeta, isCompactSummary: d.isCompactSummary });
    const again = codex ? codexLine(line, 0, NO_FILE, {}) : claudeLine(line, 0, NO_FILE);
    return again?.body ?? null;
  }
  switch (e.type) {
    case "command":
      return commandBody(str(d.command) ?? e.text, raw());
    case "browser.visit":
      return str(d.title);
    case "notification":
      return str(d.body);
    case "note":
    case "git.commit":
      return e.text;
    case "agent.hook":
    case "agent.note": {
      let p = isObj(d.payload) ? d.payload : {};
      // A payload that was cut is whole in the blob.
      const full = raw();
      if (full) {
        try {
          const o = JSON.parse(full) as unknown;
          if (isObj(o)) p = o;
        } catch {}
      }
      return str(p.prompt) ?? str(p.last_assistant_message);
    }
  }
  return null;
}

const cap = (s: string) => (s.length > BODY_CAP ? s.slice(0, BODY_CAP) : s);
