// Workspace Actions (docs/39): what each source finds in a folder, the rules
// that classify actions, ranking from the command log, URLs in a dev server's
// output, and the core service: watching, runs in terminals, pins, the model's
// descriptions.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceAction } from "@cmd/protocol";
import { scan } from "../src/actions/catalog.ts";
import { classify } from "../src/actions/classify.ts";
import { matchAction, rank, scriptOf } from "../src/actions/history.ts";
import { applyDescribed, describe as describeActions, docCommands, type Described } from "../src/actions/describe.ts";
import { packageManager, parseJsonc, workspacePackages } from "../src/actions/sources.ts";
import { findUrl } from "../src/actions/service.ts";
import { Core } from "../src/core.ts";
import { fakeFactory, type FakePty } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-actions-")));
});
afterEach(() => rmTemp(dir));

function write(files: Record<string, string>, mode?: number): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text, mode ? { mode } : undefined);
  }
}

const byName = (actions: WorkspaceAction[]) => Object.fromEntries(actions.map((a) => [a.name, a]));

describe("sources", () => {
  it("package.json: the package manager's run, lifecycle scripts hidden, kinds from names and scripts", () => {
    write({ "package.json": JSON.stringify({ scripts: { dev: "vite", build: "vite build", test: "vitest run", pretest: "echo", postinstall: "node x.js", "db:reset": "prisma migrate reset", lint: "eslint ." } }, null, 2), "pnpm-lock.yaml": "" });
    const a = byName(scan(dir, null).actions);
    expect(a.dev).toMatchObject({ command: "pnpm run dev", kind: "dev", long: true, risky: false, source: { kind: "npm", file: "package.json", line: 3 } });
    expect(a.build).toMatchObject({ kind: "build", long: false });
    expect(a.test).toMatchObject({ kind: "test", long: false });
    expect(a.pretest!.hidden).toBe(true);
    expect(a.postinstall!.hidden).toBe(true);
    expect(a["db:reset"]).toMatchObject({ risky: true });
    expect(a.lint!.kind).toBe("check");
  });

  it("picks the package manager from the lockfile, then packageManager, then npm", () => {
    expect(packageManager(dir, dir)).toBe("npm");
    expect(packageManager(dir, dir, "pnpm@9.1.0")).toBe("pnpm");
    write({ "yarn.lock": "" });
    expect(packageManager(dir, dir, "pnpm@9.1.0")).toBe("yarn");
    write({ "bun.lock": "" });
    expect(packageManager(dir, dir)).toBe("bun");
  });

  it("monorepos: one section per workspace package, run in its folder", () => {
    write({
      "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - tools/cli\n",
      "pnpm-lock.yaml": "",
      "apps/web/package.json": JSON.stringify({ name: "@x/web", scripts: { dev: "next dev" } }),
      "apps/notapkg/readme.md": "",
      "tools/cli/package.json": JSON.stringify({ scripts: { build: "tsc" } }),
    });
    expect(workspacePackages(dir).map((p) => p.name)).toEqual(["@x/web", "cli"]);
    const actions = scan(dir, null).actions;
    const web = actions.find((a) => a.package === "@x/web")!;
    expect(web).toMatchObject({ name: "dev", command: "pnpm run dev", cwd: path.join(dir, "apps/web"), source: { file: "apps/web/package.json" } });
    expect(actions.filter((a) => !a.package).map((a) => a.name)).toEqual(["test"]);
  });

  it("Makefile: targets with their ## comments, not files, variables or pattern rules", () => {
    write({
      Makefile: [".PHONY: test dist/app", "VERSION := 1.0", "CC ?= cc", "", "# Build everything", "build: deps ## Compile it all", "\tcc main.c", "test:", "\t./run", "%.o: %.c", "main.o: main.c", "dist/app: build", "_private:", "all: build", "deploy: ## Ship it"].join("\n"),
    });
    const a = byName(scan(dir, null).actions);
    expect(Object.keys(a)).toEqual(["build", "test", "dist/app", "_private", "all", "deploy"]);
    expect(a.build).toMatchObject({ command: "make build", description: "Compile it all", describedBy: "author", source: { file: "Makefile", line: 6 } });
    expect(a.all!.command).toBe("make");
    expect(a._private!.hidden).toBe(true);
    expect(a.deploy).toMatchObject({ kind: "deploy", risky: true });
  });

  it("justfile: doc comments, groups, private recipes, parameters", () => {
    write({ justfile: ["set dotenv-load", "", "# Run the app", "dev:", "  cargo run", "", "[private]", "helper:", "  true", "", "_hidden:", "  true", "", "[doc('Ship a version')]", "release version:", "  ./release {{version}}", "", "fmt *args:", "  cargo fmt {{args}}", "alias t := test"].join("\n") });
    const a = byName(scan(dir, null).actions);
    expect(Object.keys(a)).toEqual(["dev", "release", "fmt"]);
    expect(a.dev).toMatchObject({ command: "just dev", description: "Run the app" });
    expect(a.release).toMatchObject({ description: "Ship a version", args: true, risky: true });
    expect(a.fmt!.args).toBeUndefined();
  });

  it("Taskfile, mise, deno, composer", () => {
    write({
      "Taskfile.yml": "version: '3'\ntasks:\n  build:\n    desc: Build it\n    cmds: [go build]\n  gen:\n    internal: true\n    cmds: [x]\n  lint: golangci-lint run\n",
      "mise.toml": '[tasks.serve]\nrun = "python -m http.server"\ndescription = "Serve the folder"\n[tasks.secret]\nrun = "x"\nhide = true\n',
      "deno.jsonc": '{\n  // tasks\n  "tasks": { "start": "deno run main.ts", "check": { "command": "deno check", "description": "Type-check" }, },\n}',
      "composer.json": JSON.stringify({ scripts: { test: "phpunit", "post-install-cmd": "x" }, "scripts-descriptions": { test: "Run PHPUnit" } }),
    });
    const all = scan(dir, null).actions;
    const ids = all.map((a) => a.id);
    expect(ids).toContain("task:Taskfile.yml:build");
    expect(ids).not.toContain("task:Taskfile.yml:gen");
    expect(all.find((a) => a.id === "task:Taskfile.yml:build")).toMatchObject({ command: "task build", description: "Build it" });
    expect(all.find((a) => a.id === "mise:mise.toml:serve")).toMatchObject({ command: "mise run serve", description: "Serve the folder", kind: "dev" });
    expect(ids).not.toContain("mise:mise.toml:secret");
    expect(all.find((a) => a.id === "deno:deno.jsonc:check")).toMatchObject({ command: "deno task check", description: "Type-check" });
    expect(all.find((a) => a.id === "composer:composer.json:test")).toMatchObject({ command: "composer run test", description: "Run PHPUnit" });
    expect(all.find((a) => a.id === "composer:composer.json:post-install-cmd")!.hidden).toBe(true);
  });

  it("pyproject: poe, pdm and entry points through uv", () => {
    write({ "pyproject.toml": '[project]\nname = "x"\n[project.scripts]\nmytool = "x.cli:main"\n[tool.poe.tasks]\ntest = "pytest"\nserve = { cmd = "uvicorn app:app", help = "Run the API" }\n[tool.pdm.scripts]\nlint = "ruff check ."\n', "uv.lock": "" });
    const a = byName(scan(dir, null).actions);
    expect(a.mytool!.command).toBe("uv run mytool");
    expect(a.test!.command).toBe("uv run poe test");
    expect(a.serve).toMatchObject({ description: "Run the API", long: true });
    expect(a.lint!.command).toBe("pdm run lint");
  });

  it("Cargo, Procfile, compose with ports, VS Code tasks, scripts/, manual GitHub workflows", () => {
    write({
      "Cargo.toml": '[package]\nname = "x"\n',
      "src/main.rs": "fn main() {}",
      ".cargo/config.toml": '[alias]\nxtask = "run --package xtask --"\n',
      Procfile: "web: bundle exec puma\nworker: sidekiq\n",
      "compose.yaml": "services:\n  api:\n    ports: ['8080:80']\n  db:\n    ports: [5432]\n",
      ".vscode/tasks.json": '{ "version": "2.0.0", "tasks": [ { "label": "serve docs", "type": "shell", "command": "mkdocs", "args": ["serve"], "isBackground": true }, { "label": "this file", "type": "shell", "command": "node ${file}" }, { "type": "npm", "script": "x" } ] }',
      ".github/workflows/deploy.yml": "name: Deploy\non:\n  workflow_dispatch:\n  push:\njobs: {}\n",
      ".github/workflows/ci.yml": "on: [push]\njobs: {}\n",
    });
    write({ "scripts/release.sh": "#!/bin/sh\n# Tag and push a release\nset -e\n" }, 0o755);
    write({ "scripts/notexec.sh": "#!/bin/sh\n" }, 0o644);
    const all = scan(dir, null).actions;
    const find = (id: string) => all.find((a) => a.id === id);
    expect(find("cargo:Cargo.toml:run")).toMatchObject({ command: "cargo run", describedBy: "cmd" });
    expect(find("cargo:.cargo/config.toml:xtask")!.command).toBe("cargo xtask");
    expect(find("procfile:Procfile:web")).toMatchObject({ command: "bundle exec puma", long: true });
    expect(find("compose:compose.yaml:up api")).toMatchObject({ command: "docker compose up api", url: "http://localhost:8080", long: true });
    expect(find("compose:compose.yaml:up db")!.url).toBeUndefined();
    expect(find("vscode:.vscode/tasks.json:serve docs")).toMatchObject({ command: "mkdocs serve", long: true });
    expect(all.some((a) => a.name === "this file")).toBe(false);
    expect(find("scripts:scripts/release.sh:release")).toMatchObject({ command: "./scripts/release.sh", description: "Tag and push a release", risky: true });
    expect(all.some((a) => a.name === "notexec")).toBe(false);
    expect(find("github:.github/workflows/deploy.yml:Deploy")).toMatchObject({ command: "gh workflow run deploy.yml", risky: true });
    expect(all.some((a) => a.source.file.endsWith("ci.yml"))).toBe(false);
  });

  it("agent skills and commands, each started by its agent", () => {
    write({
      ".claude/skills/triage/SKILL.md": "---\nname: triage\ndescription: Triage crash reports: group, claim, fix.\n---\n# Triage",
      ".claude/skills/internal/SKILL.md": "---\nname: internal\ndescription: x\nuser-invocable: false\n---\n",
      ".claude/commands/review.md": "---\ndescription: Review the diff\nargument-hint: [pr]\n---\nReview it",
      ".agents/skills/deploy-docs/SKILL.md": "---\nname: deploy-docs\ndescription: Publish the docs site\n---\n",
      ".gemini/commands/git/commit.toml": 'description = "Write a commit message"\nprompt = "…"\n',
      ".qwen/commands/plan.toml": 'prompt = "…"\n',
      ".github/skills/webapp-testing/SKILL.md": "---\nname: webapp-testing\ndescription: Test the web app\n---\n",
    });
    const all = scan(dir, null).actions.filter((a) => a.kind === "agent");
    expect(all.map((a) => [a.agent, a.name, a.command])).toEqual([
      ["claude", "/triage", "claude /triage"],
      ["claude", "/review", "claude /review"],
      ["codex", "$deploy-docs", "codex '$deploy-docs'"],
      ["gemini", "/git:commit", "gemini -i /git:commit"],
      ["qwen", "/plan", "qwen -i /plan"],
      ["copilot", "webapp-testing", "copilot -i 'Use the webapp-testing skill.'"],
    ]);
    // Not YAML (a colon in the value), read the way agents read it; a skill is never "risky" by its name.
    expect(all[0]).toMatchObject({ description: "Triage crash reports: group, claim, fix.", long: true, risky: false });
    expect(all.find((a) => a.name === "$deploy-docs")!.risky).toBe(false);
  });

  it("a file that can't be parsed keeps its last good actions and says so", () => {
    write({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
    const first = scan(dir, null);
    write({ "package.json": '{ "scripts": { "dev": "vite", ' });
    const next = scan(dir, first);
    expect(next.actions.map((a) => a.name)).toEqual(["dev"]);
    expect(next.errors).toEqual([{ file: "package.json", error: expect.any(String) }]);
  });

  it("watches the root and the sources' folders that exist", () => {
    write({ "scripts/x.sh": "", ".vscode/tasks.json": "{}" });
    expect(scan(dir, null).folders.sort()).toEqual([dir, path.join(dir, ".vscode"), path.join(dir, "scripts")].sort());
  });

  it("JSONC: comments and trailing commas, not inside strings", () => {
    expect(parseJsonc('{ "a": "http://x", /* c */ "b": [1, 2,], // d\n }')).toEqual({ a: "http://x", b: [1, 2] });
  });
});

describe("rules", () => {
  const c = (name: string, script = "") => classify({ name, command: `pnpm run ${name}`, script: script || undefined, cwd: "/", file: "package.json" });
  it("by name, then by what it runs", () => {
    expect(c("start", "node server.js")).toMatchObject({ kind: "dev", long: true });
    expect(c("test:watch", "vitest")).toMatchObject({ kind: "test", long: true });
    expect(c("storybook", "storybook dev -p 6006")).toMatchObject({ kind: "dev", long: true });
    expect(c("preview", "vite preview")).toMatchObject({ kind: "dev", long: true });
    expect(c("x", "vitest run")).toMatchObject({ kind: "test", long: false });
    expect(c("bundle", "vite build")).toMatchObject({ kind: "build", long: false });
    expect(c("ship", "npm publish")).toMatchObject({ kind: "deploy", risky: true });
    expect(c("push-images", "docker push x")).toMatchObject({ risky: true });
    expect(c("hello", "echo hi")).toMatchObject({ kind: "run", long: false, risky: false });
  });
});

describe("history", () => {
  it("knows which script a typed command runs", () => {
    expect(scriptOf("pnpm dev")).toBe("dev");
    expect(scriptOf("npm run  build")).toBe("build");
    expect(scriptOf("npm test")).toBe("test");
    expect(scriptOf("yarn e2e:web")).toBe("e2e:web");
    expect(scriptOf("pnpm install")).toBeNull();
    expect(scriptOf("npm dev")).toBeNull();
    expect(scriptOf("pnpm dev --port 3")).toBeNull();
  });

  it("ranks actions by decayed runs and offers habits no file names", () => {
    write({ "package.json": JSON.stringify({ scripts: { dev: "vite", test: "vitest", build: "vite build" } }), "pnpm-lock.yaml": "", Makefile: "deploy:\n" });
    const actions = scan(dir, null).actions;
    const now = Date.now();
    const day = 86400_000;
    const ran = [
      { command: "pnpm test", cwd: dir, at: now - day, exitCode: 0 },
      { command: "npm run test", cwd: dir, at: now - 2 * day, exitCode: 1 },
      { command: "pnpm dev", cwd: dir, at: now - 60 * day, exitCode: 0 },
      { command: "make deploy", cwd: dir, at: now, exitCode: 0 },
      ...[1, 2, 3].map((i) => ({ command: "docker compose up api", cwd: dir, at: now - i * day, exitCode: 0 })),
      ...[1, 2, 3].map((i) => ({ command: "./flaky.sh", cwd: dir, at: now - i * day, exitCode: 1 })),
      ...[1, 2, 3].map((i) => ({ command: "git status", cwd: dir, at: now - i * day, exitCode: 0 })),
      ...[1, 2, 3].map((i) => ({ command: "make other", cwd: "/elsewhere", at: now - i * day, exitCode: 0 })),
    ];
    const r = rank(actions, ran, dir, now);
    const use = (name: string) => r.use.get(actions.find((a) => a.name === name)!.id) ?? 0;
    expect(use("test")).toBeGreaterThan(1.5);
    expect(use("dev")).toBeLessThan(0.1);
    expect(use("deploy")).toBeCloseTo(1, 2);
    expect(use("build")).toBe(0);
    expect(r.history.map((h) => h.command)).toEqual(["docker compose up api"]);
    expect(r.history[0]).toMatchObject({ history: { runs: 3 }, cwd: dir, kind: "dev", long: true });
    expect(matchAction(actions, "pnpm run dev", path.join(dir, "sub"))).toBeNull();
  });
});

describe("URLs in output", () => {
  it("finds a dev server's address through colours and padding", () => {
    expect(findUrl("  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n")).toBe("http://localhost:5173/");
    expect(findUrl("- Local:        http://localhost:3000\n")).toBe("http://localhost:3000");
    expect(findUrl("Listening on http://0.0.0.0:8000.")).toBe("http://localhost:8000");
    expect(findUrl("see https://example.com")).toBeNull();
  });
});

describe("describing", () => {
  it("collects shell blocks from the docs under their headings", () => {
    write({ "README.md": "# X\n\n## Development\n\n```sh\npnpm dev\n```\n\n```js\nconst a = 1\n```\n\n```\n$ make db\n```\n" });
    const docs = docCommands(dir);
    expect(docs).toContain("README.md ## Development\npnpm dev");
    expect(docs).toContain("$ make db");
    expect(docs).not.toContain("const a");
  });

  it("asks the fast tier, keeps author words, never lowers risk", async () => {
    write({ "package.json": JSON.stringify({ scripts: { dev: "vite", release: "node scripts/release.mjs" }, "scripts-info": { dev: "The author's words" } }), "README.md": "```sh\ndocker compose up\npnpm dev\n```" });
    const actions = scan(dir, null).actions;
    const object = vi.fn(async (o: { prompt: string; tier: string }) => ({
      value: {
        actions: [
          { id: "npm:package.json:dev", description: "Start the dev server", kind: "dev", long: true, risky: false },
          { id: "npm:package.json:release", description: "Ship a signed release.", kind: "deploy", long: false, risky: false },
          { id: "npm:package.json:nope", description: "x", kind: "run", long: false, risky: false },
        ],
        primary: "npm:package.json:dev",
        suggested: [{ name: "compose", command: "docker compose up", description: "Start the services" }, { name: "dev", command: "pnpm run dev", description: "dup" }],
      },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      model: "fast",
    }));
    const d = await describeActions({ object: object as never }, dir, actions);
    expect(object.mock.calls[0]![0].tier).toBe("fast");
    expect(object.mock.calls[0]![0].prompt).toContain("docker compose up");
    expect(d.primary).toBe("npm:package.json:dev");
    expect(Object.keys(d.actions)).toEqual(["npm:package.json:dev", "npm:package.json:release"]);
    expect(d.suggested.map((s) => s.command)).toEqual(["docker compose up"]);
    const out = byName(applyDescribed(actions, d));
    expect(out.dev).toMatchObject({ description: "The author's words", describedBy: "author" });
    expect(out.release).toMatchObject({ description: "Ship a signed release", describedBy: "model", kind: "deploy", risky: true });
  });
});

describe("service", () => {
  let core: Core;
  let ptys: FakePty[];
  beforeEach(() => {
    const f = fakeFactory();
    ptys = f.ptys;
    core = new Core({ socketPath: "/tmp/cmd-test-actions.sock", dbPath: null, settingsPath: null, terminals: f.factory, pollMs: 0 });
  });
  afterEach(async () => {
    await core.close();
  });

  const list = () => core.handlers["actions.list"]({ path: dir }) as ReturnType<Core["actions"]["list"]>;

  it("lists a folder and tells when its files change", async () => {
    write({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
    expect(list().actions.map((a) => a.name)).toEqual(["dev"]);
    expect(list().primary).toBe("npm:package.json:dev");
    const changed = new Promise<string>((r) => core.actions.once("changed", r));
    write({ justfile: "test:\n  cargo test\n" });
    expect(await changed).toBe(dir);
    expect(list().actions.map((a) => a.name)).toEqual(["dev", "test"]);
  });

  it("runs an action in a new terminal, follows it to its exit status, and reuses that terminal", async () => {
    write({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
    const id = list().actions[0]!.id;
    const r = core.actions.run(dir, id, core.spaces.home().id);
    expect(r.started).toBe(true);
    const pty = ptys.at(-1)!;
    expect(pty.opts.cwd).toBe(dir);
    expect(list().runs).toMatchObject([{ actionId: id, paneId: r.paneId, endedAt: null }]);
    pty.output("\x1b]133;C\x07running\r\n\x1b]133;D;1\x07\x1b]133;A\x07");
    expect(list().runs[0]).toMatchObject({ exitCode: 1 });
    expect(list().runs[0]!.endedAt).not.toBeNull();
    const again = core.actions.run(dir, id, core.spaces.home().id);
    expect(again.paneId).toBe(r.paneId);
    expect(pty.written.at(-1)).toBe("npm run test\r");
  });

  it("a server: its URL from its output, not started twice, stopped with ⌃C, restarted", async () => {
    write({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
    const id = list().actions[0]!.id;
    const r = core.actions.run(dir, id, core.spaces.home().id);
    const pty = ptys.at(-1)!;
    pty.output("\x1b]133;C\x07  VITE ready\r\n  Local:   http://localhost:");
    pty.output("5173/\r\n");
    expect(list().runs[0]!.url).toBe("http://localhost:5173/");
    expect(core.actions.run(dir, id, core.spaces.home().id)).toEqual({ paneId: r.paneId, started: false });
    core.actions.stop(dir, id);
    expect(pty.written.at(-1)).toBe("\x03");
    core.actions.run(dir, id, core.spaces.home().id, { restart: true });
    pty.output("\x1b]133;D;130\x07");
    expect(pty.written.at(-1)).toBe("npm run dev\r");
    expect(list().runs[0]).toMatchObject({ endedAt: null, url: null });
  });

  it("starts an agent skill with the person's own agent command", async () => {
    write({ ".claude/skills/triage/SKILL.md": "---\nname: triage\ndescription: Triage\n---\n" });
    core.settings.set("agents.claude.command", "claude --model opus");
    core.actions.run(dir, list().actions[0]!.id, core.spaces.home().id);
    // The shell's first prompt: the command is typed then.
    ptys.at(-1)!.output("\x1b]133;A\x07\x1b]133;B\x07");
    await vi.waitFor(() => expect(ptys.at(-1)!.written.join("")).toContain("claude --model opus /triage"));
  });

  it("knows the repository's worktrees and what runs in the others", async () => {
    // A repository at main/ with a linked worktree at wt/ on branch "feature", laid out as git does.
    const main = path.join(dir, "main");
    const wt = path.join(dir, "wt");
    const pkg = JSON.stringify({ scripts: { dev: "vite" } });
    fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(main, ".git", "HEAD"), "ref: refs/heads/master\n");
    fs.writeFileSync(path.join(main, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/feature\n");
    fs.writeFileSync(path.join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
    fs.writeFileSync(path.join(main, ".git", "worktrees", "wt", "gitdir"), path.join(wt, ".git") + "\n");
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
    fs.writeFileSync(path.join(main, "package.json"), pkg);
    fs.writeFileSync(path.join(wt, "package.json"), pkg);
    const at = (root: string) => core.handlers["actions.list"]({ path: root }) as ReturnType<Core["actions"]["list"]>;
    expect(at(wt).checkout).toMatchObject({ top: wt, branch: "feature", linked: true, project: main });
    core.actions.run(wt, "npm:package.json:dev", core.spaces.home().id);
    ptys.at(-1)!.output("\x1b]133;C\x07Local: http://localhost:5174/\r\n");
    expect(at(main).worktrees).toEqual([
      { top: main, branch: "master", linked: false, running: 0, agents: 0 },
      { top: wt, branch: "feature", linked: true, running: 1, agents: 0 },
    ]);
    expect(at(main).runs).toEqual([]);
    expect(at(main).elsewhere).toMatchObject([{ actionId: "npm:package.json:dev", root: wt, branch: "feature", url: "http://localhost:5174/", endedAt: null }]);
  });

  it("pins an action to the top and keeps a pinned command from history", () => {
    write({ "package.json": JSON.stringify({ scripts: { a: "x", b: "y" } }) });
    core.actions.pin(dir, "npm:package.json:b", true);
    expect(list().actions.map((a) => [a.name, !!a.pinned])).toEqual([
      ["b", true],
      ["a", false],
    ]);
    core.actions.pin(dir, "npm:package.json:b", false);
    expect(list().actions[0]!.name).toBe("a");
  });

  it("uses the model's words when a provider is ready, and drops them when the setting is off", async () => {
    write({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
    const answer: Described = { actions: { "npm:package.json:dev": { description: "Start the dev server", kind: "dev", long: true, risky: false } }, primary: null, suggested: [{ name: "db", command: "make db", description: "Open the database" }] };
    vi.spyOn(core.ai, "status").mockReturnValue({ ...core.ai.status(), ready: true });
    vi.spyOn(core.ai, "object").mockResolvedValue({ value: { actions: [{ id: "npm:package.json:dev", ...answer.actions["npm:package.json:dev"]! }], primary: null, suggested: answer.suggested } as never, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, model: "fast" });
    const service = core.actions as unknown as { list: typeof core.actions.list };
    expect(service.list(dir).actions[0]!.description).toBeUndefined();
    await vi.waitFor(() => expect(service.list(dir).actions[0]!.description).toBe("Start the dev server"), { timeout: 4000 });
    expect(service.list(dir).suggested.map((s) => s.command)).toEqual(["make db"]);
    core.settings.set("actions.describe", false);
    expect(service.list(dir).actions[0]!.description).toBeUndefined();
  });
});
