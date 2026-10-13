import { describe, expect, it } from "vitest";
import { findLinks, lineLinks, logicalLine, pickPaths, type Row } from "../src/renderer/src/windows/terminal/links.ts";

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

describe("paths across rows", () => {
  const png = "/Users/me/src/cmd/apps/desktop/src/renderer/src/reference/fixtures/kinds/shot.png";
  // The paths the disk check finds, and the text of each link the terminal would show.
  const pathsAt = (cols: number, lines: string[], at: number, disk: string[]) => {
    const { paths } = lineLinks(screen(cols, lines), at, cols);
    return pickPaths(paths, paths.map((p) => (disk.includes(p.target) ? p.target : null))).map(({ link }) => link);
  };
  const targetsAt = (cols: number, lines: string[], at: number, disk: string[]) => pathsAt(cols, lines, at, disk).map((l) => l.target);

  it("joins a path Claude Code wrapped at the edge, from any of its rows", () => {
    // ⏺ Read(<path>) at 60 columns: hard-broken at the edge, continued under the text.
    const lines = ["⏺ Read(" + png.slice(0, 53), "  " + png.slice(53) + ")", "  ⎿  Read image (52.3KB)"];
    for (const at of [0, 1]) expect(targetsAt(60, lines, at, [png])).toEqual([png]);
    const [link] = pathsAt(60, lines, 1, [png]);
    expect([link!.start, link!.end]).toEqual([{ x: 8, y: 1 }, { x: 2 + png.length - 53, y: 2 }]);
    expect(targetsAt(60, lines, 2, [png])).toEqual([]);
  });

  it("follows a path over several rows, a few columns short of the edge or broken after a slash", () => {
    const lines = ["    ⎿  " + png.slice(0, 30), "       " + png.slice(30, 60), "       " + png.slice(60)];
    for (const at of [0, 1, 2]) expect(targetsAt(40, lines, at, [png])).toEqual([png]);
    const slash = png.lastIndexOf("/") + 1;
    expect(targetsAt(80, ["Saved to " + png.slice(0, slash), png.slice(slash)], 1, [png])).toEqual([png]);
  });

  it("keeps the rows' own paths when the joined one doesn't exist", () => {
    // Prose that happens to end in a path at the edge, and goes on below.
    const lines = ["see packages/core/src/a.ts", "and README.md"];
    expect(targetsAt(26, lines, 0, ["packages/core/src/a.ts", "README.md"])).toEqual(["packages/core/src/a.ts"]);
    expect(targetsAt(26, lines, 1, ["packages/core/src/a.ts", "README.md"])).toEqual(["README.md"]);
  });

  it("leaves rows alone that end far from the edge", () => {
    expect(targetsAt(80, ["/tmp/a", "b.png"], 0, ["/tmp/ab.png", "/tmp/a"])).toEqual(["/tmp/a"]);
  });
});
