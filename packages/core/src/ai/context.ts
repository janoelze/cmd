// The context builder (docs/28 §6, D1): every model call that uses cmd's data
// assembles its input here. A request is named parts in order; each part is
// redacted, fitted into its share of a character budget (by weight, a part's
// own `fit` when it knows how to shorten itself, else cut in the middle), and
// the result says what went in: each part's size, what was cut, how much was
// redacted, the events it came from, and a hash. AiService records that with
// the call (ai.call), so a wrong day or summary can be traced to its input.

import { createHash } from "node:crypto";
import { redact } from "../redact.ts";

export interface ContextPart {
  /** What it is, for the record ("facts", "session", "day"). */
  name: string;
  /** The part as text; or `fit` makes it for a given size. */
  text?: string;
  /** Shortens the part to at most `max` characters its own way (a conversation drops old turns). */
  fit?: (max: number) => string;
  /** Its share of what's left after fixed parts (default 1). */
  weight?: number;
  /** Never cut (facts, instructions): counted first. */
  fixed?: boolean;
  /** Ids of the events it was made from (DataEvent.id), for the record. */
  events?: string[];
}

export interface ContextRequest {
  purpose: string;
  /** Characters for all parts together. */
  budget: number;
  parts: ContextPart[];
  /** Between parts (default a blank line). */
  separator?: string;
}

export interface PartRecord {
  name: string;
  chars: number;
  /** Characters the part had before it was fitted. */
  of: number;
  cut: boolean;
  redacted: number;
  events?: number;
}

/** What the model got, without the text itself (the text is the call's content). */
export interface ContextRecord {
  purpose: string;
  budget: number;
  chars: number;
  hash: string;
  parts: PartRecord[];
  events: string[];
}

export interface BuiltContext {
  text: string;
  record: ContextRecord;
}

const REDACTED = /\[redacted\]/g;
const count = (s: string) => (s.match(REDACTED) ?? []).length;

/** Cuts the middle out of text, keeping its start and end (where intent and results tend to be). */
export function cutMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < 40) return text.slice(0, max);
  const marker = `\n[… ${text.length - max} characters left out …]\n`;
  const keep = Math.max(0, max - marker.length);
  const head = Math.ceil(keep * 0.6);
  return text.slice(0, head) + marker + text.slice(text.length - (keep - head));
}

export function buildContext(r: ContextRequest): BuiltContext {
  const sep = r.separator ?? "\n\n";
  const records: PartRecord[] = [];
  const out: string[] = [];
  // Fixed parts first, then the rest share what's left by weight; a part that needs less gives its share back.
  const fixed = r.parts.map((p) => (p.fixed ? redact(p.text ?? p.fit?.(Number.MAX_SAFE_INTEGER) ?? "") : null));
  let left = r.budget - fixed.reduce((n, t) => n + (t?.length ?? 0), 0) - sep.length * Math.max(0, r.parts.length - 1);
  const flexible = r.parts.map((p, i) => ({ p, i })).filter(({ p }) => !p.fixed);
  const raw = new Map<number, string>();
  for (const { p, i } of flexible) if (p.text !== undefined) raw.set(i, redact(p.text));
  const share = new Map<number, number>();
  let pending = [...flexible];
  // Parts smaller than their share take only what they need; repeat until shares settle.
  for (let round = 0; round < 4 && pending.length; round++) {
    const total = pending.reduce((n, { p }) => n + (p.weight ?? 1), 0);
    const next: typeof pending = [];
    let used = 0;
    for (const x of pending) {
      const s = Math.floor((Math.max(0, left) * (x.p.weight ?? 1)) / total);
      const need = raw.get(x.i)?.length;
      if (need !== undefined && need <= s) share.set(x.i, need), (used += need);
      else next.push(x);
    }
    left -= used;
    if (next.length === pending.length) {
      for (const x of next) share.set(x.i, Math.floor((Math.max(0, left) * (x.p.weight ?? 1)) / total));
      pending = [];
    } else pending = next;
  }
  r.parts.forEach((p, i) => {
    let text: string;
    let of: number;
    if (p.fixed) (text = fixed[i]!), (of = text.length);
    else {
      const max = share.get(i) ?? 0;
      if (p.fit) {
        text = redact(p.fit(max));
        of = p.text?.length ?? text.length;
        if (text.length > max) text = cutMiddle(text, max);
      } else {
        const full = raw.get(i) ?? "";
        of = full.length;
        text = cutMiddle(full, max);
      }
    }
    if (text) out.push(text);
    records.push({ name: p.name, chars: text.length, of, cut: text.length < of, redacted: count(text), ...(p.events ? { events: p.events.length } : {}) });
  });
  const text = out.join(sep);
  const events = [...new Set(r.parts.flatMap((p) => p.events ?? []))];
  return { text, record: { purpose: r.purpose, budget: r.budget, chars: text.length, hash: createHash("sha256").update(text).digest("hex").slice(0, 16), parts: records, events } };
}
