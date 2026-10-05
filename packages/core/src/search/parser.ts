// Reads coding agent transcripts (JSONL: Claude Code, Codex, Qwen Code, Copilot CLI)
// into searchable documents.
// Port of the ghostty-agents fork's TranscriptParser.swift.
//
// Only what a person would remember is kept: titles, prompts, replies and tool
// calls (commands, file paths, descriptions). Tool results and thinking are
// skipped; they are most of the bytes and mostly noise. Formats are internal to
// each tool and change between versions, so parsing is loose: every line is
// real JSON, roles are inferred from several places, and if the known layout
// yields nothing a generic walker still collects text. Bump PARSER_VERSION
// whenever the output changes; the index then re-reads every transcript.

import type { AgentKind } from "@cmd/protocol";

export const PARSER_VERSION = 2; // 2: Qwen, Copilot; absolute_path in tool inputs


export interface SessionDocument {
  id: string;
  agent: AgentKind;
  path: string;
  cwd?: string;
  branch?: string;
  title?: string;
  startedAt?: number;
  updatedAt?: number;
  prompts: string[];
  responses: string[];
  tools: string[];
}

/** Single texts are capped so a huge paste doesn't dominate the index. */
const MAX_TEXT = 20_000;
/** Lines longer than this are only parsed if they don't look like tool output. */
const LARGE_LINE = 200_000;
const TOOL_OUTPUT_MARKERS = ["tool_result", "function_call_output", "file-history"];

/**
 * A transcript's text, or its lines read from the file on demand (see fileLines
 * in index.ts): reading a large transcript whole leaves its size in memory the
 * process doesn't hand back. A reader calls `fn` per line, stopping when it returns false.
 */
export type TranscriptText = string | ((fn: (line: string) => boolean | void) => void);

export type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const cap = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

/**
 * The conversation in order, for readers that need it (session summaries):
 * the parsers append to it when given one. The index doesn't use it.
 */
export interface ConversationEntry {
  role: "user" | "assistant" | "tool";
  text: string;
  at?: number;
}

export function isEmpty(d: SessionDocument): boolean {
  return d.prompts.length === 0 && d.responses.length === 0;
}

function forEachLine(text: TranscriptText, fn: (line: string) => boolean | void): void {
  if (typeof text !== "string") return text(fn);
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    if (end > start && fn(text.slice(start, end)) === false) return;
    start = end + 1;
  }
}

/** Calls `fn` per JSON object line. */
function forEachObject(text: TranscriptText, fn: (o: Obj) => void): void {
  forEachLine(text, (line) => {
    if (!line || (line.length > LARGE_LINE && TOOL_OUTPUT_MARKERS.some((m) => line.includes(m)))) return;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      return; // partial or foreign line
    }
    if (isObj(o)) fn(o);
  });
}

/** The first `n` JSON objects of a transcript (within its first MB), for telling formats apart. */
export function headObjects(text: TranscriptText, n: number): Obj[] {
  const out: Obj[] = [];
  let read = 0;
  forEachLine(text, (line) => {
    read += line.length + 1;
    if (read > 1_000_000) return false;
    forEachObject(line, (o) => void out.push(o));
    return out.length < n;
  });
  return out;
}

function parseDate(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** Metadata both tools (and likely future versions) store under obvious names. */
function readCommonMetadata(o: Obj, doc: SessionDocument): void {
  if (doc.agent === "claude") {
    const id = str(o.sessionId) ?? str(o.session_id);
    if (id) doc.id = id;
  }
  const cwd = str(o.cwd);
  if (cwd) doc.cwd = cwd;
  const branch = str(o.gitBranch) ?? str(o.branch);
  if (branch && branch !== "HEAD") doc.branch = branch;
  const date = parseDate(o.timestamp ?? o.created_at);
  if (date !== undefined) {
    doc.startedAt ??= date;
    doc.updatedAt = date;
  }
}

/** Text of a message's content: a string, or its text blocks (text, input_text, output_text, …). */
function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((b): b is Obj => isObj(b) && typeof b.type === "string" && (b.type === "text" || b.type.endsWith("_text")))
    .map((b) => str(b.text))
    .filter((t): t is string => !!t);
  return texts.length ? texts.join("\n") : undefined;
}

/** The memorable parts of a tool call's input: what it ran, on which files, and why. */
function describeToolInput(input: unknown): string | undefined {
  if (!isObj(input)) return undefined;
  const keys = ["description", "command", "cmd", "file_path", "absolute_path", "notebook_path", "path", "pattern", "url", "query", "prompt", "skill"];
  const parts: string[] = [];
  for (const key of keys) {
    const v = input[key];
    if (Array.isArray(v)) {
      const last = v.at(-1);
      if (typeof last === "string") parts.push(last);
    } else if (typeof v === "string" && v) {
      // Subagent prompts can be long; their gist is in the first lines.
      parts.push(key === "prompt" ? v.slice(0, 400) : v);
    }
  }
  return parts.length ? parts.join(" ") : undefined;
}

const CLAUDE_WRAPPERS = [
  "system-reminder",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "command-message",
  "bash-stdout",
  "bash-stderr",
];

/** Strips what Claude Code wraps around prompts; slash-command markup becomes `/command args`. */
export function cleanClaudePrompt(text: string): string {
  let r = text;
  for (const tag of CLAUDE_WRAPPERS) r = r.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), " ");
  r = r.replace(/<\/?(command-name|command-args|bash-input)>/g, " ");
  if (r.startsWith("Caveat: The messages below")) return "";
  return r.trim();
}

export function parseClaude(text: TranscriptText, path: string, out?: ConversationEntry[]): SessionDocument | null {
  const doc: SessionDocument = {
    id: (path.split(/[\\/]/).pop() ?? "").replace(/\.jsonl$/, ""),
    agent: "claude",
    path,
    prompts: [],
    responses: [],
    tools: [],
  };
  let customTitle: string | undefined;

  forEachObject(text, (o) => {
    const type = str(o.type);
    if (type === "ai-title") {
      doc.title = str(o.aiTitle) ?? doc.title;
      return;
    }
    if (type === "custom-title") {
      customTitle = str(o.customTitle) ?? customTitle;
      return;
    }
    if (type === "summary") {
      if (!doc.title) doc.title = str(o.summary);
      return;
    }
    // Subagent internals and injected meta messages aren't part of the conversation.
    if (o.isSidechain === true || o.isMeta === true) return;
    readCommonMetadata(o, doc);

    const message = o.message;
    if (!isObj(message)) return;
    const role = str(message.role) ?? type;
    const content = message.content;
    const at = parseDate(o.timestamp);
    if (role === "user") {
      // Tool results come back as user messages; only text blocks are prompts.
      const t = textOf(content);
      const cleaned = t ? cleanClaudePrompt(t) : "";
      if (cleaned) doc.prompts.push(cap(cleaned)), out?.push({ role: "user", text: cleaned, at });
    } else if (role === "assistant") {
      if (typeof content === "string" && content) doc.responses.push(cap(content)), out?.push({ role: "assistant", text: content, at });
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!isObj(b)) continue;
          if (b.type === "text" && typeof b.text === "string" && b.text) doc.responses.push(cap(b.text)), out?.push({ role: "assistant", text: b.text, at });
          else if (b.type === "tool_use" || b.type === "server_tool_use") {
            const t = describeToolInput(b.input);
            if (t) doc.tools.push(cap(t)), out?.push({ role: "tool", text: `${str(b.name) ?? "tool"}: ${t}`, at });
          }
        }
      }
    }
  });

  if (customTitle) doc.title = customTitle;
  if (isEmpty(doc)) fallback(text, doc);
  return isEmpty(doc) ? null : doc;
}

export function parseCodex(text: TranscriptText, path: string, out?: ConversationEntry[]): SessionDocument | null {
  const doc: SessionDocument = { id: "", agent: "codex", path, prompts: [], responses: [], tools: [] };
  // Codex logs user text twice (as an event and as a model input item that also
  // carries environment context); prefer the events, fall back to the items.
  const itemPrompts: string[] = [];
  const itemResponses: string[] = [];
  // In file order; prompts and replies from the events, else (as above) from the items.
  const order: (ConversationEntry & { from: "event" | "item" })[] | null = out ? [] : null;

  forEachObject(text, (o) => {
    const payload = isObj(o.payload) ? o.payload : o;
    readCommonMetadata(o, doc);
    readCommonMetadata(payload, doc);
    const outer = str(o.type);
    const inner = str(payload.type);
    const at = parseDate(o.timestamp);
    if (outer === "session_meta") {
      const id = str(payload.id);
      if (id) doc.id = id;
      const git = payload.git;
      if (isObj(git) && str(git.branch)) doc.branch = str(git.branch);
      return;
    }
    switch (inner) {
      case "user_message": {
        const m = str(payload.message);
        if (m) doc.prompts.push(cap(m)), order?.push({ role: "user", text: m, at, from: "event" });
        break;
      }
      case "agent_message": {
        const m = str(payload.message);
        if (m) doc.responses.push(cap(m)), order?.push({ role: "assistant", text: m, at, from: "event" });
        break;
      }
      case "message": {
        const t = textOf(payload.content);
        if (!t) break;
        if (payload.role === "user") {
          if (!t.startsWith("<")) itemPrompts.push(cap(t)), order?.push({ role: "user", text: t, at, from: "item" });
        } else if (payload.role === "assistant") itemResponses.push(cap(t)), order?.push({ role: "assistant", text: t, at, from: "item" });
        break;
      }
      case "function_call":
      case "custom_tool_call":
      case "local_shell_call": {
        let input: unknown = payload.arguments ?? payload.input ?? payload.action;
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
          } catch {}
        }
        const t = describeToolInput(input);
        if (t) doc.tools.push(cap(t)), order?.push({ role: "tool", text: `${str(payload.name) ?? "shell"}: ${t}`, at, from: "event" });
        break;
      }
    }
  });

  if (out && order) {
    const fromEvents = new Set(order.filter((e) => e.from === "event").map((e) => e.role));
    for (const { from, ...e } of order) if ((from === "event") === fromEvents.has(e.role)) out.push(e);
  }
  if (doc.prompts.length === 0) doc.prompts = itemPrompts;
  if (doc.responses.length === 0) doc.responses = itemResponses;
  if (!doc.id) {
    // rollout-<date>-<uuid>.jsonl
    const name = (path.split(/[\\/]/).pop() ?? "").replace(/\.jsonl$/, "");
    doc.id = name.slice(-36);
  }
  if (isEmpty(doc)) fallback(text, doc);
  return isEmpty(doc) ? null : doc;
}

/** Text of Gemini-style parts ({text}, {thought, text}, {functionCall}, …), without thoughts. */
function partsText(parts: Obj[]): string | undefined {
  const t = parts
    .filter((p) => p.thought !== true)
    .map((p) => str(p.text))
    .filter((x): x is string => !!x)
    .join("\n");
  return t || undefined;
}

/**
 * Qwen Code: <home>/projects/<project>/chats/<session>.jsonl, Claude-like records
 * whose message is Gemini-style ({role, parts}). The prompt as the user typed it
 * is in systemPayload.displayText; titles are system records (custom_title).
 */
export function parseQwen(text: TranscriptText, path: string): SessionDocument | null {
  const doc: SessionDocument = { id: (path.split("/").pop() ?? "").replace(/\.jsonl$/, ""), agent: "qwen", path, prompts: [], responses: [], tools: [] };
  forEachObject(text, (o) => {
    if (o.isSidechain === true) return;
    const type = str(o.type);
    const payload = isObj(o.systemPayload) ? o.systemPayload : {};
    if (type === "system") {
      if (o.subtype === "custom_title") doc.title = str(payload.customTitle) ?? doc.title;
      return;
    }
    readCommonMetadata(o, doc);
    const id = str(o.sessionId);
    if (id) doc.id = id;
    const parts = isObj(o.message) && Array.isArray(o.message.parts) ? o.message.parts.filter(isObj) : [];
    if (type === "user" && (o.subtype === undefined || o.subtype === "mid_turn_user_message")) {
      const t = (str(payload.displayText) ?? partsText(parts))?.trim();
      if (t) doc.prompts.push(cap(t));
    } else if (type === "assistant") {
      const t = partsText(parts);
      if (t) doc.responses.push(cap(t));
      for (const p of parts) {
        const d = isObj(p.functionCall) ? describeToolInput(p.functionCall.args) : undefined;
        if (d) doc.tools.push(cap(d));
      }
    }
  });
  if (isEmpty(doc)) fallback(text, doc);
  return isEmpty(doc) ? null : doc;
}

/**
 * GitHub Copilot CLI: <home>/session-state/<session>/events.jsonl, one event per
 * line ({type, timestamp, data}): session.start (id, context.cwd/branch),
 * user.message, assistant.message (content, toolRequests).
 */
export function parseCopilot(text: TranscriptText, path: string): SessionDocument | null {
  const doc: SessionDocument = { id: path.split("/").at(-2) ?? "", agent: "copilot", path, prompts: [], responses: [], tools: [] };
  forEachObject(text, (o) => {
    const data = isObj(o.data) ? o.data : {};
    const date = parseDate(o.timestamp);
    if (date !== undefined) {
      doc.startedAt ??= date;
      doc.updatedAt = date;
    }
    switch (o.type) {
      case "session.start":
      case "session.context_changed": {
        const id = str(data.sessionId);
        if (id) doc.id = id;
        const ctx = isObj(data.context) ? data.context : data;
        if (str(ctx.cwd)) doc.cwd = str(ctx.cwd);
        if (str(ctx.branch)) doc.branch = str(ctx.branch);
        break;
      }
      case "session.title_changed":
        doc.title = str(data.title) ?? doc.title;
        break;
      case "user.message": {
        const t = str(data.content)?.trim();
        if (t) doc.prompts.push(cap(t));
        break;
      }
      case "assistant.message": {
        const t = str(data.content)?.trim();
        if (t) doc.responses.push(cap(t));
        for (const r of Array.isArray(data.toolRequests) ? data.toolRequests.filter(isObj) : []) {
          let input: unknown = r.arguments;
          if (typeof input === "string") {
            try {
              input = JSON.parse(input);
            } catch {}
          }
          const d = describeToolInput(input);
          if (d) doc.tools.push(cap(d));
        }
        break;
      }
    }
  });
  if (isEmpty(doc)) fallback(text, doc);
  return isEmpty(doc) ? null : doc;
}

/**
 * Used when the known layout yields nothing (e.g. a format change): collects strings
 * under text-like keys anywhere, skipping subtrees with tool output or internal state.
 */
function fallback(text: TranscriptText, doc: SessionDocument): void {
  const textKeys = new Set(["text", "message", "prompt", "content", "aiTitle", "summary"]);
  const skipKeys = new Set([
    "toolUseResult",
    "tool_result",
    "output",
    "result",
    "results",
    "snapshot",
    "thinking",
    "signature",
    "encrypted_content",
    "attachment",
    "base_instructions",
    "instructions",
  ]);
  const texts: string[] = [];
  const walk = (v: unknown, key: string | null) => {
    if (key && skipKeys.has(key)) return;
    if (Array.isArray(v)) for (const c of v) walk(c, key);
    else if (isObj(v)) {
      if (v.type === "tool_result") return;
      for (const [k, c] of Object.entries(v)) walk(c, k);
    } else if (typeof v === "string" && key && textKeys.has(key) && v.length >= 2 && !v.startsWith("{")) {
      texts.push(cap(v));
    }
  };
  forEachObject(text, (o) => walk(o, null));
  if (texts.length === 0) return;
  doc.prompts = [texts[0]!];
  doc.responses = texts.slice(1);
}
