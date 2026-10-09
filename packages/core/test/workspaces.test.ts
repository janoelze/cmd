// Workspaces: path canonicalization and matching on the real file system, the
// WorkspaceManager (attach-or-create, close/reopen, persistence) and placement in the core.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HOME_WORKSPACE_ID, workspaceIcon, type CoreEvent } from "@cmd/protocol";
import { Core } from "../src/core.ts";
import { Store } from "../src/store.ts";
import { WorkspaceManager } from "../src/workspaces/manager.ts";
import { canonical, contains, deepest, gitRoot } from "../src/workspaces/paths.ts";
import { fakeFactory } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

// realpath: on macOS os.tmpdir() is itself behind a symlink (/var → /private/var).
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-workspaces-")));
afterAll(() => rmTemp(tmp));

const mk = (...parts: string[]) => {
  const p = path.join(tmp, ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/** A fresh home folder with a few projects in it. */
function fixture(name: string) {
  const home = mk(name, "home");
  const proj = mk(name, "home", "src", "proj");
  mk(name, "home", "src", "proj", "packages", "core", "src");
  const projOld = mk(name, "home", "src", "proj-old");
  const elsewhere = mk(name, "elsewhere");
  fs.symlinkSync(proj, path.join(home, "p"));
  return { home, proj, projOld, elsewhere };
}

const caseInsensitive = (() => {
  const probe = mk("CaseProbe");
  return fs.existsSync(probe.replace("CaseProbe", "caseprobe"));
})();

describe("canonical paths", () => {
  const { home, proj } = fixture("canon");

  it("gives every spelling of a folder the same path", () => {
    expect(canonical(proj + "/")).toBe(proj);
    expect(canonical(path.join(proj, "packages", ".."))).toBe(proj);
    expect(canonical(path.join(home, "p"))).toBe(proj); // symlink
    expect(canonical("src/proj", home)).toBe(proj); // relative to base
    expect(canonical("./src//proj/", home)).toBe(proj);
    expect(canonical("~/src/proj", "/", home)).toBe(proj);
    expect(canonical("~", "/", home)).toBe(home);
  });

  it.runIf(caseInsensitive)("takes the on-disk case on a case-insensitive volume", () => {
    expect(canonical(proj.replace("/src/proj", "/SRC/Proj"))).toBe(proj);
  });

  it("takes the on-disk Unicode form (NFD and NFC are one folder)", () => {
    const nfc = mk("canon", "café");
    expect(canonical(nfc.normalize("NFD"))).toBe(nfc);
  });

  it("keeps missing parts below the deepest existing folder, resolved", () => {
    expect(canonical(path.join(home, "p", "gone", "x"))).toBe(path.join(proj, "gone", "x"));
    expect(canonical(path.join(home, "new", "café"))).toBe(path.join(home, "new", "café"));
  });

  it("follows the macOS /tmp and /var symlinks", () => {
    if (process.platform !== "darwin") return;
    expect(canonical("/tmp")).toBe("/private/tmp");
    expect(canonical(os.tmpdir()).startsWith("/private/")).toBe(true);
  });
});

describe("containment", () => {
  it("compares whole path segments", () => {
    expect(contains("/a/proj", "/a/proj")).toBe(true);
    expect(contains("/a/proj", "/a/proj/src")).toBe(true);
    expect(contains("/a/proj", "/a/proj-old")).toBe(false);
    expect(contains("/a/proj", "/a/pro")).toBe(false);
    expect(contains("/", "/anything")).toBe(true);
    // Windows paths, with either separator.
    expect(contains("C:\\src\\cmd", "C:\\src\\cmd\\docs")).toBe(true);
    expect(contains("C:\\src\\cmd", "C:\\src\\cmd/docs")).toBe(true);
    expect(contains("C:\\src\\cmd", "C:\\src\\cmd-old")).toBe(false);
    expect(contains("C:\\", "C:\\anything")).toBe(true);
  });

  it("picks the deepest root", () => {
    const roots = [{ root: "/a" }, { root: "/a/proj" }, { root: "/a/proj/packages/core" }, { root: "/a/proj-old" }];
    expect(deepest(roots, "/a/proj/packages/core/src")?.root).toBe("/a/proj/packages/core");
    expect(deepest(roots, "/a/proj/packages")?.root).toBe("/a/proj");
    expect(deepest(roots, "/a/proj-old/x")?.root).toBe("/a/proj-old");
    expect(deepest(roots, "/b")).toBeNull();
  });
});

describe("git roots", () => {
  it("finds the nearest .git folder or file (worktrees and submodules are their own roots)", () => {
    const repo = mk("git", "repo");
    fs.mkdirSync(path.join(repo, ".git"));
    const sub = mk("git", "repo", "a", "b");
    const wt = mk("git", "repo", "wt");
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: ../.git/worktrees/wt\n");
    fs.writeFileSync(path.join(sub, "f.txt"), "");
    expect(gitRoot(sub)).toBe(repo);
    expect(gitRoot(path.join(sub, "f.txt"))).toBe(repo);
    expect(gitRoot(mk("git", "repo", "wt", "src"))).toBe(wt);
    expect(gitRoot(mk("git", "plain"))).toBeNull();
    expect(gitRoot(path.join(tmp, "git", "missing"))).toBeNull();
  });
});

describe("WorkspaceManager", () => {
  it("is attach-or-create by root, whatever the spelling", () => {
    const { home, proj } = fixture("attach");
    const workspaces = new WorkspaceManager(null, home);
    const a = workspaces.open(proj);
    expect(a).toMatchObject({ created: true, workspace: { root: proj, name: "proj", home: false, order: 1 } });
    for (const p of [proj + "/", path.join(home, "p"), "~/src/proj", "src/proj/packages/.."]) {
      expect(workspaces.open(p, { cwd: home })).toMatchObject({ created: false, workspace: { id: a.workspace.id } });
    }
    expect(workspaces.list().map((s) => s.name)).toEqual(["Home", "proj"]);
  });

  it("notes a workspace whose folder is gone, and when it's back", () => {
    const { home, proj } = fixture("gone");
    const workspaces = new WorkspaceManager(null, home);
    const { workspace } = workspaces.open(proj);
    const seen: (boolean | undefined)[] = [];
    workspaces.on("updated", (s) => s.id === workspace.id && seen.push(s.gone));
    workspaces.check();
    expect(seen).toEqual([]);
    fs.rmSync(proj, { recursive: true });
    workspaces.check();
    workspaces.check();
    expect(workspaces.get(workspace.id)?.gone).toBe(true);
    fs.mkdirSync(proj);
    expect(workspaces.list(true).find((s) => s.id === workspace.id)?.gone).toBeUndefined();
    expect(seen).toEqual([true, undefined]);
  });

  it("only opens existing folders", () => {
    const { home, proj } = fixture("folders");
    fs.writeFileSync(path.join(proj, "README.md"), "");
    const workspaces = new WorkspaceManager(null, home);
    expect(() => workspaces.open(path.join(proj, "README.md"))).toThrow(/not a folder/);
    expect(() => workspaces.open(path.join(home, "nope"))).toThrow(/no such folder/);
    expect(workspaces.list()).toHaveLength(1);
  });

  it("opening the home folder is Home", () => {
    const { home } = fixture("home");
    const workspaces = new WorkspaceManager(null, home);
    expect(workspaces.open(home)).toMatchObject({ created: false, workspace: { id: HOME_WORKSPACE_ID } });
    expect(workspaces.open("~", { cwd: "/" }).workspace.id).toBe(HOME_WORKSPACE_ID);
  });

  it("opens the exact folder by default, the repository root with gitRoot", () => {
    const { home, proj } = fixture("gitopen");
    fs.mkdirSync(path.join(proj, ".git"));
    const workspaces = new WorkspaceManager(null, home);
    const deep = path.join(proj, "packages", "core");
    expect(workspaces.open(deep).workspace.root).toBe(deep);
    expect(workspaces.open(deep, { gitRoot: true }).workspace.root).toBe(proj);
    // Outside a repository gitRoot falls back to the folder itself.
    expect(workspaces.open(home + "/src", { gitRoot: true }).workspace.root).toBe(path.join(home, "src"));
  });

  it("matches a path to the deepest open workspace, else Home", () => {
    const { home, proj, projOld, elsewhere } = fixture("match");
    const workspaces = new WorkspaceManager(null, home);
    const p = workspaces.open(proj).workspace;
    const core = workspaces.open(path.join(proj, "packages", "core")).workspace;
    expect(workspaces.match(path.join(proj, "README.md")).id).toBe(p.id);
    expect(workspaces.match(path.join(home, "p", "packages")).id).toBe(p.id); // via the symlink
    expect(workspaces.match(path.join(proj, "packages", "core", "src")).id).toBe(core.id);
    expect(workspaces.match(projOld).id).toBe(HOME_WORKSPACE_ID); // a prefix, not a parent
    expect(workspaces.match(elsewhere).id).toBe(HOME_WORKSPACE_ID); // outside the home folder
    expect(workspaces.match(path.join(proj, "deleted", "dir")).id).toBe(p.id);
    workspaces.markClosed(core.id);
    expect(workspaces.match(path.join(proj, "packages", "core", "src")).id).toBe(p.id); // closed workspaces don't match
  });

  it("places an already canonical path, or none, like match", () => {
    const { home, proj, projOld } = fixture("of");
    const workspaces = new WorkspaceManager(null, home);
    const p = workspaces.open(proj).workspace;
    const core = workspaces.open(path.join(proj, "packages", "core")).workspace;
    expect(workspaces.of(p.root)).toBe(p.id);
    expect(workspaces.of(path.join(core.root, "src"))).toBe(core.id);
    expect(workspaces.of(canonical(projOld))).toBe(HOME_WORKSPACE_ID);
    expect(workspaces.of(null)).toBe(HOME_WORKSPACE_ID);
  });

  it("closes to a recent workspace and reopens it with its name and view, at the end of the order", () => {
    const { home, proj, projOld } = fixture("reopen");
    const workspaces = new WorkspaceManager(null, home);
    const a = workspaces.open(proj).workspace;
    workspaces.open(projOld);
    workspaces.update(a.id, { name: "Project", view: { "view.mode": "grid" } });
    workspaces.markClosed(a.id);
    expect(workspaces.list().map((s) => s.name)).toEqual(["Home", "proj-old"]);
    expect(workspaces.list(true).map((s) => s.name)).toEqual(["Home", "proj-old", "Project"]);
    const again = workspaces.open(proj);
    expect(again).toMatchObject({ created: false, workspace: { id: a.id, name: "Project", order: 3, closedAt: null, view: { "view.mode": "grid" } } });
  });

  it("merges view patches; null deletes a key", () => {
    const workspaces = new WorkspaceManager(null, fixture("view").home);
    workspaces.update(HOME_WORKSPACE_ID, { view: { a: 1, b: 2 } });
    expect(workspaces.update(HOME_WORKSPACE_ID, { view: { b: null, c: 3 } }).view).toEqual({ a: 1, c: 3 });
    expect(() => workspaces.update(HOME_WORKSPACE_ID, { name: "  " })).toThrow();
  });

  it("sets an SF Symbol as the icon; null goes back to the default", () => {
    const workspaces = new WorkspaceManager(null, fixture("icon").home);
    expect(workspaces.home().icon).toBeNull();
    expect(workspaces.update(HOME_WORKSPACE_ID, { icon: "leaf.fill" }).icon).toBe("leaf.fill");
    expect(() => workspaces.update(HOME_WORKSPACE_ID, { icon: "Not A Symbol" })).toThrow(/SF Symbol/);
    expect(workspaces.update(HOME_WORKSPACE_ID, { icon: null }).icon).toBeNull();
    expect(workspaceIcon(workspaces.home())).toBe("house");
  });

  it("guards Home and open workspaces", () => {
    const { home, proj } = fixture("guard");
    const workspaces = new WorkspaceManager(null, home);
    expect(() => workspaces.markClosed(HOME_WORKSPACE_ID)).toThrow(/Home/);
    const a = workspaces.open(proj).workspace;
    expect(() => workspaces.forget(a.id)).toThrow(/close/);
    workspaces.markClosed(a.id);
    expect(() => workspaces.mustOpen(a.id)).toThrow(/closed/);
    workspaces.forget(a.id);
    expect(workspaces.list(true).map((s) => s.id)).toEqual([HOME_WORKSPACE_ID]);
    expect(workspaces.open(proj).created).toBe(true);
  });

  it("persists across restarts", () => {
    const { home, proj } = fixture("persist");
    const db = path.join(tmp, "persist.sqlite");
    const first = new Store(db);
    const a = new WorkspaceManager(first, home).open(proj).workspace;
    first.close();
    const second = new Store(db);
    const again = new WorkspaceManager(second, home);
    expect(again.list().map((s) => s.id)).toEqual([HOME_WORKSPACE_ID, a.id]);
    expect(again.open(proj).created).toBe(false);
    second.close(); // Windows can't delete an open database file
  });
});

describe("placement in the core", () => {
  const setup = (name: string) => {
    const fx = fixture(name);
    const f = fakeFactory();
    const core = new Core({ socketPath: path.join(tmp, `${name}.sock`), dbPath: null, terminals: f.factory, pollMs: 0, home: fx.home });
    return { ...fx, core, ptys: f.ptys };
  };

  it("puts new terminals in the workspace given, the caller's, or the one containing the cwd", async () => {
    const { core, home, proj, elsewhere } = setup("place");
    const p = (await core.call("workspace.open", { path: proj })).workspace;

    const atRoot = await core.call("pane.create", { workspaceId: p.id });
    expect(atRoot).toMatchObject({ workspaceId: p.id, cwd: proj }); // cwd defaults to the root

    const byCwd = await core.call("pane.create", { cwd: path.join(home, "p", "packages") });
    expect(byCwd.workspaceId).toBe(p.id);
    expect((await core.call("pane.create", { cwd: elsewhere })).workspaceId).toBe(HOME_WORKSPACE_ID);
    expect((await core.call("pane.create", {})).workspaceId).toBe(HOME_WORKSPACE_ID);

    // `cmd new --cwd /elsewhere` from inside a terminal stays in that terminal's workspace.
    const fromPane = await core.call("pane.create", { callerPaneId: atRoot.id, cwd: elsewhere });
    expect(fromPane).toMatchObject({ workspaceId: p.id, cwd: elsewhere });
    await core.close();
  });

  it("opens windows in the workspace, files at its root, targets by path", async () => {
    const { core, proj } = setup("wins");
    const p = (await core.call("workspace.open", { path: proj })).workspace;
    expect(await core.call("window.open", { kind: "files", workspaceId: p.id })).toMatchObject({ workspaceId: p.id, state: { path: proj } });
    fs.writeFileSync(path.join(proj, "notes.txt"), "hi");
    expect((await core.call("window.openTarget", { target: path.join(proj, "notes.txt") }))!.workspaceId).toBe(p.id);
    expect((await core.call("window.openTarget", { target: "https://example.com" }))!.workspaceId).toBe(HOME_WORKSPACE_ID);
    await core.close();
  });

  it("keeps agents and subagents in their parent's workspace and moves trees together", async () => {
    const { core, proj, projOld } = setup("agents");
    const p = (await core.call("workspace.open", { path: proj })).workspace;
    const q = (await core.call("workspace.open", { path: projOld })).workspace;
    const host = await core.call("agent.spawn", { kind: "claude", workspaceId: p.id });
    expect(host).toMatchObject({ workspaceId: p.id, cwd: proj });
    const worker = await core.call("agent.spawn", { kind: "codex", parentId: host.id });
    expect(worker.workspaceId).toBe(p.id);
    core.agents.ingestHook(host.paneId!, "claude", "SubagentStart", { agent_id: "sub1", agent_type: "Explore" });
    const sub = core.agents.list().find((a) => a.native.claudeAgentId === "sub1")!;
    expect(sub.workspaceId).toBe(p.id);

    await core.call("window.move", { id: host.paneId!, workspaceId: q.id });
    expect(core.agents.list().map((a) => a.workspaceId)).toEqual([q.id, q.id, q.id]);
    expect(core.panes.get(worker.paneId!)!.workspaceId).toBe(q.id);
    await core.close();
  });

  it("opens the shell's `open` targets in the pane's workspace", async () => {
    const { core, proj, elsewhere } = setup("shell");
    const p = (await core.call("workspace.open", { path: proj })).workspace;
    const pane = await core.call("pane.create", { workspaceId: p.id });
    core.panes.emit("request", pane.id, "open", elsewhere);
    expect(core.windows.others()).toMatchObject([{ kind: "files", workspaceId: p.id, state: { path: elsewhere } }]);
    await core.close();
  });

  it("closing a workspace kills only its terminals and removes its windows", async () => {
    const { core, proj } = setup("close");
    const p = (await core.call("workspace.open", { path: proj })).workspace;
    const mine = await core.call("pane.create", { workspaceId: p.id });
    const other = await core.call("pane.create", {});
    await core.call("window.open", { kind: "files", workspaceId: p.id });
    await core.call("window.open", { kind: "browser", input: { url: "example.com" } });
    const events: CoreEvent[] = [];
    core.workspaces.on("updated", (workspace) => events.push({ type: "workspace.updated", workspace }));
    await core.call("workspace.close", { id: p.id });
    expect(core.panes.get(mine.id)).toBeNull();
    expect(core.panes.get(other.id)).not.toBeNull();
    expect(core.windows.others().map((w) => w.workspaceId)).toEqual([HOME_WORKSPACE_ID]);
    expect(await core.call("workspace.list", {})).toMatchObject([{ id: HOME_WORKSPACE_ID }]);
    expect(events.at(-1)).toMatchObject({ workspace: { id: p.id } });
    await expect(core.call("pane.create", { workspaceId: p.id })).rejects.toThrow(/closed/);
    await expect(core.call("workspace.close", { id: HOME_WORKSPACE_ID })).rejects.toThrow(/Home/);
    await core.close();
  });
});
