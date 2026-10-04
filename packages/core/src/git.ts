// Git state for file windows: the branch, and what changed under a folder, from
// one `git status --porcelain=v2`. Runs without optional locks so it never
// rewrites the index (whose change would trigger another refresh), like editors do.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { GitFile, GitStatus } from "@cmd/protocol";
import { expandHome } from "./windows/builtin.ts";

/** At most this many changed paths are listed (untracked and ignored folders count once). */
const MAX_FILES = 20_000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15_000,
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/** Git state of the work tree `dir` is in, limited to `dir`; null outside a work tree or without git. */
export async function gitStatus(dir: string): Promise<GitStatus | null> {
  const abs = path.resolve(expandHome(dir));
  let top: string, gitDir: string;
  try {
    [top = "", gitDir = ""] = (await git(abs, ["rev-parse", "--show-toplevel", "--absolute-git-dir"])).split("\n");
  } catch {
    return null; // not a repository, inside .git, or no git
  }
  if (!top) return null;
  const out = await git(abs, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal", "--ignored=matching", "--", "."]);

  // Git prints real paths; answer in the spelling the folder was asked by (/tmp vs /private/tmp).
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch {}
  const spell = (p: string) => (p === real || p.startsWith(real + "/") ? abs + p.slice(real.length) : p);
  // The root is at or above the folder: the same number of levels up, if that is the same folder.
  let root = path.join(abs, path.relative(real, top));
  try {
    if (fs.realpathSync(root) !== top) root = top;
  } catch {
    root = top;
  }

  const status: GitStatus = { root, gitDir, branch: null, head: null, upstream: null, ahead: 0, behind: 0, files: {}, truncated: false };
  let count = 0;
  const add = (rel: string, file: GitFile) => {
    if (count++ >= MAX_FILES) return void (status.truncated = true);
    status.files[spell(path.join(top, rel.replace(/\/$/, "")))] = file;
  };

  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("# ")) {
      const [, key, ...rest] = t.split(" ");
      const val = rest.join(" ");
      if (key === "branch.oid" && val !== "(initial)") status.head = val.slice(0, 7);
      else if (key === "branch.head" && val !== "(detached)") status.branch = val;
      else if (key === "branch.upstream") status.upstream = val;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) [status.ahead, status.behind] = [Number(m[1]), Number(m[2])];
      }
    } else if (t.startsWith("? ")) add(t.slice(2), { state: "untracked", staged: false });
    else if (t.startsWith("! ")) add(t.slice(2), { state: "ignored", staged: false });
    else if (t.startsWith("u ")) add(field(t, 10), { state: "conflict", staged: false });
    else if (t.startsWith("1 ") || t.startsWith("2 ")) {
      const renamed = t[0] === "2";
      if (renamed) i++; // the original path follows as its own token
      const x = t[2]!, y = t[3]!;
      const state = x === "D" || y === "D" ? "deleted" : renamed ? "renamed" : x === "A" ? "added" : "modified";
      add(field(t, renamed ? 9 : 8), { state, staged: y === "." });
    }
  }
  return status;
}

/** The path field of a porcelain v2 line: everything after `n` space-separated fields (paths may contain spaces). */
function field(line: string, n: number): string {
  let at = 0;
  for (let k = 0; k < n; k++) at = line.indexOf(" ", at) + 1;
  return line.slice(at);
}
