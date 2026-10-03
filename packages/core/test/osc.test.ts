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
});

describe("stripAnsi", () => {
  it("removes colors, OSC and carriage returns", () => {
    expect(stripAnsi("\x1b]0;t\x07\x1b[1;32mok\x1b[0m\r\nnext")).toBe("ok\nnext");
  });
});
