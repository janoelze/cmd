import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gitDiff, gitStatus } from "../src/git.ts";
import { rmTemp } from "./tmp.ts";

// Not realpath'd: on macOS the temp dir is a symlink (/var → /private/var), so this
// also checks that paths come back spelled the way they were asked for.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-git-"));
const run = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

describe("gitStatus", () => {
  afterAll(() => rmTemp(dir));

  it("is null outside a repository", async () => {
    expect(await gitStatus(dir)).toBeNull();
  });

  it("reports branch and each kind of change under the folder", async () => {
    run("init", "-q", "-b", "main");
    write("keep.txt", "1");
    write("edit me.txt", "1");
    write("gone.txt", "1");
    write("old.txt", "1");
    write("src/a.ts", "1");
    write(".gitignore", "build/\n*.log\n");
    run("add", "-A");
    run("commit", "-q", "-m", "init");

    write("edit me.txt", "2");
    fs.rmSync(path.join(dir, "gone.txt"));
    run("mv", "old.txt", "new.txt");
    write("staged.txt", "1");
    run("add", "staged.txt");
    write("fresh/x.txt", "1");
    write("build/out.js", "1");
    write("debug.log", "1");
    write("src/a.ts", "2");

    const s = (await gitStatus(dir))!;
    expect(s.root).toBe(dir);
    expect(s.branch).toBe("main");
    expect(s.head).toMatch(/^[0-9a-f]{7}$/);
    const at = (rel: string) => s.files[path.join(dir, rel)];
    expect(at("keep.txt")).toBeUndefined();
    expect(at("edit me.txt")).toEqual({ state: "modified", staged: false });
    expect(at("gone.txt")).toEqual({ state: "deleted", staged: false });
    expect(at("new.txt")).toEqual({ state: "renamed", staged: true });
    expect(at("staged.txt")).toEqual({ state: "added", staged: true });
    expect(at("fresh")).toEqual({ state: "untracked", staged: false });
    expect(at("build")).toEqual({ state: "ignored", staged: false });
    expect(at("debug.log")).toEqual({ state: "ignored", staged: false });

    // Limited to the folder asked about.
    const sub = (await gitStatus(path.join(dir, "src")))!;
    expect(sub.root).toBe(dir);
    expect(Object.keys(sub.files)).toEqual([path.join(dir, "src/a.ts")]);
  });
});

describe("gitDiff", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-gitdiff-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
  afterAll(() => rmTemp(repo));

  it("is null outside a repository", async () => {
    expect(await gitDiff(repo)).toBeNull();
  });

  it("diffs staged and unstaged changes against HEAD, and an untracked file as added", async () => {
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    fs.mkdirSync(path.join(repo, "sub"));
    fs.writeFileSync(path.join(repo, "sub", "b.txt"), "b\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\nTWO\n");
    fs.writeFileSync(path.join(repo, "sub", "b.txt"), "b\nc\n");
    git("add", "sub/b.txt");
    fs.writeFileSync(path.join(repo, "new.txt"), "fresh\n");

    const all = (await gitDiff(repo))!;
    expect(all.truncated).toBe(false);
    expect(all.diff).toContain("+++ b/a.txt");
    expect(all.diff).toContain("-two\n+TWO");
    expect(all.diff).toContain("+++ b/sub/b.txt"); // staged counts too
    expect(all.diff).not.toContain("new.txt"); // untracked: asked for one by one

    const sub = (await gitDiff(path.join(repo, "sub")))!;
    expect(sub.diff).toContain("sub/b.txt");
    expect(sub.diff).not.toContain("a.txt");

    const added = (await gitDiff(repo, "new.txt"))!;
    expect(added.diff).toContain("+fresh");
    expect(added.diff).toContain("+++ b/new.txt");
  });
});
