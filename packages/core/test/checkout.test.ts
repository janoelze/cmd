import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkoutOf, placeOf } from "../src/checkout.ts";
import { rmTemp } from "./tmp.ts";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-checkout-")));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
afterAll(() => rmTemp(dir));

describe("checkoutOf", () => {
  const repo = path.join(dir, "app");
  const wt = path.join(dir, "app-feature");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "a");
  git(repo, "worktree", "add", "-q", "-b", "feature", wt);

  it("finds the main worktree from a file deep inside, with its branch", () => {
    expect(checkoutOf(path.join(repo, "src", "a.ts"))).toEqual({ top: repo, repo, common: path.join(repo, ".git"), gitDir: path.join(repo, ".git"), linked: false, branch: "main" });
  });

  it("finds a linked worktree's top, and the repository it shares with the main one", () => {
    const c = checkoutOf(path.join(wt, "src"))!;
    expect(c).toMatchObject({ top: wt, repo, common: path.join(repo, ".git"), branch: "feature" });
    expect(c.gitDir).toBe(path.join(repo, ".git", "worktrees", "app-feature"));
  });

  it("says null outside a repository, and for nothing", () => {
    expect(checkoutOf(dir)).toBeNull();
    expect(checkoutOf("")).toBeNull();
    expect(checkoutOf(path.join(dir, "missing"))).toBeNull();
  });

  it("says which project, worktree and branch, and sees a branch switch", () => {
    expect(placeOf(path.join(repo, "src"))).toEqual({ project: repo, top: repo, linked: false, branch: "main" });
    expect(placeOf(wt)).toEqual({ project: repo, top: wt, linked: true, branch: "feature" });
    git(wt, "switch", "-q", "-c", "other");
    expect(placeOf(wt)?.branch).toBe("other");
    expect(placeOf(dir)).toBeNull();
    expect(placeOf("relative")).toBeNull();
  });
});

describe("projectOf", () => {
  it("is the folder outside a repository, and nothing for a relative path", async () => {
    const { projectIdOf } = await import("../src/data/project.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-project-"));
    expect(projectIdOf(dir)).toBe(`dir:${dir}`);
    expect(projectIdOf(".")).toBeNull();
    expect(projectIdOf("src/app")).toBeNull();
    rmTemp(dir);
  });
});
