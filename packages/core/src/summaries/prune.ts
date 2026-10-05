// Fitting a session into a summary call (docs/20-session-summaries.md): masks
// secrets, then shortens the conversation until it fits a character budget.
// Pure and deterministic, so the cuts are testable and the same session always
// sends the same text.
//
// What a summary needs is what the user asked and what the agent concluded, so
// cuts go in this order: pasted blocks inside a message (logs, diffs, code)
// first, then long runs of tool calls, then the middle of old replies, then
// whole old replies and tool calls. Prompts are kept longest and dropped last;
// the latest messages are cut least, since they hold the outcome.

import type { ConversationEntry } from "../search/parser.ts";

export interface Pruned {
  entries: ConversationEntry[];
  /** Characters before and after. */
  before: number;
  after: number;
  /** Messages left out whole (in "[… N messages left out …]" markers). */
  omitted: number;
}

/** The latest messages, cut least. */
const RECENT = 8;

/** Caps per pass for messages before the recent ones; the recent ones get the first pass's. */
const PASSES: { user: number; assistant: number; tool: number; block: number; toolRun: number }[] = [
  { user: 6000, assistant: 4000, tool: 240, block: 40, toolRun: 12 },
  { user: 3000, assistant: 1500, tool: 160, block: 16, toolRun: 6 },
  { user: 2000, assistant: 600, tool: 120, block: 8, toolRun: 3 },
  { user: 1200, assistant: 300, tool: 100, block: 4, toolRun: 1 },
];

const fmt = (n: number) => n.toLocaleString("en-US");
const size = (es: ConversationEntry[]) => es.reduce((n, e) => n + e.text.length + 12, 0);

/**
 * `text` in at most about `max` characters: its start and end, cut at line
 * breaks where there are any near the cut, with a marker saying how much went.
 */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = (n: number) => `\n[… ${fmt(n)} characters cut …]\n`;
  const room = Math.max(0, max - 32);
  let head = text.slice(0, Math.round(room * 0.7));
  let tail = text.slice(text.length - (room - head.length));
  // Whole lines, unless that loses more than a fifth of what is kept.
  const nl = head.lastIndexOf("\n");
  if (nl > head.length * 0.8) head = head.slice(0, nl);
  const nl2 = tail.indexOf("\n");
  if (nl2 >= 0 && nl2 < tail.length * 0.2) tail = tail.slice(nl2 + 1);
  return head + marker(text.length - head.length - tail.length) + tail;
}

/**
 * Long pasted blocks shortened to their first and last lines: fenced code
 * (``` or ~~~), and runs of lines that look like output (logs, stack traces,
 * diffs, tables) rather than prose. `lines` is how many lines a block keeps.
 */
export function shrinkBlocks(text: string, lines: number): string {
  const keep = (block: string[]) => {
    if (block.length <= lines + 2) return block;
    const head = Math.ceil(lines * 0.6);
    const tail = lines - head;
    return [...block.slice(0, head), `[… ${fmt(block.length - lines)} lines cut …]`, ...block.slice(block.length - tail)];
  };
  const src = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const fence = /^\s*(```|~~~)/.exec(src[i]!);
    if (fence) {
      let j = i + 1;
      while (j < src.length && !src[j]!.trimStart().startsWith(fence[1]!)) j++;
      out.push(src[i]!, ...keep(src.slice(i + 1, j)));
      if (j < src.length) out.push(src[j]!);
      i = j + 1;
      continue;
    }
    // Output-like: a run of lines without sentence punctuation at the end, or
    // starting with diff, log or table markers.
    let j = i;
    while (j < src.length && looksLikeOutput(src[j]!)) j++;
    if (j - i > Math.max(lines * 2, 12)) {
      out.push(...keep(src.slice(i, j)));
      i = j;
    } else {
      out.push(...src.slice(i, Math.max(j, i + 1)));
      i = Math.max(j, i + 1);
    }
  }
  return out.join("\n");
}

function looksLikeOutput(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^([+\-@|>$#]|\s*at |\d{2}:\d{2}|\[|\{|\}|[A-Z]+:|[\w.-]+\.\w+:\d+)/.test(t)) return true;
  return !/[.!?:)"']$/.test(t) && !/^([-*]|\d+[.)])\s+\w/.test(t) && t.split(/\s+/).length < 14;
}

/** Runs of more than `max` tool calls in a row: the first and last ones, with a count between. */
function collapseToolRuns(es: ConversationEntry[], max: number, from: number, to: number): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  let i = 0;
  while (i < es.length) {
    if (es[i]!.role !== "tool" || i < from || i >= to) {
      out.push(es[i++]!);
      continue;
    }
    let j = i;
    while (j < es.length && j < to && es[j]!.role === "tool") j++;
    // Repeats in a row (the same file read three times) count once.
    const run = es.slice(i, j).filter((e, k, a) => k === 0 || e.text !== a[k - 1]!.text);
    if (run.length > max) {
      const head = Math.ceil(max / 2);
      const tail = max - head;
      out.push(...run.slice(0, head), { role: "tool", text: `[… ${run.length - max} more tool calls …]` }, ...run.slice(run.length - tail));
    } else out.push(...run);
    i = j;
  }
  return out;
}

/** Applies a pass's caps to the messages before `to`. */
function capEntries(es: ConversationEntry[], pass: (typeof PASSES)[number], to: number): ConversationEntry[] {
  return es.map((e, i) => {
    if (i >= to) return e;
    const max = pass[e.role];
    const text = e.role === "tool" ? e.text : shrinkBlocks(e.text, pass.block);
    return text.length > max || text !== e.text ? { ...e, text: cut(text, max) } : e;
  });
}

const MARKER = 40; // "[… N messages left out …]" and its label

/**
 * Drops whole messages, oldest first after the first prompt (it says what the
 * session was for), until the conversation fits, sparing the last `keep`.
 * Tool calls go before replies, replies before prompts. Each run of dropped
 * messages leaves a marker, counted against the budget.
 */
function dropOld(es: ConversationEntry[], budget: number, keep: number): { entries: ConversationEntry[]; omitted: number } {
  const recent = Math.max(0, es.length - keep);
  const firstPrompt = es.findIndex((e) => e.role === "user");
  const drop = new Set<number>();
  let total = size(es);
  for (const role of ["tool", "assistant", "user"] as const) {
    for (let i = 0; i < recent && total > budget; i++) {
      if (es[i]!.role !== role || i === firstPrompt) continue;
      drop.add(i);
      total -= es[i]!.text.length + 12;
      // A new run costs a marker; joining a run on either side saves one.
      total += (drop.has(i - 1) ? 0 : MARKER) - (drop.has(i + 1) ? MARKER : 0);
    }
  }
  const out: ConversationEntry[] = [];
  let run = 0;
  es.forEach((e, i) => {
    if (drop.has(i)) return void run++;
    if (run) out.push({ role: "tool", text: `[… ${run} messages left out …]` }), (run = 0);
    out.push(e);
  });
  if (run) out.push({ role: "tool", text: `[… ${run} messages left out …]` });
  return { entries: out, omitted: drop.size };
}

/** The conversation within `budget` characters (counting a little per message for its label). */
export function prune(entries: ConversationEntry[], budget: number): Pruned {
  const before = size(entries);
  if (before <= budget) return { entries, before, after: before, omitted: 0 };
  // Over: every message gets the first pass (no single paste or reply needs more).
  let es = collapseToolRuns(capEntries(entries, PASSES[0]!, entries.length), PASSES[0]!.toolRun, 0, entries.length);
  for (const pass of PASSES.slice(1)) {
    if (size(es) <= budget) break;
    const recent = Math.max(0, es.length - RECENT);
    es = collapseToolRuns(capEntries(es, pass, recent), pass.toolRun, 0, recent);
  }
  let omitted = 0;
  const drop = (keep: number) => {
    const r = dropOld(es, budget, keep);
    es = r.entries;
    omitted += r.omitted;
  };
  if (size(es) > budget) drop(RECENT);
  // Still over (the recent messages alone are too long): cut them like the rest,
  // then drop all but the last if it must be.
  if (size(es) > budget) es = capEntries(es, PASSES.at(-1)!, es.length);
  if (size(es) > budget) drop(1);
  return { entries: es, before, after: size(es), omitted };
}

// ── secrets ──────────────────────────────────────────────

/** Credentials that turn up in transcripts (pasted env, config files, command lines). */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, // Anthropic, OpenAI
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/gi, // user:password@ in URLs
];

/** KEY=value and "key": "value" where the name says it's a secret. */
const NAMED_SECRET = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|credential|private[_-]?key|auth)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi;

/** `text` with likely credentials replaced by [redacted]. */
export function redact(text: string): string {
  let r = text;
  for (const p of SECRET_PATTERNS) r = r.replace(p, (m) => (m.includes("://") ? m.replace(/:[^:@/]+@$/, ":[redacted]@") : "[redacted]"));
  return r.replace(NAMED_SECRET, (m, name: string, sep: string, value: string) => (/^\[redacted\]$|^\$|^<|^process\.env/.test(value) ? m : `${name}${sep}[redacted]`));
}
