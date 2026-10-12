// Live Diff across worktrees (docs/52-livediff-worktrees.md), the data: every active checkout
// of a folder's repository from git.worktrees, current as agents work (at once when a
// checkout's index or HEAD changes, by polling while cmd is in front for edits), as the
// lanes ActivityView draws, each named after the agent working there.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent, WorktreeChanges } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import { onFsChanged } from "../../lib/store.ts";
import { ledOf } from "../../lib/model.ts";
import type { Lane } from "./Activity.tsx";

const POLL_MS = 3000;

export type Worktrees = { repo: string; mainBranch: string | null; worktrees: WorktreeChanges[] };

/** The checkouts of `dir`'s repository with work going on: undefined while loading, null outside a repository (or an older core). */
export function useWorktrees(dir: string): Worktrees | null | undefined {
  const [data, setData] = useState<Worktrees | null | undefined>(undefined);
  const asked = useRef(dir);
  asked.current = dir;
  const refresh = useCallback(async () => {
    if (!cmd.has("git.worktrees")) return setData(null);
    const at = dir;
    const r = await cmd.call("git.worktrees", { path: at }).catch(() => null);
    if (asked.current !== at) return;
    // Polling mostly finds nothing new: keep the same value so nothing re-renders.
    setData((prev) => (JSON.stringify(prev) === JSON.stringify(r) ? prev : r));
  }, [dir]);

  useEffect(() => {
    setData(undefined);
    void refresh();
    const poll = setInterval(() => document.hasFocus() && void refresh(), POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  // Stage, commit, checkout in any of them: at once.
  const gitDirs = data?.worktrees.map((w) => w.gitDir).join("\n") ?? "";
  useEffect(() => {
    if (!gitDirs) return;
    const files = gitDirs.split("\n").flatMap((d) => ["index", "HEAD", "logs/HEAD"].map((f) => `${d}/${f}`));
    for (const f of files) void cmd.call("fs.watch", { path: f }).catch(() => {});
    const off = onFsChanged((p) => files.includes(p) && void refresh());
    return () => {
      off();
      for (const f of files) void cmd.call("fs.unwatch", { path: f }).catch(() => {});
    };
  }, [gitDirs, refresh]);

  return data;
}

const KIND: Record<string, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", qwen: "Qwen", copilot: "Copilot" };
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

/**
 * The checkouts as lanes: each named after the agent working in it (the one active
 * last, among those whose files are there), else its folder; its files newest first.
 */
export function lanesOf(data: Worktrees, agents: Iterable<Agent>, now: number): Lane[] {
  const by = new Map<string, Agent[]>();
  for (const a of agents) if (a.git && !a.parentId) by.set(a.git.top, [...(by.get(a.git.top) ?? []), a]);
  return data.worktrees.map((w) => {
    const a = (by.get(w.top) ?? []).sort((x, y) => Number(y.state !== "exited") - Number(x.state !== "exited") || y.stateSince - x.stateSince)[0];
    return {
      id: w.top,
      top: w.top,
      base: w.base,
      name: a ? (a.name ?? KIND[a.kind] ?? a.kind) : base(w.top),
      branch: w.branch ?? "detached",
      main: w.main,
      light: a ? ledOf(a) : "off",
      ahead: w.ahead,
      files: w.files.map((f) => ({
        rel: f.path,
        state: f.state,
        added: f.added,
        removed: f.removed,
        ago: f.mtime ? Math.max(0, now - f.mtime) : Infinity,
        version: f.mtime ?? 0,
        committed: !f.uncommitted,
        hunks: f.hunks,
      })),
    };
  });
}
