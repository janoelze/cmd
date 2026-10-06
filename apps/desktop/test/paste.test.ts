import { describe, expect, it } from "vitest";
import { parseUriList, pasteRisk, preview, shellWord } from "../src/renderer/src/paste.ts";

describe("terminal paste", () => {
  it("lets single lines and bracketed pastes through", () => {
    expect(pasteRisk("ls -la", false)).toBeNull();
    expect(pasteRisk("a\nb\nc", true)).toBeNull();
  });

  it("flags line breaks without bracketed paste", () => {
    expect(pasteRisk("rm -rf build\n", false)).toMatch(/a line break/);
    expect(pasteRisk("a\r\nb\nc", false)).toMatch(/3 lines/);
  });

  it("flags text that would end a bracketed paste early", () => {
    expect(pasteRisk("x\x1b[201~rm -rf ~\n", true)).toMatch(/ends a paste/);
  });

  it("previews the first lines", () => {
    expect(preview("1\n2\n3\n4\n5\n6\n7\n8")).toBe("1\n2\n3\n4\n5\n6\n… 2 more lines");
  });
});

describe("dropped paths", () => {
  it("quotes only what needs it", () => {
    expect(shellWord("/Users/me/src/a-b_c.txt")).toBe("/Users/me/src/a-b_c.txt");
    expect(shellWord("/Users/me/My Files/x.txt")).toBe("/Users/me/My\\ Files/x.txt");
    expect(shellWord("/tmp/it's (1)")).toBe("/tmp/it\\'s\\ \\(1\\)");
    expect(shellWord("/tmp/$HOME*")).toBe("/tmp/\\$HOME\\*");
    expect(shellWord("/tmp/Übung")).toBe("/tmp/Übung");
    expect(shellWord("/tmp/two\nlines")).toBe("'/tmp/two\nlines'");
  });
});

describe("dropped links", () => {
  it("splits text/uri-list into file paths and other URLs", () => {
    const list = "# from a browser\r\nfile:///Users/me/My%20Files/a.png\r\nhttps://example.com/x?y=1\r\n\r\nfile:///tmp/%C3%9Cbung";
    expect(parseUriList(list)).toEqual({ files: ["/Users/me/My Files/a.png", "/tmp/Übung"], urls: ["https://example.com/x?y=1"] });
    expect(parseUriList("")).toEqual({ files: [], urls: [] });
  });
});
