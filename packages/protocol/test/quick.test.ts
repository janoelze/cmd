// The Quick Commands variable language (quick.ts): what counts as a variable, what is
// asked for, how values are quoted for a shell, an agent and a URL, and reading the file.
import { describe, expect, it } from "vitest";
import { editJsoncItem, fillQuick, parseQuick, quickEnv, quickId, quickMode, readQuickCommands, shellQuote } from "../src/index.ts";

describe("parseQuick", () => {
  it("finds variables and asks, each ask once", () => {
    const p = parseQuick("git push -u origin {{branch}} && echo {{ask:msg=hi}} {{pick:env=dev, prod}} {{ask:msg}}");
    expect(p.vars).toEqual(["branch"]);
    expect(p.asks).toEqual([
      { kind: "ask", name: "msg", default: "hi" },
      { kind: "pick", name: "env", options: ["dev", "prod"] },
    ]);
    expect(p.errors).toEqual([]);
  });

  it("leaves other templates as text and names typos", () => {
    const p = parseQuick(`docker ps --format '{{.Names}}' {{ json . }} {{fiel}} {{file | upper}}`);
    expect(p.vars).toEqual([]);
    expect(p.errors).toEqual(["{{fiel}}: no such variable", `{{file | upper}}: "upper" isn't raw or url`]);
    expect(fillQuick(p, "shell", {}).text).toBe(`docker ps --format '{{.Names}}' {{ json . }} {{fiel}} {{file | upper}}`);
  });

  it("wants asks named and picks with choices", () => {
    expect(parseQuick("{{ask:}} {{pick:x}}").errors).toEqual(["{{ask:}}: name what it asks for, {{ask:name}}", "{{pick:x}}: list the choices, {{pick:x=a,b}}"]);
  });
});

describe("fillQuick", () => {
  it("quotes values for a shell, so text can't run", () => {
    const p = parseQuick("cat {{file}} && grep {{selection}}");
    expect(fillQuick(p, "shell", { file: "/tmp/a b.txt", selection: "$(rm -rf ~)" }).text).toBe(`cat '/tmp/a b.txt' && grep '$(rm -rf ~)'`);
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("/plain/path-1.txt")).toBe("/plain/path-1.txt");
  });

  it("takes values as they are for an agent, or when raw", () => {
    const p = parseQuick("Review {{file}} {{selection | raw}}");
    expect(fillQuick(p, "text", { file: "/a b.ts", selection: "x" }).text).toBe("Review /a b.ts x");
    expect(fillQuick(p, "shell", { file: "/a b.ts", selection: "a b" }).text).toBe("Review '/a b.ts' a b");
  });

  it("encodes values in a URL", () => {
    const p = parseQuick("https://github.com/search?q={{selection}}&n={{ask:n=1}}");
    expect(fillQuick(p, "url", { selection: "a&b c" }, { n: "2" }).text).toBe("https://github.com/search?q=a%26b%20c&n=2");
  });

  it("names what is missing; optional ones go empty; asks take their default", () => {
    const p = parseQuick("x {{file}} {{selection?}} {{ask:a=d}} {{pick:p=one,two}}");
    expect(fillQuick(p, "shell", {})).toEqual({ text: null, missing: ["file"] });
    expect(fillQuick(p, "shell", { file: "f" }).text).toBe("x f  d one");
    expect(fillQuick(p, "shell", { file: "f" }, { a: "b c", p: "two" }).text).toBe("x f  'b c' two");
  });
});

describe("the rest", () => {
  it("picks the mode from the target", () => {
    expect(quickMode("type", "ls", false)).toBe("shell");
    expect(quickMode("type", "Review it", true)).toBe("text");
    expect(quickMode("open", "https://x.dev/{{ask:q}}", false)).toBe("url");
    expect(quickMode("open", "~/notes/{{date}}.md", false)).toBe("text");
  });

  it("gives a terminal run the values as environment", () => {
    expect(quickEnv(parseQuick("{{file}} {{ask:my service=api}}"), { file: "/a" })).toEqual({ CMD_QUICK_FILE: "/a", CMD_QUICK_MY_SERVICE: "api" });
  });

  it("makes ids from names", () => {
    expect(quickId("Push Branch!", [])).toBe("push-branch");
    expect(quickId("Push Branch", ["push-branch"])).toBe("push-branch-2");
  });

  it("reads the file's commands, keeping what it doesn't know and leaving out what isn't one", () => {
    const r = readQuickCommands([{ name: " A ", body: "a", later: 1 }, { name: "A", body: "b", keys: "Ctrl+A" }, { body: "x" }, { name: "B", body: "b", target: "nope" }]);
    expect(r.commands).toEqual([
      { id: "a", name: "A", body: "a", later: 1 },
      { id: "a-2", name: "A", body: "b", keys: ["Ctrl+A"] },
    ]);
    expect(r.errors).toEqual(['command 3: needs a "name"', 'B: "target" is one of type, terminal, open']);
  });

  it("edits one item of a list in its lines, keeping the others and the comments", () => {
    let t = `// header\n[\n  { "id": "a" }, // first\n  { "id": "b" }\n]\n`;
    t = editJsoncItem(t, -1, { id: "c" }, { insert: true });
    expect(t).toBe(`// header\n[\n  { "id": "a" }, // first\n  { "id": "b" },\n  {"id": "c"}\n]\n`);
    t = editJsoncItem(t, 0, { id: "z" }, { insert: true });
    t = editJsoncItem(t, 2, undefined);
    expect(t).toBe(`// header\n[\n  {"id": "z"},\n  { "id": "a" }, // first\n  {"id": "c"}\n]\n`);
    expect(editJsoncItem("", -1, { id: "q" }, { insert: true })).toBe(`[\n  {"id": "q"}\n]\n`);
  });
});
