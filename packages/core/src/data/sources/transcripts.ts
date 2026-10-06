// Agent transcripts as events (docs/28 §2, "Transcript messages"; requirement
// A6: cmd owns transcripts). One JSONL line of a Claude Code or Codex session
// becomes one `transcript.*` event: the agent's own ids kept verbatim
// (`claude:<uuid>`, parent = parentUuid; `codex:<session>:<n>`), the message
// normalised into a small `data` (role, blocks with tool ids, sizes), the words
// as `body` for search, and the verbatim line as the blob when it's big.
// Spike: used by the importer; phase 3 feeds the same function from a tailer.

import { parseClaude, parseCodex } from "../../search/parser.ts";
import type { DataEventType } from "@cmd/protocol";
import type { StoreEvent as NewEvent } from "../store.ts";
import { projectIdOf } from "../project.ts";

/** Lines shorter than this are kept whole in `data`; longer ones go to a blob with a summary inline. */
export const INLINE_LINE = 2048;
const TEXT_LINE = 300;

export interface TranscriptFile {
  agent: "claude" | "codex";
  path: string;
  /** The config dir it lives in (CLAUDE_CONFIG_DIR, CODEX_HOME), for resume env. */
  home?: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const line1 = (s: string) => (s.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, TEXT_LINE);

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

/**
 * One Claude Code line → an event, or null for lines that aren't part of the
 * record (progress noise). Every line type is kept as a kind of its own so a
 * reader can tell dialogue from compaction summaries and metadata.
 */
export function claudeLine(line: string, n: number, file: TranscriptFile, sessionHint?: string): NewEvent | null {
  let o: Obj;
  try {
    o = JSON.parse(line) as Obj;
  } catch {
    return null;
  }
  if (!isObj(o)) return null;
  const type = str(o.type) ?? "unknown";
  const uuid = str(o.uuid);
  const sessionId = str(o.sessionId) ?? sessionHint;
  const id = uuid ? `claude:${uuid}` : `claude:${sessionId ?? file.path}:${n}`;
  const at = o.timestamp ? Date.parse(String(o.timestamp)) : NaN;
  const base: Omit<NewEvent, "type" | "data"> = {
    id,
    at: Number.isFinite(at) ? at : 0,
    source: `transcript:claude${str(o.version) ? `@${o.version}` : ""}`,
    parentId: str(o.parentUuid) ? `claude:${o.parentUuid}` : null,
    sessionId: sessionId ? `claude:${sessionId}` : null,
    projectId: projectIdOf(str(o.cwd)),
  };
  const message = isObj(o.message) ? o.message : null;
  const common: Obj = { line: type, cwd: o.cwd, gitBranch: o.gitBranch, version: o.version, isSidechain: o.isSidechain === true, isMeta: o.isMeta === true };

  if (message && (type === "user" || type === "assistant")) {
    const role = str(message.role) ?? type;
    const text = textOf(message.content);
    const blocks = blocksOf(message.content);
    const isToolResult = blocks.some((b) => b.type === "tool_result") && !blocks.some((b) => b.type === "text");
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
    return {
      ...base,
      type: isToolResult ? "transcript.tool_result" : o.isCompactSummary === true ? "transcript.compaction" : "transcript.message",
      text: line1(text) || (blocks.find((b) => b.name) ? `${blocks.find((b) => b.name)!.name as string}` : null),
      body: isToolResult ? null : text,
      data,
      content: big ? line : null,
    };
  }
  switch (type) {
    case "summary":
      return { ...base, type: "transcript.summary", text: line1(str(o.summary) ?? ""), body: str(o.summary) ?? null, data: { ...common, leafUuid: o.leafUuid } };
    case "ai-title":
    case "custom-title":
      return { ...base, type: "transcript.title", text: str(o.aiTitle) ?? str(o.customTitle) ?? null, data: { ...common, title: o.aiTitle ?? o.customTitle } };
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
    body = str(payload.message) ?? textOf(payload.content);
    text = line1(body);
  } else if (inner === "agent_message" || (inner === "message" && payload.role === "assistant")) {
    type = "transcript.message";
    body = str(payload.message) ?? textOf(payload.content);
    text = line1(body);
  } else if (inner === "function_call" || inner === "custom_tool_call" || inner === "local_shell_call") {
    type = "transcript.tool_use";
    text = `${str(payload.name) ?? "shell"}`;
    common.callId = payload.call_id;
  } else if (inner === "function_call_output" || inner === "custom_tool_call_output") {
    type = "transcript.tool_result";
    common.callId = payload.call_id;
  } else if (outer === "compacted" || inner === "compacted") type = "transcript.compaction";
  else if (outer === "session_meta") type = "transcript.session";
  else if (outer === "turn_context") type = "transcript.other";
  return { ...base, type, text, body, data: { ...common, role: payload.role }, content: big ? line : null };
}

/** Session rows (title, first prompt, span) the old index kept, from the same file, for the sessions view later. */
export function sessionSummary(text: string, file: TranscriptFile) {
  return file.agent === "claude" ? parseClaude(text, file.path) : parseCodex(text, file.path);
}
