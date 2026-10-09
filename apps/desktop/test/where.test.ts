// whereOf (docs/35): a row says where it is only where that differs from its workspace.

import { describe, expect, it } from "vitest";
import type { GitPlace, Workspace } from "@cmd/protocol";
import { byProject, workspaceDetail, whereOf } from "../src/renderer/src/model.ts";

const cmd = "/Users/me/src/cmd";
const wt = "/Users/me/src/cmd-search";
const main: GitPlace = { project: cmd, top: cmd, linked: false, branch: "master" };
const tree: GitPlace = { project: cmd, top: wt, linked: true, branch: "search-design" };
const other: GitPlace = { project: "/Users/me/src/kit", top: "/Users/me/src/kit", linked: false, branch: "main" };
const workspace = (root: string, git: Workspace["git"], home = false) => ({ root, home, git });
const cmdWorkspace = workspace(cmd, { project: cmd, top: cmd, linked: false });
const home = workspace("/Users/me", null, true);

describe("whereOf", () => {
  it("says nothing in the workspace's own checkout, whatever the branch or subfolder", () => {
    expect(whereOf(main, `${cmd}/packages/core`, cmdWorkspace)).toBeNull();
    expect(whereOf({ ...main, branch: "topic" }, cmd, cmdWorkspace)).toBeNull();
  });

  it("names a worktree by its branch, in its project's colour", () => {
    const w = whereOf(tree, cmd, cmdWorkspace)!;
    expect(w.text).toBe("search-design");
    expect(w.hue).toBe(whereOf(main, cmd, home)!.hue);
    expect(w.tip).toBe("cmd · worktree on search-design · ~/src/cmd-search");
  });

  it("names another project, and the main checkout from a worktree's workspace", () => {
    expect(whereOf(other, other.top, cmdWorkspace)?.text).toBe("kit");
    const wtWorkspace = workspace(wt, { project: cmd, top: wt, linked: true });
    expect(whereOf(main, cmd, wtWorkspace)?.text).toBe("cmd");
    expect(whereOf(tree, wt, wtWorkspace)).toBeNull();
  });

  it("in Home, says the project or the worktree's branch", () => {
    expect(whereOf(main, `${cmd}/packages/core`, home)?.text).toBe("cmd");
    expect(whereOf(tree, wt, home)?.text).toBe("search-design");
  });

  it("outside a repository, names the folder only outside the workspace", () => {
    expect(whereOf(null, `${cmd}/build`, cmdWorkspace)).toBeNull();
    expect(whereOf(null, "/Users/me/Downloads/x", cmdWorkspace)?.text).toBe("x");
    expect(whereOf(null, "/Users/me", home)).toBeNull();
  });
});

describe("Workspaces of one project", () => {
  const sp = (id: string, root: string, git: Workspace["git"], gone?: boolean) => ({ id, root, git, gone, name: id }) as Workspace;
  it("come together after the main checkout, everything else in order", () => {
    const list = [sp("tree", wt, { project: cmd, top: wt, linked: true }), sp("kit", other.top, { project: other.project, top: other.top, linked: false }), sp("cmd", cmd, { project: cmd, top: cmd, linked: false }), sp("notes", "/Users/me/notes", null)];
    expect(byProject(list).map((s) => s.id)).toEqual(["cmd", "tree", "kit", "notes"]);
  });
  it("say whose worktree they are and when the folder is gone", () => {
    expect(workspaceDetail(sp("tree", wt, { project: cmd, top: wt, linked: true }, true))).toBe("~/src/cmd-search · worktree of cmd · folder removed");
    expect(workspaceDetail(sp("cmd", cmd, { project: cmd, top: cmd, linked: false }))).toBe("~/src/cmd");
  });
});
