// Files and git for windows (fs.*, git.*): list, read, write, rename, copy and move, watch a
// path for changes (let go when the client closes), a folder's git status and diffs, and
// what every active checkout of its repository changed (Live Diff across worktrees).

import type { CoreContext } from "../kernel/context.ts";
import { IN_CORE, slice } from "../kernel/handlers.ts";
import { listDir, readText, resolvePaths, writeText } from "../windows/manager.ts";
import { createPath, duplicatePath, renamePath, transferPaths } from "./fileops.ts";
import { gitDiff, gitStatus } from "./git.ts";
import { fileVersions, worktreeChanges } from "./worktrees.ts";
import { MAX_WATCHES, RemoteDenied } from "../remote/policy.ts";

export const fileHandlers = (core: CoreContext) =>
  slice({
    "fs.list": (p) => listDir(p.path),
    "fs.read": (p) => readText(p.path),
    "fs.resolve": (p) => resolvePaths(p.paths, p.cwd),
    "fs.write": (p) => writeText(p.path, p.text, p.expectMtime),
    "fs.rename": (p) => renamePath(p.path, p.name),
    "fs.duplicate": (p) => duplicatePath(p.path),
    "fs.create": (p) => createPath(p.dir, p.kind),
    "fs.transfer": (p) => transferPaths(p.paths, p.dir, p.op),
    "fs.watch": (p, { conn } = IN_CORE) => {
      if (conn && conn.access !== "local" && core.server.state(conn).watches.length >= MAX_WATCHES) throw new RemoteDenied(`watching ${MAX_WATCHES} paths already`);
      const watching = core.watches.watch(p.path);
      if (conn && watching) core.server.state(conn).watches.push(p.path);
      return { watching };
    },
    "fs.unwatch": (p, { conn } = IN_CORE) => {
      core.watches.unwatch(p.path);
      const list = conn ? core.server.state(conn).watches : [];
      const i = list.indexOf(p.path);
      if (i >= 0) list.splice(i, 1);
      return null;
    },
    "git.status": (p) => gitStatus(p.path),
    "git.diff": (p) => gitDiff(p.path, p.file),
    "git.worktrees": (p) => {
      // Checkouts a terminal or an agent of this core is in count as active.
      const tops = new Set<string>();
      for (const x of [...core.panes.list(), ...core.agents.list()]) if (x.git) tops.add(x.git.top);
      return worktreeChanges(p.path, (top) => tops.has(top));
    },
    "git.fileVersions": (p) => fileVersions(p.top, p.file, p.base),
  });
