// The output contract of a Magic answer (docs/12-magic-windows.md): a JSON
// header line, a line `---`, then the raw body (HTML for widgets). The same on
// every backend; it streams, so the window can show the title as soon as the
// header line is complete and morph the HTML in as it arrives.

import { mediaOrigin } from "@cmd/protocol";
import { parseSource, type MagicSource } from "./sources.ts";

export interface MagicHeader {
  kind: "widget" | "terminal";
  title: string;
  /** 1–3 short lines shown while the body streams. */
  loading: string[];
  source: MagicSource | null;
  /** Seconds between refreshes; 0 = never. */
  refresh: number;
  size: "s" | "m" | "l" | "wide";
  /** Terminal kind: the command to offer. */
  command?: string;
  /** https origins the view plays audio/video or shows images from; the person allows them per window. */
  media?: string[];
}

export type ParsedAnswer =
  | { ok: true; header: MagicHeader; body: string }
  | { ok: false; error: string; header?: MagicHeader; body?: string };

/** Validate a header object from model output. */
export function parseHeader(v: unknown): MagicHeader | string {
  if (!v || typeof v !== "object") return "the header must be a JSON object";
  const h = v as Record<string, unknown>;
  if (h.kind !== "widget" && h.kind !== "terminal") return 'header.kind must be "widget" or "terminal"';
  if (typeof h.title !== "string" || !h.title.trim()) return "header.title is required";
  let source: MagicSource | null = null;
  if (h.source !== undefined && h.source !== null) {
    const s = parseSource(h.source);
    if (typeof s === "string") return `header.source: ${s}`;
    source = s;
  }
  if (h.kind === "terminal" && (typeof h.command !== "string" || !h.command.trim())) return "a terminal answer needs header.command";
  const refresh = typeof h.refresh === "number" && h.refresh >= 0 ? Math.max(h.refresh === 0 ? 0 : 1, Math.round(h.refresh)) : 0;
  const size = h.size === "s" || h.size === "m" || h.size === "l" || h.size === "wide" ? h.size : "m";
  const loading = Array.isArray(h.loading) ? h.loading.filter((x): x is string => typeof x === "string").slice(0, 3) : [];
  const header: MagicHeader = { kind: h.kind, title: h.title.trim().slice(0, 120), loading, source, refresh: source ? refresh : 0, size };
  if (h.kind === "terminal") header.command = (h.command as string).trim();
  if (h.media !== undefined) {
    if (!Array.isArray(h.media)) return "header.media must be a list of https origins";
    const bad = h.media.find((m) => !mediaOrigin(m) || !/^https:\/\//.test(String(m)));
    if (bad !== undefined) return `header.media: ${JSON.stringify(bad)} is not an https origin`;
    header.media = [...new Set(h.media.map((m) => mediaOrigin(m)!))].slice(0, 12);
  }
  return header;
}

/** Models sometimes fence the answer or the body: drop a leading and a trailing fence line. */
function stripFences(body: string): string {
  return body.trim().replace(/^```[\w-]*\n/, "").replace(/\n?```\s*$/, "").trim();
}

/** First line that parses as a JSON object with a `kind`: lets the model's stray preamble through. */
function findHeaderLine(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (!l.startsWith("{")) continue;
    try {
      const v = JSON.parse(l);
      if (v && typeof v === "object" && "kind" in v) return i;
    } catch {}
  }
  return -1;
}

/** Parse a complete answer. */
export function parseAnswer(text: string): ParsedAnswer {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const at = findHeaderLine(lines);
  if (at < 0) return { ok: false, error: "the answer must start with the JSON header line" };
  const header = parseHeader(JSON.parse(lines[at]!.trim()));
  if (typeof header === "string") return { ok: false, error: header };
  let rest = lines.slice(at + 1);
  while (rest.length && !rest[0]!.trim()) rest = rest.slice(1);
  if (rest.length && rest[0]!.trim() === "---") rest = rest.slice(1);
  const body = stripFences(rest.join("\n"));
  if (header.kind === "widget" && !body) return { ok: false, error: "a widget answer needs an HTML body after ---", header };
  return { ok: true, header, body };
}

/**
 * Incremental parser for the streamed answer: reports the header as soon as its
 * line is complete, then the body so far. Reset it when a new model step starts
 * (text before a tool call is preamble, not the answer).
 */
export class AnswerStream {
  text = "";
  header: MagicHeader | null = null;
  #bodyStart = -1;

  push(delta: string): { header?: MagicHeader; body?: string } {
    this.text += delta;
    const out: { header?: MagicHeader; body?: string } = {};
    if (!this.header) {
      const lines = this.text.split("\n");
      const complete = lines.slice(0, -1);
      const at = findHeaderLine(complete);
      if (at < 0) return out;
      const h = parseHeader(JSON.parse(complete[at]!.trim()));
      if (typeof h === "string") return out;
      this.header = out.header = h;
      this.#bodyStart = complete.slice(0, at + 1).join("\n").length + 1;
    }
    out.body = stripFences(this.text.slice(this.#bodyStart).replace(/^\s*---[ \t]*\n?/, ""));
    return out;
  }

  reset(): void {
    this.text = "";
    this.header = null;
    this.#bodyStart = -1;
  }
}
