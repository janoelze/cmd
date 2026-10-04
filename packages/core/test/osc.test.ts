import { describe, expect, it } from "vitest";
import { OscScanner, stripAnsi } from "../src/osc.ts";

describe("OscScanner", () => {
  it("parses titles terminated by BEL and ST", () => {
    const s = new OscScanner();
    expect(s.feed("a\x1b]0;hello\x07b\x1b]2;world\x1b\\c")).toEqual([
      { type: "title", title: "hello" },
      { type: "title", title: "world" },
    ]);
  });

  it("handles sequences split across chunks", () => {
    const s = new OscScanner();
    expect(s.feed("\x1b")).toEqual([]);
    expect(s.feed("]7;file://host/Users/me/my%20dir")).toEqual([]);
    expect(s.feed("\x1b")).toEqual([]);
    expect(s.feed("\\")).toEqual([{ type: "cwd", cwd: "/Users/me/my dir" }]);
  });

  it("parses OSC 9 and 777 notifications, ignores OSC 9;4 progress", () => {
    const s = new OscScanner();
    expect(s.feed("\x1b]9;Claude needs you\x07\x1b]9;4;1;50\x07\x1b]777;notify;Codex;Turn done\x07")).toEqual([
      { type: "notify", title: "", body: "Claude needs you" },
      { type: "notify", title: "Codex", body: "Turn done" },
    ]);
  });

  it("parses cmd shell-integration requests, keeping ; in the argument", () => {
    expect(new OscScanner().feed("\x1b]777;cmd;tok123;open;/tmp/a;b\x07")).toEqual([
      { type: "request", token: "tok123", action: "open", arg: "/tmp/a;b" },
    ]);
  });

  it("ignores CSI sequences", () => {
    expect(new OscScanner().feed("\x1b[31mred\x1b[0m")).toEqual([]);
  });

  it("reports bells, but not the BEL that ends an OSC or sits in a DCS string", () => {
    const s = new OscScanner();
    expect(s.feed("done\x07 \x1b]0;t\x07 \x1bPq\x07data\x1b\\ \x07")).toEqual([
      { type: "bell" },
      { type: "title", title: "t" },
      { type: "bell" },
    ]);
  });

  it("parses kitty OSC 99 notifications, across chunks and in base64", () => {
    const s = new OscScanner();
    expect(s.feed("\x1b]99;i=1:d=0;Build\x1b\\")).toEqual([]);
    expect(s.feed("\x1b]99;i=1:p=body;All 42 tests passed\x1b\\")).toEqual([
      { type: "notify", title: "Build", body: "All 42 tests passed" },
    ]);
    const b64 = Buffer.from("héllo").toString("base64");
    expect(s.feed(`\x1b]99;e=1;${b64}\x07`)).toEqual([{ type: "notify", title: "héllo", body: "" }]);
    expect(s.feed("\x1b]99;p=?;\x07")).toEqual([]); // capability query
  });

  it("reads the exit code from OSC 133;D", () => {
    expect(new OscScanner().feed("\x1b]133;C\x07\x1b]133;D;2\x07\x1b]133;D\x07")).toEqual([
      { type: "prompt", mark: "C" },
      { type: "prompt", mark: "D", exitCode: 2 },
      { type: "prompt", mark: "D" },
    ]);
  });
});

describe("stripAnsi", () => {
  it("removes colors, OSC and carriage returns", () => {
    expect(stripAnsi("\x1b]0;t\x07\x1b[1;32mok\x1b[0m\r\nnext")).toBe("ok\nnext");
  });
});

describe("device attribute queries", () => {
  const queries = (...chunks: string[]) => {
    const s = new OscScanner();
    return chunks.flatMap((c) => s.feed(c)).filter((e) => e.type === "query").map((e) => (e.type === "query" ? e.query : ""));
  };

  it("finds primary and secondary queries, also split across chunks", () => {
    expect(queries("\x1b[c", "x\x1b[0c", "\x1b[>c\x1b[>0c")).toEqual(["da1", "da1", "da2", "da2"]);
    expect(queries("\x1b", "[", ">", "0", "c")).toEqual(["da2"]);
  });

  it("ignores other CSI sequences and queries inside strings", () => {
    expect(queries("\x1b[1;31mred\x1b[0m\x1b[=c\x1b[?1c\x1b[2J")).toEqual([]);
    expect(queries("\x1b]0;\x1b[c\x07", "\x1bPtmux;\x1b[c\x1b\\")).toEqual([]);
  });

  it("still sees bells and OSC after CSI", () => {
    const s = new OscScanner();
    expect(s.feed("\x1b[1m\x07\x1b]2;t\x07").map((e) => e.type)).toEqual(["bell", "title"]);
  });
});
