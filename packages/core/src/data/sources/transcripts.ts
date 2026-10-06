// Agent transcripts as events (docs/28 §2; requirement A6: cmd owns
// transcripts). One JSONL line of a session becomes one `transcript.*` event:
// the agent's own ids kept verbatim (`claude:<uuid>`, parent = parentUuid;
// `codex:<session>:<n>`), the message normalised into a small `data`, the words
// for search as `body` (prompts, answers, tool inputs with their identifier
// parts), the verbatim line as the blob when it's big. Files are read from
// where the last read stopped (readTranscript), so a live session costs only
// its new lines. Agents whose lines cmd doesn't know line by line (Copilot) are
// read whole through their parser and re-emitted on change; ids keep that idempotent.

import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { AgentKind, DataEventType } from "@cmd/protocol";
import { cleanClaudePrompt, describeToolInput, headObjects, type SessionDocument, type TranscriptText } from "../../search/parser.ts";
import { identifierParts } from "../../search/query.ts";
import type { TranscriptRoot, TranscriptSources } from "../../search/sources.ts";
import { projectIdOf } from "../project.ts";
import type { StoreEvent as NewEvent } from "../store.ts";

/** Lines shorter than this are kept whole in `data`; longer ones go to a blob with a summary inline. */
export const INLINE_LINE = 2048;
const TEXT_LINE = 300;
/** Words indexed per event are cut here. */
const BODY_CAP = 20_000;

export interface TranscriptFile {
  /** Whose transcripts (null in a mixed folder: sniffed from the file). */
  agent: AgentKind | null;
  path: string;
  /** Environment the agent needs to find these sessions again (the root's). */
  env: Record<string, string> | null;
}

/** Where a file's reading stopped. */
export interface ReadState {
  offset: number;
  lines: number;
  agent: AgentKind | null;
}

export interface ReadResult extends ReadState {
  events: NewEvent[];
  /** The session the file's lines belong to (the last one seen). */
  sessionId: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
/** Claude's bookkeeping lines that say nothing about the work (docs/28 §11): not rows. */
const CLAUDE_NOISE = new Set(["last-prompt", "atis-latch", "mode", "cost-state", "file-history-delta"]);
/** Codex's per-call token counters: not rows either. */
const CODEX_NOISE = new Set(["token_count"]);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const line1 = (s: string) => (s.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, TEXT_LINE);
const cap = (s: string) => (s.length > BODY_CAP ? s.slice(0, BODY_CAP) : s);

/** Text blocks of a message's content, joined. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (isObj(b) && b.type === "text" && typeof b.text === "string" ? b.text : isObj(b) && b.type === "tool_result" ? textOf(b.content) : ""))
    .filter(Boolean)
    .join("\n");
}

/** Content blocks reduced to what's worth a row: type, tool name and ids, sizes. */
function blocksOf(content: unknown): Obj[] {
  if (typeof content === "string") return [{ type: "text", chars: content.length }];
  if (!Array.isArray(content)) return [];
  return content.filter(isObj).map((b) => {
    const o: Obj = { type: b.type };
    if (b.type === "text" && typeof b.text === "string") o.chars = b.text.length;
    if (b.type === "tool_use" || b.type === "server_tool_use") (o.name = b.name), (o.id = b.id), (o.chars = JSON.stringify(b.input ?? null).length);
    if (b.type === "tool_result") (o.toolUseId = b.tool_use_id), (o.chars = textOf(b.content).length), (o.isError = b.is_error === true);
    if (b.type === "thinking") o.chars = typeof b.thinking === "string" ? b.thinking.length : 0;
    return o;
  });
}

/** Tool calls in a message as text for search ("Bash: pnpm test"), with the identifiers' parts. */
function toolText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (!isObj(b) || (b.type !== "tool_use" && b.type !== "server_tool_use")) continue;
    const t = describeToolInput(b.input);
    if (t) parts.push(`${str(b.name) ?? "tool"}: ${t}`);
  }
  return parts.join("\n");
}

/**
 * One Claude Code line → an event, or null for
 * a line that isn't JSON. Every line type is kept as a kind of its own so a
 * reader can tell dialogue from compaction summaries and metadata.
 */
export function claudeLine(line: string, n: number, file: TranscriptFile, sessionHint?: string): NewEvent | null {
  const agent = "claude";
  let o: Obj;
  try {
    o = JSON.parse(line) as Obj;
  } catch {
    return null;
  }
  if (!isObj(o)) return null;
  const type = str(o.type) ?? "unknown";
  if (CLAUDE_NOISE.has(type)) return null;
  const uuid = str(o.uuid);
  const sessionId = str(o.sessionId) ?? sessionHint;
  const id = uuid ? `${agent}:${uuid}` : `${agent}:${sessionId ?? file.path}:${n}`;
  const at = o.timestamp ? Date.parse(String(o.timestamp)) : NaN;
  const base: Omit<NewEvent, "type" | "data"> = {
    id,
    at: Number.isFinite(at) ? at : 0,
    source: `transcript:${agent}${str(o.version) ? `@${o.version}` : ""}`,
    parentId: str(o.parentUuid) ? `${agent}:${o.parentUuid}` : null,
    sessionId: sessionId ? `${agent}:${sessionId}` : null,
    projectId: projectIdOf(str(o.cwd)),
  };
  const message = isObj(o.message) ? o.message : null;
  const side = o.isSidechain === true || o.isMeta === true;
  const common: Obj = { line: type, cwd: o.cwd, gitBranch: o.gitBranch, version: o.version, isSidechain: o.isSidechain === true, isMeta: o.isMeta === true };

  if (message && (type === "user" || type === "assistant")) {
    const role = str(message.role) ?? type;
    const raw = textOf(message.content);
    const text = role === "user" ? cleanClaudePrompt(raw) : raw;
    const blocks = blocksOf(message.content);
    const isToolResult = blocks.some((b) => b.type === "tool_result") && !blocks.some((b) => b.type === "text");
    const tools = toolText(message.content);
    const big = line.length > INLINE_LINE;
    const data: Obj = {
      ...common,
      role,
      messageId: message.id,
      model: message.model,
      usage: isObj(message.usage) ? message.usage : undefined,
      blocks,
      isCompactSummary: o.isCompactSummary === true,
      ...(big ? { chars: line.length } : { message }),
    };
    // Subagent internals and injected meta messages are kept, not searched (the parser skipped them too).
    const body = isToolResult || side ? null : cap([text, tools, identifierParts([text, tools])].filter(Boolean).join("\n"));
    return {
      ...base,
      type: isToolResult ? "transcript.tool_result" : o.isCompactSummary === true ? "transcript.compaction" : "transcript.message",
      text: line1(text) || (blocks.find((b) => b.name) ? `${blocks.find((b) => b.name)!.name as string}` : null),
      body,
      data,
      content: big ? line : null,
    };
  }
  switch (type) {
    case "summary":
      return { ...base, type: "transcript.summary", text: line1(str(o.summary) ?? ""), body: str(o.summary) ?? null, data: { ...common, leafUuid: o.leafUuid } };
    case "ai-title":
    case "custom-title": {
      const title = str(o.aiTitle) ?? str(o.customTitle) ?? null;
      return { ...base, type: "transcript.title", text: title, body: title, data: { ...common, title, custom: type === "custom-title" } };
    }
    case "system":
      return { ...base, type: str(o.subtype) === "compact_boundary" ? "transcript.compaction" : "transcript.system", text: line1(str(o.content) ?? str(o.subtype) ?? ""), data: { ...common, subtype: o.subtype, compactMetadata: o.compactMetadata, logicalParentUuid: o.logicalParentUuid }, content: line.length > INLINE_LINE ? line : null };
    default:
      // Bookkeeping lines (attachment, permission-mode, file-history-snapshot, queue-operation, …): a row with its kind in `line`, bytes only when big.
      return { ...base, type: "transcript.other", text: null, data: { ...common, chars: line.length }, content: line.length > INLINE_LINE ? line : null };
  }
}

/** One Codex rollout line → an event. Codex has no per-line id: `codex:<session>:<n>`; tool calls pair by call_id in data. */
export function codexLine(line: string, n: number, file: TranscriptFile, state: { sessionId?: string; cwd?: string }): NewEvent | null {
  let o: Obj;
  try {
    o = JSON.parse(line) as Obj;
  } catch {
    return null;
  }
  if (!isObj(o)) return null;
  const payload = isObj(o.payload) ? o.payload : o;
  const outer = str(o.type) ?? "unknown";
  const inner = str(payload.type);
  if (inner && CODEX_NOISE.has(inner)) return null;
  if (outer === "session_meta") {
    state.sessionId = str(payload.id) ?? state.sessionId;
    state.cwd = str(payload.cwd) ?? state.cwd;
  }
  const at = o.timestamp ? Date.parse(String(o.timestamp)) : NaN;
  const sid = state.sessionId ?? file.path;
  const base: Omit<NewEvent, "type" | "data"> = {
    id: `codex:${sid}:${n}`,
    at: Number.isFinite(at) ? at : 0,
    source: "transcript:codex",
    sessionId: `codex:${sid}`,
    projectId: projectIdOf(state.cwd),
  };
  const big = line.length > INLINE_LINE;
  const common: Obj = { line: outer, item: inner, cwd: state.cwd, ...(big ? { chars: line.length } : { payload }) };
  let type: DataEventType = "transcript.other";
  let text: string | null = null;
  let body: string | null = null;
  if (inner === "user_message" || (inner === "message" && payload.role === "user")) {
    type = "transcript.message";
    const t = str(payload.message) ?? textOf(payload.content);
    if (inner === "message" && t.startsWith("<")) type = "transcript.other"; // environment context, not the person
    else (body = cap(`${t}\n${identifierParts([t])}`)), (text = line1(t));
  } else if (inner === "agent_message" || (inner === "message" && payload.role === "assistant")) {
    type = "transcript.message";
    const t = str(payload.message) ?? textOf(payload.content);
    body = cap(`${t}\n${identifierParts([t])}`);
    text = line1(t);
  } else if (inner === "function_call" || inner === "custom_tool_call" || inner === "local_shell_call") {
    type = "transcript.tool_use";
    let input: unknown = payload.arguments ?? payload.input ?? payload.action;
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {}
    }
    const t = describeToolInput(input);
    text = `${str(payload.name) ?? "shell"}${t ? `: ${line1(t)}` : ""}`;
    body = t ? cap(`${t}\n${identifierParts([t])}`) : null;
    common.callId = payload.call_id;
  } else if (inner === "function_call_output" || inner === "custom_tool_call_output") {
    type = "transcript.tool_result";
    common.callId = payload.call_id;
  } else if (outer === "compacted" || inner === "compacted") type = "transcript.compaction";
  else if (outer === "session_meta") type = "transcript.session";
  return { ...base, type, text, body, data: { ...common, role: payload.role }, content: big ? line : null };
}

/**
 * A session read whole through its parser (agents without line-by-line
 * readers: Copilot, unknown formats): its prompts, answers and tool calls as
 * events, ids from their position so re-reading changes nothing.
 */
export function docEvents(doc: SessionDocument, file: TranscriptFile, mtime: number): NewEvent[] {
  const agent = doc.agent;
  const sid = `${agent}:${doc.id}`;
  const at = doc.startedAt ?? mtime;
  const base = { source: `transcript:${agent}`, sessionId: sid, projectId: projectIdOf(doc.cwd) };
  const out: NewEvent[] = [];
  const common = { cwd: doc.cwd, gitBranch: doc.branch, whole: true };
  doc.prompts.forEach((p, i) => out.push({ ...base, id: `${sid}:p${i}`, at, type: "transcript.message", text: line1(p), body: cap(`${p}\n${identifierParts([p])}`), data: { ...common, role: "user", message: { role: "user", content: p } } }));
  doc.responses.forEach((r, i) => out.push({ ...base, id: `${sid}:r${i}`, at, type: "transcript.message", text: line1(r), body: cap(`${r}\n${identifierParts([r])}`), data: { ...common, role: "assistant", message: { role: "assistant", content: r } } }));
  doc.tools.forEach((t, i) => out.push({ ...base, id: `${sid}:t${i}`, at, type: "transcript.tool_use", text: line1(t), body: cap(`${t}\n${identifierParts([t])}`), data: { ...common, tool: t } }));
  if (doc.title) out.push({ ...base, id: `${sid}:title`, at, type: "transcript.title", text: line1(doc.title), body: doc.title, data: { ...common, title: doc.title } });
  if (doc.updatedAt) for (const e of out) e.until = doc.updatedAt;
  return out;
}

/** The agent whose file this is: the root's, else sniffed from the first lines. */
export function sniffAgent(path: string, sources: TranscriptSources): AgentKind | null {
  const head = headObjects(fileLines(path), 20);
  return sources.all().find((s) => s.sniff(head))?.agent ?? null;
}

/**
 * Reads a transcript from where the last read stopped and returns the events of
 * the complete lines since, with where to continue. A file that shrank (a
 * rewrite) is read from the start again; ids keep that idempotent.
 */
export function readTranscript(file: TranscriptFile, state: ReadState | null, sources: TranscriptSources, stat: { size: number; mtime: number }): ReadResult {
  let agent = file.agent ?? state?.agent ?? null;
  if (!agent) agent = sniffAgent(file.path, sources);
  const start = state && state.offset <= stat.size ? state.offset : 0;
  let lines = start ? (state?.lines ?? 0) : 0;
  const events: NewEvent[] = [];
  let sessionId: string | null = null;

  // Qwen's lines look like Claude's but carry Gemini-style parts: its parser reads the file whole.
  if (agent === "claude" || agent === "codex") {
    const codex: { sessionId?: string; cwd?: string } = {};
    const hint = agent !== "codex" ? file.path.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "") : undefined;
    // Codex's session id is on its first line: a resumed read needs it again.
    if (agent === "codex" && start) {
      const head = headObjects(fileLines(file.path), 1)[0];
      if (head && isObj(head.payload)) (codex.sessionId = str(head.payload.id)), (codex.cwd = str(head.payload.cwd));
    }
    let title: string | null = null;
    const offset = readLinesFrom(file.path, start, (line) => {
      lines++;
      const e = agent === "codex" ? codexLine(line, lines, file, codex) : claudeLine(line, lines, file, hint);
      if (!e) return;
      // Claude writes its title again and again, the same one: a row when it changes.
      if (e.type === "transcript.title") {
        if (e.text === title) return;
        title = e.text ?? null;
      }
      events.push(e), (sessionId = e.sessionId ?? sessionId);
    });
    datelessLines(events, stat.mtime);
    return { events, offset, lines, agent, sessionId };
  }
  // Whole-file parsers: Copilot, and anything sniffed as nothing cmd knows line by line.
  const root: TranscriptRoot = { agent, dir: "", env: file.env };
  const doc = sources.parse(root, fileLines(file.path), file.path);
  if (doc) events.push(...docEvents(doc, file, stat.mtime)), (sessionId = `${doc.agent}:${doc.id}`);
  return { events, offset: stat.size, lines: 0, agent: doc?.agent ?? agent, sessionId };
}

/**
 * Lines without a timestamp (Claude's titles and bookkeeping) take the time of
 * the line before them, else the one after, else the file's: at 0 they'd read as
 * 1970 and retention would drop them.
 */
function datelessLines(events: NewEvent[], mtime: number): void {
  let next = mtime;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.at) next = events[i]!.at;
    else events[i]!.at = -next; // marked: from the line after, unless one before has a time
  }
  let prev = 0;
  for (const e of events) {
    if (e.at > 0) prev = e.at;
    else e.at = prev || -e.at;
  }
}

/** One read buffer, reused for every transcript. */
const chunk = Buffer.allocUnsafe(1 << 20);

/** Calls `fn` for every complete line from `start`; returns the offset after the last complete line. */
function readLinesFrom(file: string, start: number, fn: (line: string) => void): number {
  const fd = fs.openSync(file, "r");
  try {
    const decoder = new StringDecoder("utf8");
    let rest = "";
    let pos = start;
    let consumed = start;
    for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, pos)) > 0; ) {
      pos += n;
      const text = rest + decoder.write(chunk.subarray(0, n));
      let from = 0;
      for (let i; (i = text.indexOf("\n", from)) >= 0; from = i + 1) {
        const line = text.slice(from, i);
        if (line.trim()) fn(line);
        consumed += Buffer.byteLength(line, "utf8") + 1;
      }
      rest = text.slice(from);
    }
    return consumed;
  } finally {
    fs.closeSync(fd);
  }
}

/** A transcript's lines on demand (sniffing, whole-file parsers). */
export function fileLines(file: string): TranscriptText {
  return (fn) => {
    const fd = fs.openSync(file, "r");
    try {
      const decoder = new StringDecoder("utf8");
      let rest = "";
      for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0; ) {
        const text = rest + decoder.write(chunk.subarray(0, n));
        let start = 0;
        for (let i; (i = text.indexOf("\n", start)) >= 0; start = i + 1) {
          if (fn(text.slice(start, i)) === false) return;
        }
        rest = text.slice(start);
      }
      rest += decoder.end();
      if (rest) fn(rest);
    } finally {
      fs.closeSync(fd);
    }
  };
}
