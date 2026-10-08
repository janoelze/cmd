// whereOf (docs/35): a row says where it is only where that differs from its Space.

import { describe, expect, it } from "vitest";
import type { GitPlace, Space } from "@cmd/protocol";
import { byProject, spaceDetail, whereOf } from "../src/renderer/src/model.ts";

const cmd = "/Users/me/src/cmd";
const wt = "/Users/me/src/cmd-search";
const main: GitPlace = { project: cmd, top: cmd, linked: false, branch: "master" };
const tree: GitPlace = { project: cmd, top: wt, linked: true, branch: "search-design" };
const other: GitPlace = { project: "/Users/me/src/kit", top: "/Users/me/src/kit", linked: false, branch: "main" };
const space = (root: string, git: Space["git"], home = false) => ({ root, home, git });
const cmdSpace = space(cmd, { project: cmd, top: cmd, linked: false });
const home = space("/Users/me", null, true);

describe("whereOf", () => {
  it("says nothing in the Space's own checkout, whatever the branch or subfolder", () => {
    expect(whereOf(main, `${cmd}/packages/core`, cmdSpace)).toBeNull();
    expect(whereOf({ ...main, branch: "topic" }, cmd, cmdSpace)).toBeNull();
  });

  it("names a worktree by its branch, in its project's colour", () => {
    const w = whereOf(tree, cmd, cmdSpace)!;
    expect(w.text).toBe("search-design");
    expect(w.hue).toBe(whereOf(main, cmd, home)!.hue);
    expect(w.tip).toBe("cmd · worktree on search-design · ~/src/cmd-search");
  });

  it("names another project, and the main checkout from a worktree's Space", () => {
    expect(whereOf(other, other.top, cmdSpace)?.text).toBe("kit");
    const wtSpace = space(wt, { project: cmd, top: wt, linked: true });
    expect(whereOf(main, cmd, wtSpace)?.text).toBe("cmd");
    expect(whereOf(tree, wt, wtSpace)).toBeNull();
  });

  it("in Home, says the project or the worktree's branch", () => {
    expect(whereOf(main, `${cmd}/packages/core`, home)?.text).toBe("cmd");
    expect(whereOf(tree, wt, home)?.text).toBe("search-design");
  });

  it("outside a repository, names the folder only outside the Space", () => {
    expect(whereOf(null, `${cmd}/build`, cmdSpace)).toBeNull();
    expect(whereOf(null, "/Users/me/Downloads/x", cmdSpace)?.text).toBe("x");
    expect(whereOf(null, "/Users/me", home)).toBeNull();
  });
});

describe("Spaces of one project", () => {
  const sp = (id: string, root: string, git: Space["git"], gone?: boolean) => ({ id, root, git, gone, name: id }) as Space;
  it("come together after the main checkout, everything else in order", () => {
    const list = [sp("tree", wt, { project: cmd, top: wt, linked: true }), sp("kit", other.top, { project: other.project, top: other.top, linked: false }), sp("cmd", cmd, { project: cmd, top: cmd, linked: false }), sp("notes", "/Users/me/notes", null)];
    expect(byProject(list).map((s) => s.id)).toEqual(["cmd", "tree", "kit", "notes"]);
  });
  it("say whose worktree they are and when the folder is gone", () => {
    expect(spaceDetail(sp("tree", wt, { project: cmd, top: wt, linked: true }, true))).toBe("~/src/cmd-search · worktree of cmd · folder removed");
    expect(spaceDetail(sp("cmd", cmd, { project: cmd, top: cmd, linked: false }))).toBe("~/src/cmd");
  });
});
