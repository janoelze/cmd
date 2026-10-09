// Live Code's edit marks (renderer editor/flash.ts): changes come in line by line,
// so only what changed moves and is marked.
import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { diffLines } from "../src/renderer/src/editor/flash.ts";

const apply = (old: string, next: string) => ChangeSet.of(diffLines(old, next).changes, old.length).apply(Text.of(old.split("\n"))).toString();

describe("diffLines", () => {
  const cases: [string, string, string][] = [
    ["a\nb\nc", "a\nB\nc", "one line changed"],
    ["a\nb\nc", "a\nb\nc\nd", "a line added at the end"],
    ["a\nb\nc", "x\na\nb\nc", "a line added at the start"],
    ["a\nb\nc", "a\nc", "a line removed"],
    ["a\nb\nc", "a\nb", "the last line removed"],
    ["a\nb\nc", "z", "everything replaced"],
    ["", "a\nb", "from empty"],
    ["a\nb\n", "a\nx\nb\n", "with a trailing newline"],
  ];
  for (const [old, next, what] of cases) it(`turns the text into the new one: ${what}`, () => expect(apply(old, next)).toBe(next));

  it("marks the changed lines, and the changed characters of a replaced line", () => {
    const old = 'stack(\n  s("hh*8"),\n  s("bd"),\n)';
    const next = 'stack(\n  s("hh*16"),\n  s("bd"),\n  s("cp"),\n)';
    const d = diffLines(old, next);
    expect(d.lines).toEqual([2, 4]);
    expect(d.spans.map((s) => next.slice(s.from, s.to))).toEqual(["16"]);
  });
});
