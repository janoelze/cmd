// The developer loop's commands (docs/56 phase 3): `cmd widget new` writes a package that passes
// check and test at once; check types useConfig() through cmd-env.d.ts and names the line a
// renamed field breaks; `test` runs the package's own script; dev's lines; preview draws every
// theme and size and fails on what looks wrong; the help lists exactly the commands there are.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { previewPageBuilt, sandboxAvailable } from "@cmd/core/magic";
import { checkPackage, WIDGET_HELP, WIDGET_SUBS, widgetCommand } from "../src/widget.ts";
import { devLine } from "../src/widget-dev.ts";
import { idOf, templateFiles, titleOf } from "../src/widget-new.ts";

const MAIN = path.join(import.meta.dirname, "..", "src", "main.ts");
// check and preview sandbox TypeScript and Vitest as the core does; inside another sandbox (an agent's) they can't.
if (!sandboxAvailable()) process.env.CMD_MAGIC_UNSANDBOXED = "1";
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-widget-new-")));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** The CLI as a process in `cwd`: its code and output. */
function cli(args: string[], cwd: string): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(process.execPath, ["--no-warnings", MAIN, ...args], { cwd, stdio: "pipe", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, timeout: 120_000 });
    return { code: 0, out: out.toString(), err: "" };
  } catch (e) {
    const x = e as { status: number; stdout: Buffer; stderr: Buffer };
    return { code: x.status, out: x.stdout.toString(), err: x.stderr.toString() };
  }
}

async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(String(s)));
  const error = vi.spyOn(console, "error").mockImplementation((s: string) => void err.push(String(s)));
  const write = vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
  try {
    return { value: await fn(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
}

describe("cmd widget new", () => {
  it("names the package's files and fills in its name, title and id", () => {
    const files = templateFiles("ci-runs", 2026, "0.31.2");
    expect(Object.keys(files).sort()).toEqual([".gitignore", "AGENTS.md", "CLAUDE.md", "LICENSE", "README.md", "package.json", "src/ci-runs.story.tsx", "src/ci-runs.test.tsx", "src/ci-runs.tsx", "tsconfig.json"]);
    const pkg = JSON.parse(files["package.json"]!);
    expect(pkg).toMatchObject({ name: "ci-runs", engines: { cmd: ">=0.31" }, scripts: { test: "vitest run" }, cmd: { api: 1, widgets: [{ id: "ci-runs", title: "Ci Runs", main: "src/ci-runs.tsx" }] } });
    expect(files["src/ci-runs.test.tsx"]).toContain('from "./ci-runs.tsx"');
    expect(files["LICENSE"]).toContain("Copyright (c) 2026");
    expect(files["AGENTS.md"]).toBe(files["CLAUDE.md"]);
    expect(Object.values(files).join("")).not.toMatch(/__[A-Z]+__/);
    expect([titleOf("my.cool_widget"), idOf("my.cool_widget")]).toEqual(["My Cool Widget", "my-cool-widget"]);
  });

  it("CLAUDE.md points at the API reference and the window-design rules, from outside the repo", () => {
    const md = templateFiles("x")["CLAUDE.md"]!;
    expect(md).toContain("node_modules/@cmd/widget-api/README.md");
    expect(md).toContain("https://endtime-instruments.org/cmd/widgets/");
    expect(md).toContain("https://github.com/janoelze/cmd/blob/master/.claude/skills/window-design/SKILL.md");
  });

  it("writes a package that passes check and test at once; a renamed config field fails check at its line", async () => {
    const made = cli(["widget", "new", "demo"], scratch);
    expect(made.code, made.err).toBe(0);
    const dir = path.join(scratch, "demo");
    for (const f of ["package.json", "src/demo.tsx", "src/demo.test.tsx", "src/demo.story.tsx", "README.md", "LICENSE", "CLAUDE.md", "AGENTS.md", ".gitignore", "cmd-env.d.ts"]) expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    expect(fs.readFileSync(path.join(dir, "cmd-env.d.ts"), "utf8")).toContain("showFolders: boolean;");
    expect(fs.lstatSync(path.join(dir, "node_modules/@cmd/widget-api")).isSymbolicLink()).toBe(true);

    const check = await quiet(() => checkPackage(dir, false, "0.30.0"));
    expect(check.value, check.err).toBe(0);
    expect(check.out).toContain("demo 0.1.0 · API 1 · pkg:demo/demo · types");

    const tested = cli(["widget", "test"], dir);
    expect(tested.code, tested.out + tested.err).toBe(0);
    expect(tested.out).toMatch(/Tests\s+\d+ passed/);

    // package.json renames the field; the code still reads the old one.
    const pj = path.join(dir, "package.json");
    fs.writeFileSync(pj, fs.readFileSync(pj, "utf8").replace('"key": "showFolders"', '"key": "folders"'));
    const broken = await quiet(() => checkPackage(dir, false, "0.30.0"));
    expect(broken.value).toBe(2);
    expect(broken.err).toMatch(/src\/demo\.tsx\(\d+,\d+\): error TS2339: Property 'showFolders' does not exist on type 'WidgetConfig'/);
    expect(fs.readFileSync(path.join(dir, "cmd-env.d.ts"), "utf8")).toContain("folders: boolean;");
  });

  it("refuses a name that isn't a package's, and a folder that isn't empty", () => {
    expect(cli(["widget", "new", "My Widget"], scratch).err).toContain("can't be a package's name");
    fs.mkdirSync(path.join(scratch, "taken"));
    fs.writeFileSync(path.join(scratch, "taken", "x"), "");
    expect(cli(["widget", "new", "taken"], scratch).err).toContain("isn't empty");
  });
});

describe("cmd widget dev's lines", () => {
  it("says the status, the console, errors with the package's own frames, and each tree and patch", () => {
    const at = { windowId: "w-1" } as const;
    expect(devLine({ type: "widget.tree", ...at, message: { kind: "status", state: "running" } }, "Demo")).toBe("Demo running");
    expect(devLine({ type: "widget.tree", ...at, message: { kind: "status", state: "stopped", reason: "didn't load", detail: "SyntaxError · src/demo.tsx:3:1" } }, "Demo")).toContain("stopped · didn't load\n    SyntaxError · src/demo.tsx:3:1");
    expect(devLine({ type: "widget.tree", ...at, message: { kind: "patch", rev: 4, ops: [{ op: "text", id: 3, text: "x" }, { op: "text", id: 4, text: "y" }] } }, "Demo")).toContain("patch 4: text");
    expect(devLine({ type: "widget.log", ...at, level: "info", message: "hello" }, "Demo")).toContain("hello");
    const err = devLine({ type: "widget.log", ...at, level: "error", message: "boom", stack: "Error: boom\n at Terminals (file:///p/demo/src/demo.tsx:23:28)\n at renderWithHooks (file:///cmd/packages/widget-api/dist/deno/runtime.js:1:1)" }, "Demo", "/p/demo")!;
    expect(err).toContain("boom\n    at Terminals (src/demo.tsx:23:28)");
    expect(err).not.toContain("runtime.js");
    expect(devLine({ type: "window.removed", id: "w-1" }, "Demo")).toBeNull();
  });
});

describe("cmd widget preview", () => {
  it.skipIf(!previewPageBuilt())(
    "draws every state in every theme and size, and exits 2 on an empty state where the story gives data",
    () => {
      const dir = path.join(scratch, "shots");
      expect(cli(["widget", "new", "shots"], scratch).code).toBe(0);
      const ok = cli(["widget", "preview", ".", "--themes", "dark,light", "--sizes", "all"], dir);
      expect(ok.code, ok.out + ok.err).toBe(0);
      expect(ok.out).toContain("✓ Busy · narrow, regular, wide · 2 themes");
      expect(fs.readdirSync(path.join(dir, ".cmd-preview")).filter((f) => f.endsWith(".png"))).toHaveLength(4 * 3 * 2);
      // A widget that ignores its terminals: Busy has data and shows the empty state.
      const main = path.join(dir, "src/shots.tsx");
      fs.writeFileSync(main, fs.readFileSync(main, "utf8").replace("const terminals = useTerminals();", "const terminals = useTerminals().slice(0, 0);"));
      const bad = cli(["widget", "preview", "."], dir);
      expect(bad.code).toBe(2);
      expect(bad.out).toMatch(/✗ Busy[^\n]*\n\s+shows its empty state, though this state gives it data/);
      expect(bad.out).toContain("✓ Empty");
    },
    180_000,
  );
});

describe("cmd widget --help", () => {
  it("lists exactly the subcommands there are, and each one runs", async () => {
    const listed = [...WIDGET_HELP.matchAll(/cmd widget ([a-z]+)/g)].map((m) => m[1]);
    expect(new Set(listed)).toEqual(new Set(WIDGET_SUBS));
    const main = fs.readFileSync(MAIN, "utf8");
    expect(main).not.toMatch(/widget new\|check\|run\|preview/);
    // An unknown one is refused with the help.
    const r = await quiet(() => widgetCommand(["run"]));
    expect(r.value).toBe(1);
    expect(r.err).toContain("unknown: cmd widget run");
  });
});
