// JSONC config files (settings.json, keybindings.json): parse them leniently and
// change one key at a time in the text, so comments, order and formatting survive.

import { applyEdits, findNodeAtLocation, modify, parse, parseTree, printParseErrorCode, stripComments, type ParseError } from "jsonc-parser";

const PROBLEMS: Record<string, string> = {
  InvalidSymbol: "unexpected character",
  InvalidNumberFormat: "malformed number",
  PropertyNameExpected: "expected a key in double quotes",
  ValueExpected: "expected a value",
  ColonExpected: "expected a colon",
  CommaExpected: "expected a comma",
  CloseBraceExpected: "expected a closing }",
  CloseBracketExpected: "expected a closing ]",
  EndOfFileExpected: "unexpected text after the end",
  InvalidCommentToken: "malformed comment",
  UnexpectedEndOfComment: "unclosed comment",
  UnexpectedEndOfString: "unclosed string",
  UnexpectedEndOfNumber: "unfinished number",
  InvalidUnicode: "malformed \\u escape",
  InvalidEscapeCharacter: "malformed \\ escape",
  InvalidCharacter: "control character in a string",
};

/** Lenient JSON: comments and trailing commas allowed. Throws on anything else, saying where. */
export function parseJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  const e = errors[0];
  if (!e) return value;
  const before = text.slice(0, e.offset).split("\n");
  const code = printParseErrorCode(e.error);
  throw new Error(`${PROBLEMS[code] ?? code} at line ${before.length}, column ${before.at(-1)!.length + 1}`);
}

/** A config file's object. Blank (or only comments) is an empty one; anything but an object throws. */
export function parseJsoncObject(text: string): Record<string, unknown> {
  if (!stripComments(text).trim()) return {};
  const v = parseJsonc(text);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected an object in { }");
  return v as Record<string, unknown>;
}

const MARK = "\u0000cmd-jsonc-value";

/**
 * text with each top-level key set to its value (undefined removes it); a blank
 * text starts from `base`. Everything else in the text stays as it was; new keys
 * go last. Values are written on one line (["Cmd+K", "Ctrl+K"]), as people do.
 */
export function editJsonc(text: string, changes: Record<string, unknown>, base = "{\n}\n"): string {
  if (!stripComments(text).trim()) text = base;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const formattingOptions = { insertSpaces: !/^\t/m.test(text), tabSize: 2, eol };
  for (const [key, value] of Object.entries(changes)) {
    const done = value === undefined ? remove(text, key) : append(text, key, oneLine(value), eol);
    if (done !== null) {
      text = done;
      continue;
    }
    const edits = modify(text, [key], value === undefined ? undefined : MARK, { formattingOptions });
    text = applyEdits(text, edits.map((e) => ({ ...e, content: e.content.replace(JSON.stringify(MARK), () => oneLine(value)) })));
  }
  return text;
}

/** value as one-line JSON text, spaced like hand-written JSON. */
function oneLine(value: unknown): string {
  // Raw newlines in JSON.stringify's output are all structure (strings escape theirs).
  return JSON.stringify(value, null, 1).replace(/([[{])\n *|\n *([\]}])|\n */g, (_m, open?: string, close?: string) => open ?? close ?? " ");
}

// modify() edits from the end of the value before, which moves or drops that
// line's comment ("a": 1, // why). append() and remove() work in whole lines
// instead, where the file has one key per line; null leaves it to modify().

/** A new key on its own line after the last one. */
function append(text: string, key: string, value: string, eol: string): string | null {
  const root = parseTree(text);
  const last = root?.type === "object" && !findNodeAtLocation(root, [key]) ? root.children?.at(-1) : undefined;
  if (!root || !last) return null;
  const end = last.offset + last.length;
  let lineEnd = text.indexOf("\n", end);
  if (lineEnd < 0 || lineEnd >= root.offset + root.length) return null; // the object closes on that line
  if (text[lineEnd - 1] === "\r") lineEnd--;
  const tail = text.slice(end, lineEnd);
  if (!/^\s*(,\s*)?(\/\/.*|(\/\*.*?\*\/\s*)*)$/.test(tail)) return null;
  const lineStart = text.lastIndexOf("\n", last.offset) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart))![0];
  const comma = /^\s*,/.test(tail); // trailing commas: the new last key gets one too
  return `${text.slice(0, end)}${comma ? "" : ","}${tail}${eol}${indent}${JSON.stringify(key)}: ${value}${comma ? "," : ""}${text.slice(lineEnd)}`;
}

/** key's line(s) gone, with the comment at their end. */
function remove(text: string, key: string): string | null {
  const root = parseTree(text);
  const prop = root?.type === "object" ? findNodeAtLocation(root, [key])?.parent : undefined;
  if (!root?.children || !prop) return null;
  const end = prop.offset + prop.length;
  const lineStart = text.lastIndexOf("\n", prop.offset - 1) + 1;
  const lineEnd = text.indexOf("\n", end);
  const tail = text.slice(end, lineEnd);
  if (text.slice(lineStart, prop.offset).trim() || lineEnd < 0 || !/^\s*(,\s*)?(\/\/.*)?$/.test(tail)) return null;
  let out = text.slice(0, lineStart) + text.slice(lineEnd + 1);
  const i = root.children.indexOf(prop);
  const prev = root.children[i - 1];
  if (prev && i === root.children.length - 1 && !/^\s*,/.test(tail)) {
    // It was the last key without a trailing comma; now the one before it is.
    const prevEnd = prev.offset + prev.length;
    const comma = /^\s*,/.exec(text.slice(prevEnd));
    if (comma) out = out.slice(0, prevEnd + comma[0].length - 1) + out.slice(prevEnd + comma[0].length);
  }
  return out;
}
