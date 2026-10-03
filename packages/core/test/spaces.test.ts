// Spaces: path canonicalization and matching on the real file system, the
// SpaceManager (attach-or-create, close/reopen, persistence) and placement in the core.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HOME_SPACE_ID, type CoreEvent } from "@cmd/protocol";
import { Core } from "../src/core.ts";
import { Store } from "../src/store.ts";
import { SpaceManager } from "../src/spaces/manager.ts";
import { canonical, contains, deepest, gitRoot } from "../src/spaces/paths.ts";
import { fakeFactory } from "./fake-pty.ts";

// realpath: on macOS os.tmpdir() is itself behind a symlink (/var → /private/var).
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-spaces-")));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

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

describe("SpaceManager", () => {
  it("is attach-or-create by root, whatever the spelling", () => {
    const { home, proj } = fixture("attach");
    const spaces = new SpaceManager(null, home);
    const a = spaces.open(proj);
    expect(a).toMatchObject({ created: true, space: { root: proj, name: "proj", home: false, order: 1 } });
    for (const p of [proj + "/", path.join(home, "p"), "~/src/proj", "src/proj/packages/.."]) {
      expect(spaces.open(p, { cwd: home })).toMatchObject({ created: false, space: { id: a.space.id } });
    }
    expect(spaces.list().map((s) => s.name)).toEqual(["Home", "proj"]);
  });

  it("only opens existing folders", () => {
    const { home, proj } = fixture("folders");
    fs.writeFileSync(path.join(proj, "README.md"), "");
    const spaces = new SpaceManager(null, home);
    expect(() => spaces.open(path.join(proj, "README.md"))).toThrow(/not a folder/);
    expect(() => spaces.open(path.join(home, "nope"))).toThrow(/no such folder/);
    expect(spaces.list()).toHaveLength(1);
  });

  it("opening the home folder is Home", () => {
    const { home } = fixture("home");
    const spaces = new SpaceManager(null, home);
    expect(spaces.open(home)).toMatchObject({ created: false, space: { id: HOME_SPACE_ID } });
    expect(spaces.open("~", { cwd: "/" }).space.id).toBe(HOME_SPACE_ID);
  });

  it("opens the exact folder by default, the repository root with gitRoot", () => {
    const { home, proj } = fixture("gitopen");
    fs.mkdirSync(path.join(proj, ".git"));
    const spaces = new SpaceManager(null, home);
    const deep = path.join(proj, "packages", "core");
    expect(spaces.open(deep).space.root).toBe(deep);
    expect(spaces.open(deep, { gitRoot: true }).space.root).toBe(proj);
    // Outside a repository gitRoot falls back to the folder itself.
    expect(spaces.open(home + "/src", { gitRoot: true }).space.root).toBe(path.join(home, "src"));
  });

  it("matches a path to the deepest open Space, else Home", () => {
    const { home, proj, projOld, elsewhere } = fixture("match");
    const spaces = new SpaceManager(null, home);
    const p = spaces.open(proj).space;
    const core = spaces.open(path.join(proj, "packages", "core")).space;
    expect(spaces.match(path.join(proj, "README.md")).id).toBe(p.id);
    expect(spaces.match(path.join(home, "p", "packages")).id).toBe(p.id); // via the symlink
    expect(spaces.match(path.join(proj, "packages", "core", "src")).id).toBe(core.id);
    expect(spaces.match(projOld).id).toBe(HOME_SPACE_ID); // a prefix, not a parent
    expect(spaces.match(elsewhere).id).toBe(HOME_SPACE_ID); // outside the home folder
    expect(spaces.match(path.join(proj, "deleted", "dir")).id).toBe(p.id);
    spaces.markClosed(core.id);
    expect(spaces.match(path.join(proj, "packages", "core", "src")).id).toBe(p.id); // closed Spaces don't match
  });

  it("closes to a recent Space and reopens it with its name and view, at the end of the order", () => {
    const { home, proj, projOld } = fixture("reopen");
    const spaces = new SpaceManager(null, home);
    const a = spaces.open(proj).space;
    spaces.open(projOld);
    spaces.update(a.id, { name: "Project", view: { "view.mode": "grid" } });
    spaces.markClosed(a.id);
    expect(spaces.list().map((s) => s.name)).toEqual(["Home", "proj-old"]);
    expect(spaces.list(true).map((s) => s.name)).toEqual(["Home", "proj-old", "Project"]);
    const again = spaces.open(proj);
    expect(again).toMatchObject({ created: false, space: { id: a.id, name: "Project", order: 3, closedAt: null, view: { "view.mode": "grid" } } });
  });

  it("merges view patches; null deletes a key", () => {
    const spaces = new SpaceManager(null, fixture("view").home);
    spaces.update(HOME_SPACE_ID, { view: { a: 1, b: 2 } });
    expect(spaces.update(HOME_SPACE_ID, { view: { b: null, c: 3 } }).view).toEqual({ a: 1, c: 3 });
    expect(() => spaces.update(HOME_SPACE_ID, { name: "  " })).toThrow();
  });

  it("guards Home and open Spaces", () => {
    const { home, proj } = fixture("guard");
    const spaces = new SpaceManager(null, home);
    expect(() => spaces.markClosed(HOME_SPACE_ID)).toThrow(/Home/);
    const a = spaces.open(proj).space;
    expect(() => spaces.forget(a.id)).toThrow(/close/);
    spaces.markClosed(a.id);
    expect(() => spaces.mustOpen(a.id)).toThrow(/closed/);
    spaces.forget(a.id);
    expect(spaces.list(true).map((s) => s.id)).toEqual([HOME_SPACE_ID]);
    expect(spaces.open(proj).created).toBe(true);
  });

  it("persists across restarts", () => {
    const { home, proj } = fixture("persist");
    const db = path.join(tmp, "persist.sqlite");
    const a = new SpaceManager(new Store(db), home).open(proj).space;
    const again = new SpaceManager(new Store(db), home);
    expect(again.list().map((s) => s.id)).toEqual([HOME_SPACE_ID, a.id]);
    expect(again.open(proj).created).toBe(false);
  });
});

describe("placement in the core", () => {
  const setup = (name: string) => {
    const fx = fixture(name);
    const f = fakeFactory();
    const core = new Core({ socketPath: path.join(tmp, `${name}.sock`), dbPath: null, ptyFactory: f.factory, pollMs: 0, home: fx.home });
    return { ...fx, core, ptys: f.ptys };
  };

  it("puts new terminals in the Space given, the caller's, or the one containing the cwd", async () => {
    const { core, home, proj, elsewhere } = setup("place");
    const p = (await core.call("space.open", { path: proj })).space;

    const atRoot = await core.call("pane.create", { spaceId: p.id });
    expect(atRoot).toMatchObject({ spaceId: p.id, cwd: proj }); // cwd defaults to the root

    const byCwd = await core.call("pane.create", { cwd: path.join(home, "p", "packages") });
    expect(byCwd.spaceId).toBe(p.id);
    expect((await core.call("pane.create", { cwd: elsewhere })).spaceId).toBe(HOME_SPACE_ID);
    expect((await core.call("pane.create", {})).spaceId).toBe(HOME_SPACE_ID);

    // `cmd new --cwd /elsewhere` from inside a terminal stays in that terminal's Space.
    const fromPane = await core.call("pane.create", { callerPaneId: atRoot.id, cwd: elsewhere });
    expect(fromPane).toMatchObject({ spaceId: p.id, cwd: elsewhere });
    await core.close();
  });

  it("opens windows in the Space, files at its root, targets by path", async () => {
    const { core, proj } = setup("wins");
    const p = (await core.call("space.open", { path: proj })).space;
    expect(await core.call("window.open", { kind: "files", spaceId: p.id })).toMatchObject({ spaceId: p.id, state: { path: proj } });
    fs.writeFileSync(path.join(proj, "notes.txt"), "hi");
    expect((await core.call("window.openTarget", { target: path.join(proj, "notes.txt") }))!.spaceId).toBe(p.id);
    expect((await core.call("window.openTarget", { target: "https://example.com" }))!.spaceId).toBe(HOME_SPACE_ID);
    await core.close();
  });

  it("keeps agents and subagents in their parent's Space and moves trees together", async () => {
    const { core, proj, projOld } = setup("agents");
    const p = (await core.call("space.open", { path: proj })).space;
    const q = (await core.call("space.open", { path: projOld })).space;
    const host = await core.call("agent.spawn", { kind: "claude", spaceId: p.id });
    expect(host).toMatchObject({ spaceId: p.id, cwd: proj });
    const worker = await core.call("agent.spawn", { kind: "codex", parentId: host.id });
    expect(worker.spaceId).toBe(p.id);
    core.agents.ingestHook(host.paneId!, "claude", "SubagentStart", { agent_id: "sub1", agent_type: "Explore" });
    const sub = core.agents.list().find((a) => a.native.claudeAgentId === "sub1")!;
    expect(sub.spaceId).toBe(p.id);

    await core.call("window.move", { id: host.paneId!, spaceId: q.id });
    expect(core.agents.list().map((a) => a.spaceId)).toEqual([q.id, q.id, q.id]);
    expect(core.panes.get(worker.paneId!)!.spaceId).toBe(q.id);
    await core.close();
  });

  it("opens the shell's `open` targets in the pane's Space", async () => {
    const { core, proj, elsewhere } = setup("shell");
    const p = (await core.call("space.open", { path: proj })).space;
    const pane = await core.call("pane.create", { spaceId: p.id });
    core.panes.emit("request", pane.id, "open", elsewhere);
    expect(core.windows.others()).toMatchObject([{ kind: "files", spaceId: p.id, state: { path: elsewhere } }]);
    await core.close();
  });

  it("closing a Space kills only its terminals and removes its windows", async () => {
    const { core, proj } = setup("close");
    const p = (await core.call("space.open", { path: proj })).space;
    const mine = await core.call("pane.create", { spaceId: p.id });
    const other = await core.call("pane.create", {});
    await core.call("window.open", { kind: "files", spaceId: p.id });
    await core.call("window.open", { kind: "browser", input: { url: "example.com" } });
    const events: CoreEvent[] = [];
    core.spaces.on("updated", (space) => events.push({ type: "space.updated", space }));
    await core.call("space.close", { id: p.id });
    expect(core.panes.get(mine.id)).toBeNull();
    expect(core.panes.get(other.id)).not.toBeNull();
    expect(core.windows.others().map((w) => w.spaceId)).toEqual([HOME_SPACE_ID]);
    expect(await core.call("space.list", {})).toMatchObject([{ id: HOME_SPACE_ID }]);
    expect(events.at(-1)).toMatchObject({ space: { id: p.id } });
    await expect(core.call("pane.create", { spaceId: p.id })).rejects.toThrow(/closed/);
    await expect(core.call("space.close", { id: HOME_SPACE_ID })).rejects.toThrow(/Home/);
    await core.close();
  });
});
