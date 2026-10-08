import { describe, expect, it } from "vitest";
import { copyText, lineStarts, nodeAt, nodeOnLine, parseJson, pathOf, pointerOf, preview, valueOf, type JsonNode } from "../src/renderer/src/windows/json-parse.ts";

const parse = (s: string, f?: "json" | "jsonc" | "jsonl") => parseJson(s, f);
const root = (s: string, f?: "json" | "jsonc" | "jsonl") => {
  const r = parse(s, f);
  if (!r.root) throw new Error(r.error?.message);
  return r.root;
};

describe("JSON parse", () => {
  it("builds a tree that round-trips to the same value", () => {
    const docs = ['{"a":1,"b":[true,false,null,"x\\n\\u00e9"],"c":{"d":-1.5e3}}', "[]", "{}", '"s"', "0", '[[],[{}]]'];
    for (const d of docs) expect(valueOf(root(d))).toEqual(JSON.parse(d));
  });

  it("knows where every member starts: its key", () => {
    const src = '{\n  "name": "cmd",\n  "list": [\n    1,\n    2\n  ]\n}';
    const r = root(src);
    const [name, list] = r.children!;
    expect(src.slice(name!.from, name!.to)).toBe('"name": "cmd"');
    expect(src.slice(list!.children![1]!.from, list!.children![1]!.to)).toBe("2");
    const starts = lineStarts(src);
    expect(nodeOnLine(r, starts, 2)).toBe(name);
    expect(nodeOnLine(r, starts, 3)).toBe(list);
    expect(nodeOnLine(r, starts, 5)).toBe(list!.children![1]);
    expect(nodeOnLine(r, starts, 7)).toBe(r);
    expect(nodeOnLine(root('{"a":{"b":1}}'), lineStarts('{"a":{"b":1}}'), 1).key).toBe(null);
  });

  it("says what is wrong and where", () => {
    expect(parse('{\n  "a": 1,\n  "b" 2\n}').error).toMatchObject({ line: 3, column: 7, message: "Expected “:” after the key, found “2”" });
    expect(parse('{"a": [1, 2').error).toMatchObject({ message: "Expected “,” or “]”, found end of file" });
    expect(parse('{"a": 1,}').error?.message).toBe("Expected a key in quotes, found “}”");
    expect(parse("[1] x").error?.message).toBe("Unexpected “x” after the value");
    expect(parse('"abc').error?.message).toBe("String not closed");
    expect(parse("").error?.message).toBe("Unexpected end of file");
    expect(parse("[".repeat(5000)).error?.message).toBe("Nested too deeply");
  });

  it("reads JSONC: comments and trailing commas", () => {
    const src = '// settings\n{\n  "a": 1, /* one */\n  "b": [2, 3,],\n}';
    expect(valueOf(root(src, "jsonc"))).toEqual({ a: 1, b: [2, 3] });
    expect(parse(src).error).not.toBeNull();
  });

  it("reads JSON Lines: one value per line, bad lines kept as rows", () => {
    const src = '{"n":1}\n\n{"n":2}\n{"n":\n[3]\n';
    const r = parse(src, "jsonl");
    expect(r.invalid).toBe(1);
    const rows = r.root!.children!;
    expect(rows.map((c) => [c.key, c.line, c.type])).toEqual([[0, 1, "object"], [1, 3, "object"], [2, 4, "invalid"], [3, 5, "array"]]);
    expect(rows[2]).toMatchObject({ raw: '{"n":', error: "Unexpected end of file" });
    expect(nodeOnLine(r.root!, lineStarts(src), 3)).toBe(rows[1]);
    expect(parse("nope\n{", "jsonl")).toMatchObject({ root: null, invalid: 2, error: { line: 1 } });
  });

  it("names nodes by pointer and path, and finds them again", () => {
    const r = root('{"items":[{"name":"x"}],"a/b":{"~":1},"odd key":0}');
    const name = r.children![0]!.children![0]!.children![0]!;
    const tilde = r.children![1]!.children![0]!;
    expect(pointerOf(name)).toBe("/items/0/name");
    expect(pointerOf(tilde)).toBe("/a~1b/~0");
    expect(nodeAt(r, "/a~1b/~0")).toBe(tilde);
    expect(nodeAt(r, "/items/5")).toBeNull();
    expect(pathOf(name)).toBe("$.items[0].name");
    expect(pathOf(r.children![2]!)).toBe('$["odd key"]');
  });

  it("copies values and previews containers", () => {
    const r = root('{"s":"a\\"b","o":{"x":[1,2]},"n":1.50}');
    const [s, o, n] = r.children! as [JsonNode, JsonNode, JsonNode];
    expect(copyText(s)).toBe('a"b');
    expect(copyText(n)).toBe("1.50");
    expect(copyText(o)).toBe('{\n  "x": [\n    1,\n    2\n  ]\n}');
    expect(preview(r)).toBe('{ "s": "a\\"b", "o": {…}, "n": 1.50 }');
    expect(preview(root("[" + "1,".repeat(100) + "1]"), 20)).toBe("[ 1, 1, 1, 1, 1, 1, 1, … ]");
  });

  it("parses a few MB quickly", () => {
    const big = JSON.stringify(Array.from({ length: 40000 }, (_, i) => ({ id: i, name: `item ${i}`, tags: ["a", "b"], ok: i % 2 === 0 })));
    const t = performance.now();
    const r = root(big);
    expect(r.children!.length).toBe(40000);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
