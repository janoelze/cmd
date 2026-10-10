import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@cmd/protocol";
import { definesIt, FileSearch, markMatches, nameScore } from "../src/search/files.ts";
import { DataService } from "../src/data/service.ts";
import { ViewsStore } from "../src/data/views/views.ts";
import { SessionsView } from "../src/data/views/sessions.ts";
import { SearchView } from "../src/data/views/search.ts";
import { commandBody, indexCommandOutput } from "../src/commands.ts";
import { inlinePacer } from "../src/scheduler.ts";

describe("file search", () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-files-"));
    const put = (rel: string, text: string) => (fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }), fs.writeFileSync(path.join(root, rel), text));
    put("src/search/query.ts", "export class SearchQuery {}\nconst stem = 1;\n");
    put("src/palette.tsx", "// the palette's search\nexport function Palette() {}\n");
    put("README.md", "# Search\nFind anything.\n");
    put(".env", "SEARCH_TOKEN=secret\n");
    put("private/notes.txt", "search notes\n");
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("finds names first, then lines, never secrets or excluded folders", async () => {
    const fsr = new FileSearch({ excluded: () => [path.join(root, "private")] });
    const hits = await fsr.search(root, "search");
    const names = hits.filter((h) => h.line === null).map((h) => path.relative(root, h.path));
    const lines = hits.filter((h) => h.line !== null).map((h) => `${path.relative(root, h.path)}:${h.line}`);
    expect(names).toContain("src/search/query.ts");
    expect(lines).toEqual(expect.arrayContaining(["README.md:1", "src/palette.tsx:1"]));
    expect(hits.some((h) => h.path.endsWith(".env") || h.path.includes("/private/"))).toBe(false);
    expect(hits.find((h) => h.path.endsWith("README.md"))!.text).toBe("# \x01Search\x02");
  });

  it("leaves out worktrees inside the folder: other checkouts of the same files", async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-files-wt-")));
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "a.txt"), "needle\n");
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "a");
    git("worktree", "add", "-q", "-b", "topic", path.join(repo, "trees", "topic"));
    try {
      const hits = await new FileSearch({ excluded: () => [] }).search(repo, "needle");
      expect(hits.filter((h) => h.line !== null).map((h) => path.relative(repo, h.path))).toEqual(["a.txt"]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("is case-sensitive only with capitals, and finds nothing for nothing", async () => {
    const fsr = new FileSearch({ excluded: () => [] });
    expect((await fsr.search(root, "SearchQuery")).some((h) => h.line === 1 && h.path.endsWith("query.ts"))).toBe(true);
    expect((await fsr.search(root, "SEARCHQUERY")).filter((h) => h.line !== null)).toEqual([]);
    expect(await fsr.search(root, "  ")).toEqual([]);
  });

  it("scores a name by its file's name before its folders", () => {
    expect(nameScore("src/search/query.ts", ["query"])).toBeGreaterThan(nameScore("src/query/search.ts", ["query"]));
    expect(nameScore("src/a.ts", ["query"])).toBe(0);
    expect(markMatches("Find it, find it", "find")).toBe("\x01Find\x02 it, \x01find\x02 it");
  });

  it("knows a line that defines what was typed, which comes first", async () => {
    expect(definesIt("export function useFind(f: Findable) {", "useFind")).toBe(true);
    expect(definesIt("const find = useFind(findable);", "useFind")).toBe(false);
    expect(definesIt('expect(definesIt("export function useFind", "useFind"))', "useFind")).toBe(false);
    expect(definesIt("pub(crate) fn search(q: &str)", "search")).toBe(true);
    expect(definesIt("## Search", "search")).toBe(true);
    const lines = (await new FileSearch({ excluded: () => [] }).search(root, "SearchQuery")).filter((h) => h.line !== null);
    expect(lines[0]!.path.endsWith("query.ts")).toBe(true);
  });
});

describe("history search", () => {
  const data = () => new DataService({ file: null, recordedBy: "test", settings: () => DEFAULT_SETTINGS });
  const command = (d: DataService, id: string, at: number, cmdline: string, output: string, exitCode = 0) =>
    d.record({ id: `command:${id}`, at, type: "command", source: "osc", paneId: "p1", workspaceId: "s1", text: cmdline, body: commandBody(cmdline, output), data: { command: cmdline, exitCode, cwd: "/tmp/proj", output: { chars: output.length, cut: false } }, content: output });

  it("finds commands by what they printed, one row per command line, and pages and files", async () => {
    const d = data();
    const now = Date.now();
    command(d, "1", now - 5000, "pnpm test", "FAIL packages/core/test/flaky.test.ts", 1);
    command(d, "2", now - 1000, "pnpm test", "FAIL packages/core/test/flaky.test.ts", 1);
    command(d, "3", now - 3000, "ls", "nothing here");
    d.record({ id: "visit:1", at: now - 2000, type: "browser.visit", source: "window", workspaceId: "s1", text: "Flaky tests in Vitest", body: "Flaky tests in Vitest", data: { url: "https://vitest.dev/flaky", title: "Flaky tests in Vitest" } });
    d.record({ id: "file:1", at: now - 2000, type: "file.open", source: "window", workspaceId: "s1", text: "/tmp/proj/flaky.md", data: { path: "/tmp/proj/flaky.md", windowKind: "text" } });
    const view = new SearchView(d, new SessionsView(new ViewsStore(null), d));
    const hits = await view.history("flaky", {}, now);
    const cmd = hits.find((h) => h.kind === "command");
    expect(cmd).toMatchObject({ command: "pnpm test", runs: 2, exitCode: 1, cwd: "/tmp/proj" });
    expect(cmd!.kind === "command" && cmd!.snippet).toContain("\x01flaky\x02");
    expect(hits.map((h) => h.kind).sort()).toEqual(["command", "file", "page"]);
    expect(await view.history("flaky", { workspaceId: "elsewhere" }, now)).toEqual([]);
  });

  it("makes older commands' output searchable once", async () => {
    const d = data();
    // As recorded before output was indexed: the line only.
    d.record({ id: "command:old", at: Date.now(), type: "command", source: "osc", text: "make", body: "make", data: { command: "make", exitCode: 2, cwd: "/tmp" }, content: "error: undefined symbol _frobnicate" });
    const view = new SearchView(d, new SessionsView(new ViewsStore(null), d));
    expect(await view.history("frobnicate")).toEqual([]);
    expect(await indexCommandOutput(d, inlinePacer)).toBe(1);
    expect((await view.history("frobnicate")).map((h) => h.kind)).toEqual(["command"]);
    expect(await indexCommandOutput(d, inlinePacer)).toBe(0);
  });
});
