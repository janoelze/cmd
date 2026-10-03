// Reads Claude Code and Codex transcripts (JSONL) into searchable documents.
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

export const PARSER_VERSION = 1;


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

export type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const cap = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

export function isEmpty(d: SessionDocument): boolean {
  return d.prompts.length === 0 && d.responses.length === 0;
}

function forEachObject(text: string, fn: (o: Obj) => void): void {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    if (end > start) {
      const line = text.slice(start, end);
      if (!(line.length > LARGE_LINE && TOOL_OUTPUT_MARKERS.some((m) => line.includes(m)))) {
        try {
          const o = JSON.parse(line);
          if (isObj(o)) fn(o);
        } catch {
          // partial or foreign line
        }
      }
    }
    start = end + 1;
  }
}

/** The first `n` JSON objects of a transcript, for telling formats apart. */
export function headObjects(text: string, n: number): Obj[] {
  const out: Obj[] = [];
  const head = text.length > 1_000_000 ? text.slice(0, 1_000_000) : text;
  forEachObject(head, (o) => {
    if (out.length < n) out.push(o);
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
  const keys = ["description", "command", "cmd", "file_path", "notebook_path", "path", "pattern", "url", "query", "prompt", "skill"];
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

export function parseClaude(text: string, path: string): SessionDocument | null {
  const doc: SessionDocument = {
    id: (path.split("/").pop() ?? "").replace(/\.jsonl$/, ""),
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
    if (role === "user") {
      // Tool results come back as user messages; only text blocks are prompts.
      const t = textOf(content);
      const cleaned = t ? cleanClaudePrompt(t) : "";
      if (cleaned) doc.prompts.push(cap(cleaned));
    } else if (role === "assistant") {
      if (typeof content === "string" && content) doc.responses.push(cap(content));
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!isObj(b)) continue;
          if (b.type === "text" && typeof b.text === "string" && b.text) doc.responses.push(cap(b.text));
          else if (b.type === "tool_use" || b.type === "server_tool_use") {
            const t = describeToolInput(b.input);
            if (t) doc.tools.push(cap(t));
          }
        }
      }
    }
  });

  if (customTitle) doc.title = customTitle;
  if (isEmpty(doc)) fallback(text, doc);
  return isEmpty(doc) ? null : doc;
}

export function parseCodex(text: string, path: string): SessionDocument | null {
  const doc: SessionDocument = { id: "", agent: "codex", path, prompts: [], responses: [], tools: [] };
  // Codex logs user text twice (as an event and as a model input item that also
  // carries environment context); prefer the events, fall back to the items.
  const itemPrompts: string[] = [];
  const itemResponses: string[] = [];

  forEachObject(text, (o) => {
    const payload = isObj(o.payload) ? o.payload : o;
    readCommonMetadata(o, doc);
    readCommonMetadata(payload, doc);
    const outer = str(o.type);
    const inner = str(payload.type);
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
        if (m) doc.prompts.push(cap(m));
        break;
      }
      case "agent_message": {
        const m = str(payload.message);
        if (m) doc.responses.push(cap(m));
        break;
      }
      case "message": {
        const t = textOf(payload.content);
        if (!t) break;
        if (payload.role === "user") {
          if (!t.startsWith("<")) itemPrompts.push(cap(t));
        } else if (payload.role === "assistant") itemResponses.push(cap(t));
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
        if (t) doc.tools.push(cap(t));
        break;
      }
    }
  });

  if (doc.prompts.length === 0) doc.prompts = itemPrompts;
  if (doc.responses.length === 0) doc.responses = itemResponses;
  if (!doc.id) {
    // rollout-<date>-<uuid>.jsonl
    const name = (path.split("/").pop() ?? "").replace(/\.jsonl$/, "");
    doc.id = name.slice(-36);
  }
  if (isEmpty(doc)) fallback(text, doc);
  return isEmpty(doc) ? null : doc;
}

/**
 * Used when the known layout yields nothing (e.g. a format change): collects strings
 * under text-like keys anywhere, skipping subtrees with tool output or internal state.
 */
function fallback(text: string, doc: SessionDocument): void {
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
