import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileVersions, worktreeChanges } from "../src/lib/worktrees.ts";
import { rmTemp } from "./tmp.ts";

// One repository with three linked worktrees: A committed an edit and has a new file, B edits
// the same line without committing, C hasn't moved for two days.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-worktrees-")));
const repo = path.join(root, "repo");
const wt = (n: string) => path.join(root, n);
const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString();
const lines = (n: number, edit?: [number, string]) => Array.from({ length: n }, (_, i) => (edit && i + 1 === edit[0] ? edit[1] : `line ${i + 1}`)).join("\n") + "\n";

beforeAll(() => {
  fs.mkdirSync(repo);
  run(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.ts"), lines(20));
  fs.writeFileSync(path.join(repo, "b.ts"), lines(5));
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "init");
  for (const n of ["A", "B", "C"]) run(repo, "worktree", "add", "-q", wt(n), "-b", n.toLowerCase());
  fs.writeFileSync(path.join(wt("A"), "a.ts"), lines(20, [5, "line five, A's"]));
  run(wt("A"), "commit", "-qam", "A edits line 5");
  fs.writeFileSync(path.join(wt("A"), "new.ts"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(wt("B"), "a.ts"), lines(20, [5, "line five, B's"]));
  fs.writeFileSync(path.join(wt("C"), "b.ts"), lines(5, [1, "C was here"]));
  // C: nothing in its git folder changed for two days.
  const gitDir = path.join(repo, ".git", "worktrees", "C");
  const old = new Date(Date.now() - 2 * 86_400_000);
  for (const f of ["index", "HEAD", "logs/HEAD"]) if (fs.existsSync(path.join(gitDir, f))) fs.utimesSync(path.join(gitDir, f), old, old);
  // The main checkout has an uncommitted edit of its own.
  fs.writeFileSync(path.join(repo, "b.ts"), lines(5, [2, "main's edit"]));
});
afterAll(() => rmTemp(root));

describe("worktreeChanges", () => {
  it("is null outside a repository", async () => {
    expect(await worktreeChanges(root, () => false)).toBeNull();
  });

  it("lists the active checkouts with what each changed against its base", async () => {
    const r = (await worktreeChanges(wt("A"), () => false))!;
    expect(r.repo).toBe(repo);
    expect(r.mainBranch).toBe("main");
    const by = Object.fromEntries(r.worktrees.map((w) => [path.basename(w.top), w]));
    expect(Object.keys(by).sort()).toEqual(["A", "B", "repo"]);
    expect(by.repo!.main).toBe(true);
    expect(by.repo!.files.map((f) => [f.path, f.state, f.added, f.removed, f.uncommitted])).toEqual([["b.ts", "modified", 1, 1, true]]);
    // A: its commit counts (against the merge base), and its new file.
    expect(by.A!.ahead).toBe(1);
    expect(by.A!.branch).toBe("a");
    const a = Object.fromEntries(by.A!.files.map((f) => [f.path, f]));
    expect([a["a.ts"]!.state, a["a.ts"]!.added, a["a.ts"]!.removed, a["a.ts"]!.uncommitted]).toEqual(["modified", 1, 1, false]);
    expect([a["new.ts"]!.state, a["new.ts"]!.added, a["new.ts"]!.uncommitted]).toEqual(["untracked", 3, true]);
    expect(a["new.ts"]!.mtime).toBeGreaterThan(0);
    // a.ts is A's and B's: both carry the base lines they change, the same line.
    expect(a["a.ts"]!.hunks).toEqual([[5, 5]]);
    expect(by.B!.files.find((f) => f.path === "a.ts")!.hunks).toEqual([[5, 5]]);
    expect(a["new.ts"]!.hunks).toBeUndefined();
  });

  it("counts an idle worktree in when a terminal or agent is in it", async () => {
    const r = (await worktreeChanges(repo, (top) => top === wt("C")))!;
    expect(r.worktrees.map((w) => path.basename(w.top)).sort()).toEqual(["A", "B", "C", "repo"]);
  });
});

describe("fileVersions", () => {
  it("gives a file at the base and now", async () => {
    const r = (await worktreeChanges(repo, () => false))!;
    const a = r.worktrees.find((w) => w.top === wt("A"))!;
    const v = await fileVersions(a.top, "a.ts", a.base);
    expect(v.before).toBe(lines(20));
    expect(v.after).toBe(lines(20, [5, "line five, A's"]));
    expect(await fileVersions(a.top, "new.ts", a.base)).toEqual({ before: "", after: "one\ntwo\nthree\n", binary: false, tooLarge: false });
  });

  it("refuses a path outside the checkout", async () => {
    await expect(fileVersions(wt("A"), "../repo/a.ts", null)).rejects.toThrow();
  });
});
