import { describe, expect, it } from "vitest";
import { findLinks } from "../src/renderer/src/links.ts";

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
