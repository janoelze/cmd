// Where an agent's name comes from without a model (docs/32-session-names.md,
// "Where names come from"): the worktree it works in. Sessions start in a
// repository's main checkout and move into a task's worktree later, so the
// folder is read from what the agent does (files it writes, `cd` and `git -C`
// in its commands, its reported cwd), not from where it started. A linked
// worktree on a branch that names something gives the name. Writing there is
// working there; going there may be a look at another agent's work, so it only
// names an agent that has no name yet.

import os from "node:os";
import path from "node:path";
import type { ActivityEvent } from "@cmd/protocol";
import { nameFromBranch } from "@cmd/protocol";
import { checkoutOf } from "../checkout.ts";

const CD = /(?:^|&&|;|\|\||\()\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g;
const GIT_C = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/g;

/** Folders an event says the agent works in, most telling first: files it writes (`wrote`), then folders it goes to. */
export function foldersOf(ev: Pick<ActivityEvent, "cwd" | "tool">): { dir: string; wrote: boolean }[] {
  const out: { dir: string; wrote: boolean }[] = [];
  const abs = (p: string) => {
    const unq = p.replace(/^["']|["']$/g, "");
    const home = unq === "~" || unq.startsWith("~/") ? path.join(os.homedir(), unq.slice(1)) : unq;
    if (path.isAbsolute(home)) return home;
    return ev.cwd ? path.join(ev.cwd, home) : null;
  };
  for (const p of ev.tool?.paths ?? []) {
    const a = abs(p);
    if (a) out.push({ dir: path.dirname(a), wrote: true });
  }
  const cmd = ev.tool?.command ?? "";
  for (const re of [CD, GIT_C]) for (const m of cmd.matchAll(re)) {
    const a = abs(m[1]!);
    if (a) out.push({ dir: a, wrote: false });
  }
  if (ev.cwd) out.push({ dir: ev.cwd, wrote: false });
  return out;
}

/** The name the worktree an event points at gives, with that worktree; null when it points at none (or a main checkout). */
export function worktreeName(ev: Pick<ActivityEvent, "cwd" | "tool">): { name: string; top: string; branch: string; wrote: boolean } | null {
  for (const { dir, wrote } of foldersOf(ev)) {
    const c = checkoutOf(dir);
    // The main checkout (its git folder is the shared one) is where every task starts, not a task.
    if (!c || c.gitDir === c.common || !c.branch) continue;
    const name = nameFromBranch(c.branch);
    if (name) return { name, top: c.top, branch: c.branch, wrote };
  }
  return null;
}
