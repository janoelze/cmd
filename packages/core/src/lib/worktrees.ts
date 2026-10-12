// Live Diff across worktrees (docs/52-livediff-worktrees.md): every checkout of a repository
// with work going on, and what each changed. A linked worktree is compared with where its
// branch left the main branch (its merge base), so an agent that commits as it goes still
// shows its work; the main checkout with HEAD, as Live Diff always did. Files that more than
// one checkout changed carry the base lines their changes cover, so the UI can tell the same
// file from the same lines. A worktree counts as active when a terminal or agent is in it
// or its git state changed in the last day; the others (finished, abandoned) are left out,
// which also keeps the git runs few.

import fs from "node:fs";
import path from "node:path";
import type { BranchFile, GitFileState, WorktreeChanges } from "@cmd/protocol";
import { expandHome } from "../windows/builtin.ts";
import { checkoutOf, worktreesOf } from "./checkout.ts";
import { git, gitAllowing1 } from "./git.ts";

/** A linked worktree untouched this long, with nobody in it, is left out. */
const ACTIVE_MS = 24 * 3_600_000;
/** At most this many files per checkout. */
const MAX_FILES = 2000;
/** Untracked files larger than this aren't read to count their lines. */
const COUNT_MAX = 1024 * 1024;
/** fileVersions sends no text above this. */
const TEXT_MAX = 2 * 1024 * 1024;

/** The main branch of the repository at `repo`: main or master when there, else origin's HEAD. */
async function mainBranchOf(repo: string): Promise<string | null> {
  for (const b of ["main", "master"]) if (await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).then(() => true, () => false)) return b;
  return git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).then((o) => o.trim() || null, () => null);
}

function mtime(f: string): number {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

/** The last time git state changed in a worktree: its index, HEAD and HEAD's log. */
const touched = (gitDir: string) => Math.max(mtime(path.join(gitDir, "index")), mtime(path.join(gitDir, "HEAD")), mtime(path.join(gitDir, "logs", "HEAD")));

const STATE: Record<string, GitFileState> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "added", T: "modified", U: "conflict" };

/** Lines of a file (for an untracked one's count); 0 for a binary or large one. */
function countLines(abs: string): { lines: number; binary: boolean } {
  try {
    if (fs.statSync(abs).size > COUNT_MAX) return { lines: 0, binary: false };
    const b = fs.readFileSync(abs);
    if (b.includes(0)) return { lines: 0, binary: true };
    const t = b.toString("utf8");
    return { lines: t ? t.split("\n").length - (t.endsWith("\n") ? 1 : 0) : 0, binary: false };
  } catch {
    return { lines: 0, binary: false };
  }
}

/** What the checkout at `top` changed against `base` (tracked: the work tree vs base; untracked: whole files). */
async function changesOf(top: string, base: string | null): Promise<{ files: BranchFile[]; truncated: boolean }> {
  const status = await git(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).catch(() => "");
  // Porcelain v1 -z: "XY path\0", a rename's original path as the next field.
  const dirty = new Set<string>();
  const untracked: string[] = [];
  const parts = status.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    const p = e.slice(3);
    if (e.startsWith("??")) untracked.push(p);
    else dirty.add(p);
    if (e[0] === "R" || e[0] === "C") i++;
  }
  const files = new Map<string, BranchFile>();
  if (base) {
    const [names, nums] = await Promise.all([
      git(top, ["diff", "--name-status", "-z", "-M", "--no-ext-diff", base]).catch(() => ""),
      git(top, ["diff", "--numstat", "-z", "-M", "--no-ext-diff", base]).catch(() => ""),
    ]);
    const n = names.split("\0");
    for (let i = 0; i + 1 < n.length; ) {
      const code = n[i]!;
      if (!code) break;
      const renamed = code[0] === "R" || code[0] === "C";
      const p = renamed ? n[i + 2]! : n[i + 1]!;
      i += renamed ? 3 : 2;
      files.set(p, { path: p, state: STATE[code[0]!] ?? "modified", added: 0, removed: 0, binary: false, uncommitted: dirty.has(p), mtime: null });
    }
    // Numstat -z: "added\tremoved\tpath\0", or for a rename "added\tremoved\t\0old\0new\0".
    const s = nums.split("\0");
    for (let i = 0; i < s.length; i++) {
      const [a, r, p0] = s[i]!.split("\t");
      if (a === undefined || r === undefined) continue;
      let p = p0 ?? "";
      if (!p) (p = s[i + 2] ?? ""), (i += 2);
      const f = files.get(p);
      if (!f) continue;
      f.binary = a === "-";
      f.added = f.binary ? 0 : +a;
      f.removed = f.binary ? 0 : +r;
    }
  }
  for (const p of untracked) {
    const { lines, binary } = countLines(path.join(top, p));
    files.set(p, { path: p, state: "untracked", added: lines, removed: 0, binary, uncommitted: true, mtime: null });
  }
  const list = [...files.values()];
  for (const f of list) f.mtime = f.state === "deleted" ? null : mtime(path.join(top, f.path)) || null;
  list.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  return { files: list.slice(0, MAX_FILES), truncated: list.length > MAX_FILES };
}

/** The base lines each change to `file` covers ([from, to]; [0, 0] for a file the base hasn't). */
async function hunksOf(top: string, base: string | null, f: BranchFile): Promise<[number, number][]> {
  if (!base || f.state === "untracked" || f.state === "added") return [[0, 0]];
  const d = await git(top, ["diff", "-U0", "--no-color", "--no-ext-diff", base, "--", f.path]).catch(() => "");
  const out: [number, number][] = [];
  for (const m of d.matchAll(/^@@ -(\d+)(?:,(\d+))? /gm)) {
    const from = +m[1]!, n = m[2] === undefined ? 1 : +m[2];
    // An insertion (n 0) goes after line `from`: it touches that line.
    out.push(n === 0 ? [from, from] : [from, from + n - 1]);
  }
  return out;
}

/**
 * Every active checkout of the repository `dir` is in, with what each changed. `busy`
 * says whether a terminal or agent of this core is in a checkout (by its top).
 */
export async function worktreeChanges(dir: string, busy: (top: string) => boolean): Promise<{ repo: string; mainBranch: string | null; worktrees: WorktreeChanges[] } | null> {
  const c = checkoutOf(path.resolve(expandHome(dir)));
  if (!c) return null;
  const repo = c.repo;
  const mainBranch = await mainBranchOf(repo);
  const now = Date.now();
  const tops = [repo, ...worktreesOf(c.common).filter((t) => t !== repo && t !== fs.realpathSync.native(repo))];
  const worktrees = (
    await Promise.all(
      tops.map(async (top, i): Promise<WorktreeChanges | null> => {
        const co = checkoutOf(top);
        if (!co) return null;
        const main = i === 0;
        if (!main && !busy(top) && now - touched(co.gitDir) > ACTIVE_MS) return null;
        const head = await git(top, ["rev-parse", "--verify", "--quiet", "HEAD"]).then((o) => o.trim() || null, () => null);
        // A worktree on the main branch itself is compared like the main checkout: with its HEAD.
        const base = !head ? null : main || !mainBranch || co.branch === mainBranch ? head : await git(top, ["merge-base", "HEAD", mainBranch]).then((o) => o.trim() || head, () => head);
        const ahead = base && head && base !== head ? await git(top, ["rev-list", "--count", `${base}..HEAD`]).then((o) => +o.trim() || 0, () => 0) : 0;
        const { files, truncated } = await changesOf(top, base);
        return { top, gitDir: co.gitDir, branch: co.branch, main, base, ahead, files, truncated };
      }),
    )
  ).filter((w): w is WorktreeChanges => !!w && (w.main || w.files.length > 0 || w.ahead > 0));
  // Files more than one checkout changed: the base lines each one's changes cover.
  const count = new Map<string, number>();
  for (const w of worktrees) for (const f of w.files) count.set(f.path, (count.get(f.path) ?? 0) + 1);
  await Promise.all(worktrees.flatMap((w) => w.files.filter((f) => (count.get(f.path) ?? 0) > 1).map(async (f) => void (f.hunks = await hunksOf(w.top, w.base, f)))));
  return { repo, mainBranch, worktrees };
}

/** A file of the checkout at `top` as a whole, at `base` and now. */
export async function fileVersions(top: string, file: string, base: string | null): Promise<{ before: string; after: string; binary: boolean; tooLarge: boolean }> {
  const abs = path.join(top, file);
  if (path.relative(top, abs).startsWith("..")) throw new Error("outside the checkout");
  let after: Buffer = Buffer.alloc(0);
  try {
    if (fs.statSync(abs).size > TEXT_MAX) return { before: "", after: "", binary: false, tooLarge: true };
    after = fs.readFileSync(abs);
  } catch {}
  const before = base ? await gitAllowing1(top, ["show", `${base}:${file}`]).catch(() => "") : "";
  if (before.length > TEXT_MAX) return { before: "", after: "", binary: false, tooLarge: true };
  if (after.includes(0) || before.includes("\0")) return { before: "", after: "", binary: true, tooLarge: false };
  return { before, after: after.toString("utf8"), binary: false, tooLarge: false };
}
