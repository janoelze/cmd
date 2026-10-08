// JSON source → a tree of nodes that know where they are in the file (offsets),
// for the JSON window (json-view.tsx): ⌘E opens the editor at a row's line, and
// errors say where. JSONC (comments, trailing commas) and JSON Lines (one value
// per line; a bad line is a row of its own, not a failed file) parse here too.

export type JsonType = "object" | "array" | "string" | "number" | "boolean" | "null" | "invalid";

export interface JsonNode {
  /** Object member name, array index, or (JSON Lines) the line's index. null: the root. */
  key: string | number | null;
  type: JsonType;
  /** Scalars: the source text ("\"a\\nb\"", "12.5", "true"); invalid lines: the line. */
  raw?: string;
  /** Invalid lines: what's wrong. */
  error?: string;
  children?: JsonNode[];
  parent: JsonNode | null;
  /** Where the member starts (its key, else its value) and where the value ends. */
  from: number;
  to: number;
  /** JSON Lines: the line in the file (1-based) this value is on. */
  line?: number;
  /** JSON Lines' root: the file, not a value on a line. */
  virtual?: boolean;
  /** JSON pointer, made on first use (pointerOf). */
  ptr?: string;
}

export interface JsonError {
  message: string;
  offset: number;
  line: number;
  column: number;
}

export interface ParseResult {
  root: JsonNode | null;
  error: JsonError | null;
  /** JSON Lines: how many lines didn't parse. */
  invalid: number;
}

export type JsonFlavor = "json" | "jsonc" | "jsonl";

export function flavorOf(path: string): JsonFlavor {
  return /\.(jsonl|ndjson)$/i.test(path) ? "jsonl" : /\.jsonc$/i.test(path) ? "jsonc" : "json";
}

class Fail extends Error {
  at: number;
  constructor(message: string, at: number) {
    super(message);
    this.at = at;
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** One recursive-descent pass over `text` from `start` to `end`. */
class Parser {
  text: string;
  i: number;
  end: number;
  /** JSONC: comments and trailing commas. */
  loose: boolean;
  constructor(text: string, start: number, end: number, loose: boolean) {
    this.text = text;
    this.i = start;
    this.end = end;
    this.loose = loose;
  }

  fail(message: string, at = this.i): never {
    throw new Fail(message, at);
  }

  space(): void {
    const t = this.text;
    while (this.i < this.end) {
      const c = t.charCodeAt(this.i);
      if (c === 32 || c === 10 || c === 13 || c === 9) this.i++;
      else if (this.loose && c === 47 && t.charCodeAt(this.i + 1) === 47) {
        const nl = t.indexOf("\n", this.i);
        this.i = nl < 0 || nl > this.end ? this.end : nl;
      } else if (this.loose && c === 47 && t.charCodeAt(this.i + 1) === 42) {
        const close = t.indexOf("*/", this.i + 2);
        if (close < 0 || close >= this.end) this.fail("Comment not closed");
        this.i = close + 2;
      } else break;
    }
  }

  what(): string {
    if (this.i >= this.end) return "end of file";
    return `“${this.text[this.i]}”`;
  }

  string(): number {
    const t = this.text;
    const start = this.i++;
    while (this.i < this.end) {
      const c = t.charCodeAt(this.i);
      if (c === 34) return ++this.i, start;
      if (c === 92) this.i += 2;
      else if (c < 32) this.fail("Line break in a string");
      else this.i++;
    }
    return this.fail("String not closed", start);
  }

  value(key: string | number | null, from: number, parent: JsonNode | null, depth: number): JsonNode {
    if (depth > 2000) this.fail("Nested too deeply");
    this.space();
    const t = this.text;
    const at = this.i;
    const c = t.charCodeAt(at);
    if (c === 123 || c === 91) {
      const object = c === 123;
      const node: JsonNode = { key, type: object ? "object" : "array", children: [], parent, from: key === null ? at : from, to: at };
      const close = object ? 125 : 93;
      this.i++;
      this.space();
      if (t.charCodeAt(this.i) === close) return (node.to = ++this.i), node;
      for (let n = 0; ; n++) {
        this.space();
        if (this.loose && n > 0 && t.charCodeAt(this.i) === close) break;
        let k: string | number = n;
        const memberAt = this.i;
        if (object) {
          if (t.charCodeAt(this.i) !== 34) this.fail(`Expected a key in quotes, found ${this.what()}`);
          const s = this.string();
          k = decode(t.slice(s, this.i));
          this.space();
          if (t.charCodeAt(this.i) !== 58) this.fail(`Expected “:” after the key, found ${this.what()}`);
          this.i++;
        }
        node.children!.push(this.value(k, memberAt, node, depth + 1));
        this.space();
        const sep = t.charCodeAt(this.i);
        if (sep === 44) {
          this.i++;
          continue;
        }
        if (sep === close) break;
        this.fail(`Expected “,” or “${object ? "}" : "]"}”, found ${this.what()}`);
      }
      node.to = ++this.i;
      return node;
    }
    let type: JsonType;
    if (c === 34) (this.string(), (type = "string"));
    else if (t.startsWith("true", at)) ((this.i += 4), (type = "boolean"));
    else if (t.startsWith("false", at)) ((this.i += 5), (type = "boolean"));
    else if (t.startsWith("null", at)) ((this.i += 4), (type = "null"));
    else {
      NUMBER.lastIndex = at;
      if (!NUMBER.test(t) || NUMBER.lastIndex > this.end) this.fail(at >= this.end ? "Unexpected end of file" : `Unexpected ${this.what()}`);
      this.i = NUMBER.lastIndex;
      type = "number";
    }
    return { key, type, raw: t.slice(at, this.i), parent, from: key === null ? at : from, to: this.i };
  }

  document(): JsonNode {
    const root = this.value(null, 0, null, 0);
    this.space();
    if (this.i < this.end) this.fail(`Unexpected ${this.what()} after the value`);
    return root;
  }
}

function decode(quoted: string): string {
  return quoted.includes("\\") ? (JSON.parse(quoted) as string) : quoted.slice(1, -1);
}

/** Line starts of `text`, for offset → line/column (lineOf). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** 1-based line and column of an offset. */
export function lineOf(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo]! + 1 };
}

export function parseJson(text: string, flavor: JsonFlavor = "json", starts = lineStarts(text)): ParseResult {
  if (flavor === "jsonl") return parseLines(text, starts);
  const p = new Parser(text, 0, text.length, flavor === "jsonc");
  try {
    return { root: p.document(), error: null, invalid: 0 };
  } catch (e) {
    const at = e instanceof Fail ? e.at : p.i;
    const message = e instanceof Fail ? e.message : e instanceof RangeError ? "Nested too deeply" : (e as Error).message;
    return { root: null, error: { message, offset: at, ...lineOf(starts, at) }, invalid: 0 };
  }
}

/** JSON Lines: the file as an array of its lines' values; blank lines skipped, bad ones kept as "invalid" rows. */
function parseLines(text: string, starts: number[]): ParseResult {
  const root: JsonNode = { key: null, type: "array", children: [], parent: null, from: 0, to: text.length, virtual: true };
  let invalid = 0;
  let first: JsonError | null = null;
  for (let l = 0; l < starts.length; l++) {
    const from = starts[l]!;
    const end = l + 1 < starts.length ? starts[l + 1]! - 1 : text.length;
    if (!/\S/.test(text.slice(from, end))) continue;
    const key = root.children!.length;
    const p = new Parser(text, from, end, false);
    try {
      const v = p.value(key, from, root, 0);
      p.space();
      if (p.i < end) p.fail(`Unexpected ${p.what()} after the value`);
      v.line = l + 1;
      root.children!.push(v);
    } catch (e) {
      const at = e instanceof Fail ? e.at : from;
      const message = e instanceof Fail ? e.message : "Nested too deeply";
      invalid++;
      first ??= { message, offset: at, ...lineOf(starts, at) };
      root.children!.push({ key, type: "invalid", raw: text.slice(from, end).trim(), error: message, parent: root, from, to: end, line: l + 1 });
    }
  }
  // Nothing readable at all: an error, not a list of bad lines.
  if (invalid && invalid === root.children!.length) return { root: null, error: first, invalid };
  return { root, error: null, invalid };
}

const escapePtr = (k: string | number) => String(k).replace(/~/g, "~0").replace(/\//g, "~1");

/** The node's JSON pointer ("" for the root, "/items/3/name"). */
export function pointerOf(n: JsonNode): string {
  if (n.ptr !== undefined) return n.ptr;
  n.ptr = n.parent ? `${pointerOf(n.parent)}/${escapePtr(n.key!)}` : "";
  return n.ptr;
}

/** The node at a pointer, if the tree still has it. */
export function nodeAt(root: JsonNode, ptr: string): JsonNode | null {
  if (ptr === "") return root;
  let n: JsonNode | undefined = root;
  for (const part of ptr.slice(1).split("/")) {
    const k = part.replace(/~1/g, "/").replace(/~0/g, "~");
    n = n?.type === "array" ? n.children?.[Number(k)] : n?.children?.find((c) => c.key === k);
    if (!n) return null;
  }
  return n;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** A path to paste into code: $.items[3].name, $["odd key"]. */
export function pathOf(n: JsonNode): string {
  const parts: string[] = [];
  for (let c: JsonNode | null = n; c?.parent; c = c.parent) {
    parts.push(typeof c.key === "number" ? `[${c.key}]` : IDENT.test(c.key!) ? `.${c.key}` : `[${JSON.stringify(c.key)}]`);
  }
  return "$" + parts.reverse().join("");
}

/** The node as a JS value (comments and trailing commas gone). */
export function valueOf(n: JsonNode): unknown {
  if (n.type === "object") return Object.fromEntries(n.children!.map((c) => [c.key, valueOf(c)]));
  if (n.type === "array") return n.children!.map(valueOf);
  if (n.type === "invalid") return undefined;
  return JSON.parse(n.raw!);
}

/** What Copy Value puts on the clipboard: strings without quotes, containers as indented JSON. */
export function copyText(n: JsonNode): string {
  if (n.type === "invalid") return "";
  const v = valueOf(n);
  return typeof v === "string" ? v : n.children ? JSON.stringify(v, null, 2) : n.raw!;
}

/** A one-line glimpse of a collapsed container: { "name": "cmd", "version": "1.2", … }. */
export function preview(n: JsonNode, max = 120): string {
  const kids = n.children ?? [];
  const object = n.type === "object";
  let out = object ? "{ " : "[ ";
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i]!;
    const v = c.children ? (c.type === "object" ? (c.children.length ? "{…}" : "{}") : c.children.length ? "[…]" : "[]") : c.type === "invalid" ? "…" : c.raw!;
    const part = (object ? `${JSON.stringify(c.key)}: ` : "") + v;
    if (out.length + part.length > max) return out + (i ? ", … " : "… ") + (object ? "}" : "]");
    out += (i ? ", " : "") + part;
  }
  return kids.length ? out + (object ? " }" : " ]") : object ? "{}" : "[]";
}

/**
 * The node for a line (the editor's cursor line → the row to select): the
 * outermost one that starts there, else the deepest one around it.
 */
export function nodeOnLine(root: JsonNode, starts: number[], line: number): JsonNode {
  const from = starts[Math.max(0, Math.min(line, starts.length) - 1)] ?? 0;
  const to = line < starts.length ? starts[line]! - 1 : Infinity;
  let n = root;
  for (;;) {
    if (n.from >= from && !n.virtual) return n;
    const next: JsonNode | undefined = n.children?.find((c) => c.from <= to && c.to >= from);
    if (!next) return n;
    n = next;
  }
}
