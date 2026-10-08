import { describe, expect, it } from "vitest";
import { findLinks, logicalLine, type Row } from "../src/renderer/src/links.ts";

const targets = (s: string) => findLinks(s).map((l) => `${l.kind}:${l.target}`);
const text = (s: string) => findLinks(s).map((l) => s.slice(l.start, l.end));

describe("terminal links", () => {
  it("finds URLs and trims trailing punctuation", () => {
    expect(targets("see https://example.com/a?b=1, then")).toEqual(["url:https://example.com/a?b=1"]);
    expect(targets("(https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual(["url:https://en.wikipedia.org/wiki/Foo_(bar)"]);
    expect(targets('"http://localhost:5173/".')).toEqual(["url:http://localhost:5173/"]);
  });

  it("turns file URLs into paths", () => {
    expect(targets("file:///tmp/a%20b.txt")).toEqual(["path:/tmp/a b.txt"]);
  });

  it("finds paths with positions, keeping the position in the range", () => {
    expect(targets("packages/core/src/core.ts:236:5: error")).toEqual(["path:packages/core/src/core.ts"]);
    expect(text("packages/core/src/core.ts:236:5: error")).toEqual(["packages/core/src/core.ts:236:5"]);
    expect(targets("src/a.ts(12,5): error TS2322")).toEqual(["path:src/a.ts"]);
    expect(targets("cd ~/src/cmd && ls ./docs ../x")).toEqual(["path:~/src/cmd", "path:./docs", "path:../x"]);
    expect(targets("M  README.md")).toEqual(["path:README.md"]);
    expect(targets("at /usr/lib/node.js:10")).toEqual(["path:/usr/lib/node.js"]);
  });

  it("skips things that only look like paths", () => {
    expect(targets("v1.2.3 on 10/04/2026, 3/4 done, and/or / . ..")).toEqual(["path:and/or"]);
    expect(targets("ratio 0.5, 1.25x")).toEqual([]); // name.ext candidates like e.g are dropped by the disk check
  });

  it("does not report a path inside a URL", () => {
    expect(targets("https://github.com/a/b.git")).toEqual(["url:https://github.com/a/b.git"]);
  });
});

// Rows as a terminal of `cols` columns holds them; a leading "+" marks a soft-wrapped row.
const screen = (cols: number, lines: string[]): Row[] =>
  lines.map((l, y) => {
    const text = l.replace(/^\+/, "").padEnd(cols);
    return { text, cells: [...text].map((_, x) => ({ x: x + 1, y: y + 1 })), wrapped: l.startsWith("+") };
  });
const urlsAt = (cols: number, lines: string[], at: number) =>
  findLinks(logicalLine(screen(cols, lines), at, cols).text.trimEnd()).filter((l) => l.kind === "url").map((l) => l.target);

describe("links across rows", () => {
  const url = "https://example.com/docs/some/really/long/path/that/goes/on/and/on/for/quite/a/while?q=1&x=two#frag";

  it("joins soft-wrapped rows", () => {
    const lines = ["  " + url.slice(0, 38), "+" + url.slice(38, 78), "+" + url.slice(78)];
    for (const at of [0, 1, 2]) expect(urlsAt(40, lines, at)).toEqual([url]);
  });

  it("joins a URL that Claude Code wrapped at the edge, from any of its rows", () => {
    // Captured from Claude Code at 70 columns: a reply, and the prompt broken after a slash.
    const reply = ["⏺ https://example.com/docs/some/really/long/path/that/goes/on/and/on/f", "  or/quite/a/while?q=1&x=two#frag", "✻ Baked for 1s"];
    for (const at of [0, 1]) expect(urlsAt(70, reply, at)).toEqual([url]);
    expect(urlsAt(70, reply, 2)).toEqual([]);
    const prompt = ["❯ Reply with only this URL, nothing else:", "  https://example.com/docs/some/really/long/path/that/goes/on/and/on/", "  for/quite/a/while?q=1&x=two#frag"];
    for (const at of [1, 2]) expect(urlsAt(70, prompt, at)).toEqual([url]);
  });

  it("follows a URL over several rows", () => {
    const lines = ["x " + url.slice(0, 18), "  " + url.slice(18, 36), "  " + url.slice(36, 54), "  " + url.slice(54, 72), "  " + url.slice(72)];
    for (const at of [0, 2, 4]) expect(urlsAt(20, lines, at)).toEqual([url]);
  });

  it("leaves rows alone that don't continue a URL", () => {
    // Ends short of the edge, after no break character.
    expect(urlsAt(70, ["see https://example.com/a", "and more"], 0)).toEqual(["https://example.com/a"]);
    expect(urlsAt(70, ["see https://example.com/a", "and more"], 1)).toEqual([]);
    // At the edge, but the URL ended earlier on the row.
    expect(urlsAt(30, ["https://example.com/a and then", "more"], 0)).toEqual(["https://example.com/a"]);
    // At the edge, but the next row starts with a symbol or deep indent.
    expect(urlsAt(25, ["x https://example.com/abcd", "⏺ next"], 0)).toEqual(["https://example.com/abcd"]);
    expect(urlsAt(25, ["x https://example.com/abcd", "            deep"], 0)).toEqual(["https://example.com/abcd"]);
    // Two lines that each hold their own link stay apart.
    expect(urlsAt(25, ["x https://example.com/abcd", "https://b.example/"], 1)).toEqual(["https://b.example/"]);
  });
});
