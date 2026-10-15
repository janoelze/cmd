// Workspace Actions for a widget (API 1.3, docs/57 C14): which folder a widget may read and run
// actions of, its actions as the native view has them, and what the view says about the folder.
// The folder is the widget's workspace's, or a worktree of the workspace's repository named by
// the widget (`root`): checked against git's own list of the repository's worktrees, by real
// path, never trusted as given; anything else (another repository, `..`, a symlink that leads
// out) is refused. What a widget gets never holds an absolute path but the folder's own.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionsList, ApiAction, ApiActionsInfo, ApiActionsQuery, WorkspaceAction } from "@cmd/protocol";
import type { CoreContext } from "../../kernel/context.ts";
import { checkoutOf, worktreesOf } from "../../lib/checkout.ts";
import { invalid } from "./access.ts";
import { apiAction, relativeIn } from "./model.ts";

type ActionsCore = Pick<CoreContext, "actions">;

const real = (p: string): string | null => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * The folder a widget's actions are of: the workspace's (`asked` empty), or the worktree of the
 * workspace's repository `asked` names (an absolute path, as `git.worktrees` gives it), as git
 * lists it. Null when the workspace has no folder; throws for anything else.
 */
export function actionsRootFor(wsRoot: string | null | undefined, asked: unknown): string | null {
  const none = asked === undefined || asked === null || asked === "";
  if (!wsRoot) {
    if (none) return null;
    throw invalid("This widget's workspace has no folder, so no worktrees.");
  }
  if (none) return wsRoot;
  const shown = String(asked).slice(0, 160);
  const refuse = () => invalid(`${shown} isn't a worktree of this workspace's repository.`);
  if (typeof asked !== "string" || !path.isAbsolute(asked) || asked.split(/[\\/]/).includes("..")) throw refuse();
  const target = real(asked);
  if (!target) throw refuse();
  if (target === real(wsRoot)) return wsRoot;
  const c = checkoutOf(wsRoot);
  if (!c) throw refuse();
  for (const top of [c.repo, ...worktreesOf(c.common)]) {
    const r = real(top);
    if (r && r === target) return r;
  }
  throw refuse();
}

const INCLUDES = ["history", "suggested"] as const;

/** The query's `include`, only the kinds there are. */
const includes = (q: ApiActionsQuery | null | undefined): Set<string> => new Set(Array.isArray(q?.include) ? q.include.filter((x) => (INCLUDES as readonly unknown[]).includes(x)) : []);

/** The list's actions for a widget: the files' always, history and the README's when asked. */
export function widgetActions(list: ActionsList, q: ApiActionsQuery | null | undefined, sees: (paneId: string) => boolean): ApiAction[] {
  const inc = includes(q);
  const all: WorkspaceAction[] = [...list.actions, ...(inc.has("history") ? list.history : []), ...(inc.has("suggested") ? list.suggested : [])];
  return all.map((a) => apiAction(a, list, sees));
}

/** An action of the list by its name, as a widget has it (the files' first, then history, then the README's). */
export function findAction(list: ActionsList, name: string): WorkspaceAction | undefined {
  for (const group of [list.actions, list.history, list.suggested]) {
    const a = group.find((x) => x.id === name) ?? group.find((x) => x.name === name && !x.package) ?? group.find((x) => x.name === name);
    if (a) return a;
  }
  return undefined;
}

/** A source's error for a widget: the folder's and the home folder's paths left out. */
const scrub = (root: string, text: string): string => text.split(root + path.sep).join("").split(root).join(".").split(os.homedir()).join("~");

/** What Workspace Actions says about the folder: its checkout, the AI describing, files that couldn't be read. */
export function actionsInfo(core: ActionsCore, root: string): ApiActionsInfo {
  const list = core.actions.list(root);
  return {
    root,
    branch: list.checkout?.branch ?? null,
    linked: !!list.checkout?.linked,
    describing: list.describing,
    errors: list.sources.flatMap((s) => (s.error ? [{ file: relativeIn(root, s.file) ?? path.basename(s.file), error: scrub(root, s.error) }] : [])),
  };
}
