// API 1.3's Workspace Actions (docs/57 "1.3 additions" C14; widgets/api/actions.ts, model.ts's
// apiAction, act.ts's actions.run) against a Core with a repository and a linked worktree: each
// new field of an action, its source file relative to the root (no absolute path reaches the
// widget but the folder itself); `root` only a worktree of the workspace's repository, as git
// lists it (a `..`, a symlink out, another repository, a subfolder are refused); `include`;
// actionsInfo; the live list kept read while subscribed; `fresh` in a new terminal; a recipe
// with arguments typed, not run; and a risky action that asks every time with its command (a
// yes never kept, a no runs nothing, never from a paired device) while a non-risky one keeps
// 1.2's behaviour (a yes kept for the session).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { noPermissions, type ApiAction, type ApiMethods, type ApiVerb, type CoreEvent, type ToolActivity, type WidgetPermissions, type WireValue, type Workspace } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { projectIdOf } from "../src/data/project.ts";
import { Approvals } from "../src/tools/approvals.ts";
import { ApiRefusal } from "../src/widgets/api/access.ts";
import { AiUsage } from "../src/widgets/api/ai.ts";
import { widgetApi, type WidgetApi } from "../src/widgets/api/adapter.ts";
import { fakeFactory, type FakePty } from "./fake-pty.ts";
import { tmp, until, writePackage } from "./fake-widget-runtime.ts";

let core: Core;
let ptys: FakePty[];
let A: Workspace;
let repo: string;
let wt: string;
let windowId: string;
const events: CoreEvent[] = [];
const shown: ToolActivity[] = [];
let approvals: Approvals;
let remote = false;
/** The person's levels (Settings → AI & Agents → Permissions); unset is Ask. */
let levels: Record<string, string> = {};

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });

function adapter(permissions: Partial<WidgetPermissions> = { workspace: ["read"], act: ["actions"] }, o: { builtin?: boolean } = {}): WidgetApi {
  const found = core.library.packages.forKind("pkg:demo/main")!;
  const pkg = o.builtin ? { ...found, builtin: true } : found;
  const ctx = { agents: core.agents, panes: core.panes, windows: core.windows, windowTypes: core.windowTypes, workspaces: core.workspaces, data: core.data, actions: core.actions, notifications: core.notifications, ai: core.ai, settings: core.settings, resources: core.resources, stats: core.stats, journal: core.journal, processes: core.processes, commands: core.commands, broadcast: (e: CoreEvent) => void events.push(e), opened: <W>(w: W) => w, call: core.call.bind(core) as never };
  return widgetApi(ctx, {
    windowId,
    workspaceId: () => A.id,
    pkg,
    widget: pkg.widgets[0]!,
    permissions: { ...noPermissions(), ...permissions },
    // Every act comes right after a press, from this Mac unless `remote`.
    press: { at: () => Date.now(), remote: () => remote, take: () => {} },
    acts: () => ({ approvals, show: (a) => void shown.push(a) }),
    secret: () => null,
    aiUsage: new AiUsage(null),
  });
}

async function call<V extends ApiVerb>(api: WidgetApi, verb: V, ...params: ApiMethods[V]["params"]): Promise<ApiMethods[V]["result"]> {
  return (await api.call(verb, params as WireValue[])) as ApiMethods[V]["result"];
}

async function refusal(p: Promise<unknown> | (() => unknown)): Promise<ApiRefusal["error"]> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (e instanceof ApiRefusal) return e.error;
    throw e;
  }
  throw new Error("it wasn't refused");
}

/** The ask now waiting (not answered yet), once the act shows it. */
const answered = new Set<string>();
async function asked(): Promise<ToolActivity> {
  await until(() => shown.some((a) => a.state === "waiting" && !answered.has(a.id)), "the ask");
  return shown.find((a) => a.state === "waiting" && !answered.has(a.id))!;
}
async function answer(allow: boolean, scope?: "once" | "session" | "always"): Promise<ToolActivity> {
  const a = await asked();
  answered.add(a.id);
  approvals.answer(a.workspaceId, a.id, { allow, ...(scope ? { scope } : {}) });
  return a;
}
const waiting = () => shown.filter((a) => a.state === "waiting" && !answered.has(a.id));
const byName = (list: ApiAction[], name: string) => list.find((a) => a.name === name)!;
const flush = () => new Promise<void>((r) => setImmediate(r));
/** Every run's terminal closed (a fake terminal never ends its command): nothing runs anywhere. */
const endRuns = async () => {
  for (const root of [repo, wt]) for (const r of core.actions.list(root).runs) core.panes.kill(r.paneId);
  await until(() => [repo, wt].every((root) => core.actions.list(root).runs.length === 0), "the runs to end");
};

beforeAll(async () => {
  const home = tmp("cmd-widgets-home-");
  writePackage(home);
  process.env.CMD_WIDGETS_HOME = home;
  const f = fakeFactory();
  ptys = f.ptys;
  core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: f.factory, pollMs: 0 });
  delete process.env.CMD_WIDGETS_HOME;
  core.start();
  await core.scheduler.idle();
  core.library.packages.start();
  approvals = new Approvals(new DatabaseSync(":memory:"), () => levels as never);

  // A repository: scripts (one risky, one hidden), a just recipe that needs an argument; a linked worktree on "feat".
  repo = fs.realpathSync(tmp("cmd-widget-actions-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { dev: "vite --port 3000", test: "vitest run", pretest: "echo pre", deploy: "wrangler deploy" } }, null, 2));
  fs.writeFileSync(path.join(repo, "justfile"), "# Say hi\ngreet name:\n    echo hi {{name}}\n");
  fs.mkdirSync(path.join(repo, "web"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  wt = path.join(fs.realpathSync(tmp("cmd-widget-wt-")), "feat");
  git(repo, "worktree", "add", "-q", wt, "-b", "feat");
  // The person's history: a command run here often that no file names.
  const projectId = projectIdOf(repo);
  for (let i = 0; i < 3; i++) core.data.record({ id: `cmd-${i}`, at: Date.now() - 60_000 * (i + 1), until: Date.now() - 60_000 * (i + 1) + 100, type: "command", source: "osc", workspaceId: null, projectId, text: "cargo fmt --all", data: { command: "cargo fmt --all", exitCode: 0, cwd: repo, git: null, output: null } });
  A = core.workspaces.open(repo).workspace;
  windowId = core.windows.open("pkg:demo/main", {}, A).id;
});

afterAll(async () => {
  await core?.close();
});

describe("API 1.3: the actions' records", () => {
  it("gives each action its script, args, hidden, source, history, run times and runs elsewhere, every path relative to the root", async () => {
    const api = adapter();
    const list = await call(api, "actions.list");
    const dev = byName(list, "dev");
    expect(dev).toMatchObject({ script: "vite --port 3000", args: false, hidden: false, source: { kind: "file", file: "package.json", line: expect.any(Number) }, history: null, startedAt: null, endedAt: null, elsewhere: [] });
    expect(byName(list, "pretest").hidden).toBe(true);
    expect(byName(list, "greet")).toMatchObject({ args: true, source: { kind: "file", file: "justfile", line: 2 } });
    expect(byName(list, "deploy").risky).toBe(true);
    // No absolute path in what a widget gets: the folders' paths never appear.
    expect(JSON.stringify(list)).not.toContain(repo);
    expect(JSON.stringify(list)).not.toContain(wt);

    // A run here: its start; and the same action running in the worktree shows as elsewhere, with its branch and terminal.
    const local = core.actions.list(repo);
    const r = await core.call("actions.run", { root: repo, actionId: local.actions.find((a) => a.name === "test")!.id, workspaceId: A.id });
    const there = core.actions.list(wt);
    const w = await core.call("actions.run", { root: wt, actionId: there.actions.find((a) => a.name === "dev")!.id, workspaceId: A.id });
    const after = await call(api, "actions.list");
    expect(byName(after, "test")).toMatchObject({ running: true, terminalId: r.paneId, startedAt: expect.any(Number), endedAt: null });
    expect(byName(after, "dev").elsewhere).toEqual([{ branch: "feat", terminalId: w.paneId, url: null }]);
    await endRuns();
  });

  it("adds the person's history and the README's suggestions only when asked (include)", async () => {
    const api = adapter();
    expect((await call(api, "actions.list")).some((a) => a.source?.kind === "history")).toBe(false);
    const withHistory = await call(api, "actions.list", { include: ["history"] });
    expect(withHistory.find((a) => a.source?.kind === "history")).toMatchObject({ name: "cargo fmt --all", command: "cargo fmt --all", source: { kind: "history", file: null, line: null }, history: { runs: 3 } });
    // An unknown kind is ignored; suggestions come from the README through the AI (none here).
    expect((await call(api, "actions.list", { include: ["suggested", "nonsense" as never] })).some((a) => a.source?.kind === "history")).toBe(false);
  });
});

describe("API 1.3: root, a worktree of the workspace's repository", () => {
  it("lists a linked worktree's actions, and says where they are (actionsInfo)", async () => {
    const api = adapter();
    const there = await call(api, "actions.list", { root: wt });
    expect(byName(there, "dev").source).toEqual({ kind: "file", file: "package.json", line: expect.any(Number) });
    expect(await call(api, "actions.info", { root: wt })).toEqual({ root: wt, branch: "feat", linked: true, describing: false, errors: [] });
    expect(await call(api, "actions.info")).toEqual({ root: repo, branch: "main", linked: false, describing: false, errors: [] });
    // The main checkout by its path is the workspace's folder.
    expect((await call(api, "actions.list", { root: repo })).map((a) => a.name)).toEqual((await call(api, "actions.list")).map((a) => a.name));
  });

  it("refuses any other folder: relative, with .., a subfolder, a symlink out, another repository, one that isn't there", async () => {
    const api = adapter();
    const other = fs.realpathSync(tmp("cmd-widget-other-repo-"));
    git(other, "init", "-q", "-b", "main");
    fs.symlinkSync(other, path.join(repo, "out"));
    fs.symlinkSync(wt, path.join(repo, "to-wt"));
    for (const root of ["feat", "web", `${repo}/web/..`, `${wt}/../feat`, path.join(repo, "web"), path.join(repo, "out"), other, "/", path.join(repo, "nope"), 42]) {
      expect(await refusal(call(api, "actions.list", { root: root as string })), String(root)).toMatchObject({ code: "invalid", message: expect.stringContaining("isn't a worktree of this workspace's repository") });
      expect((await refusal(call(api, "actions.info", { root: root as string }))).code).toBe("invalid");
      expect(await refusal(() => api.subscribe("actions", { root }, () => {}))).toMatchObject({ code: "invalid" });
    }
    // A symlink to a worktree is that worktree, by its real path.
    expect((await call(api, "actions.info", { root: path.join(repo, "to-wt") }))!.root).toBe(wt);
    // An act names the root the same way.
    expect(await refusal(call(api, "actions.run", "dev", { root: other }))).toMatchObject({ code: "invalid" });
    expect(waiting()).toEqual([]);
    fs.unlinkSync(path.join(repo, "out"));
    fs.unlinkSync(path.join(repo, "to-wt"));
  });

  it("names a file that can't be read, relative and without the folder's path", async () => {
    const api = adapter();
    fs.writeFileSync(path.join(wt, "package.json"), "{ not json");
    core.actions.refresh(wt);
    const info = await call(api, "actions.info", { root: wt });
    expect(info!.errors).toEqual([{ file: "package.json", error: expect.any(String) }]);
    expect(JSON.stringify(info!.errors)).not.toContain(wt);
    git(wt, "checkout", "--", "package.json");
    core.actions.refresh(wt);
  });

  it("is live, and keeps the worktree read while subscribed", async () => {
    const api = adapter();
    const got: WireValue[] = [];
    const stop = api.subscribe("actions", { root: wt, include: ["history"] }, (d) => void got.push(d));
    const info: WireValue[] = [];
    const stopInfo = api.subscribe("actionsInfo", { root: wt }, (d) => void info.push(d));
    await flush();
    expect(got).toHaveLength(1);
    expect(info).toEqual([{ root: wt, branch: "feat", linked: true, describing: false, errors: [] }]);
    const scripts = JSON.parse(fs.readFileSync(path.join(wt, "package.json"), "utf8"));
    fs.writeFileSync(path.join(wt, "package.json"), JSON.stringify({ ...scripts, scripts: { ...scripts.scripts, lint: "eslint ." } }, null, 2));
    core.actions.refresh(wt);
    await until(() => got.length === 2, "the list again");
    expect((got[1] as unknown as ApiAction[]).some((a) => a.name === "lint")).toBe(true);
    stop();
    stopInfo();
    git(wt, "checkout", "--", "package.json");
    core.actions.refresh(wt);
  });
});

describe("API 1.3: actions.run", () => {
  // Each starts with nothing kept: a yes kept for the window's session goes.
  beforeEach(async () => {
    approvals.endSession(`widget:${windowId}`);
    await endRuns();
  });

  it("keeps 1.2's behaviour for a non-risky action: asks, a yes kept for the session", async () => {
    const api = adapter();
    const first = call(api, "actions.run", "test");
    const a = await answer(true, "session");
    expect(a.approval).toMatchObject({ title: "Run “test”", exact: "npm run test", permission: "run", scopes: ["once", "session", "always"] });
    expect(a.approval).not.toHaveProperty("risky");
    const r = await first;
    expect(r.started).toBe(true);
    // Kept: the next run asks nothing (it is already running, so it says where).
    const before = waiting().length;
    expect(await call(api, "actions.run", "test")).toEqual({ terminalId: r.terminalId, started: false });
    expect(waiting().length).toBe(before);
  });

  it("runs in a new terminal with fresh, even while its last run goes on", async () => {
    const api = adapter();
    const p = call(api, "actions.run", "test");
    await answer(true);
    const ran = await p;
    const f = call(api, "actions.run", "test", { fresh: true });
    expect((await answer(true)).approval).toMatchObject({ title: "Run “test” in a new terminal" });
    const fresh = await f;
    expect(fresh.started).toBe(true);
    expect(fresh.terminalId).not.toBe(ran.terminalId);
    expect(core.panes.get(fresh.terminalId)!.cwd).toBe(repo);
  });

  it("runs an action of a worktree in that worktree", async () => {
    const api = adapter();
    const p = call(api, "actions.run", "dev", { root: wt });
    await answer(true);
    const r = await p;
    expect(core.panes.get(r.terminalId)!.cwd).toBe(wt);
    expect(core.actions.list(wt).runs.some((x) => x.paneId === r.terminalId && x.endedAt === null)).toBe(true);
    const p2 = call(api, "actions.stop", "dev", { root: wt });
    await answer(true);
    await p2;
  });

  it("types a recipe that needs arguments into a new terminal for the person to finish, never runs it", async () => {
    const api = adapter();
    const p = call(api, "actions.run", "greet");
    const a = await answer(true);
    expect(a.approval).toMatchObject({ title: "Type “greet” in a new terminal", exact: "just greet", permission: "show" });
    const r = await p;
    expect(r.started).toBe(false);
    const pty = ptys.find((x) => (x.opts as { env?: Record<string, string> }).env?.CMD_PANE_ID === r.terminalId)!;
    expect((pty.opts as { env: Record<string, string> }).env.CMD_RESTORE_COMMAND).toBe("just greet ");
    expect(core.panes.get(r.terminalId)!.cwd).toBe(repo);
    expect(core.actions.list(repo).runs.some((x) => x.paneId === r.terminalId)).toBe(false);
  });

  it("asks every time for a risky action, showing its command; a yes isn't kept and a no runs nothing", async () => {
    const api = adapter();
    const panes = core.panes.list().length;
    // No: nothing runs.
    const no = call(api, "actions.run", "deploy");
    const asked1 = await answer(false);
    expect(asked1.approval).toMatchObject({ title: "Run “deploy”?", exact: "npm run deploy", permission: "run", risky: true, scopes: ["once"] });
    expect(await refusal(no)).toMatchObject({ code: "denied" });
    expect(core.panes.list().length).toBe(panes);
    expect(core.actions.list(repo).runs.some((x) => x.actionId.endsWith(":deploy"))).toBe(false);

    // Yes, even for always: it runs, once.
    const yes = call(api, "actions.run", "deploy");
    await answer(true, "always");
    const r = await yes;
    expect(r.started).toBe(true);
    expect(core.actions.list(repo).runs.some((x) => x.paneId === r.terminalId && x.actionId.endsWith(":deploy"))).toBe(true);
    expect(approvals.list(A.id)).toEqual([]);
    await endRuns();

    // And the next run asks again, in a new terminal too.
    const again = call(api, "actions.run", "deploy", { fresh: true });
    expect((await answer(true)).approval).toMatchObject({ title: "Run “deploy”?", risky: true, scopes: ["once"] });
    await again;
  });

  it("asks for a risky action even when non-risky runs are kept for the session", async () => {
    const api = adapter();
    const p = call(api, "actions.run", "dev");
    await answer(true, "session");
    await p;
    const risky = call(api, "actions.run", "deploy");
    const a = await answer(false);
    expect(a.approval).toMatchObject({ risky: true, scopes: ["once"] });
    await refusal(risky);
  });

  it("asks for a risky action from a built-in package too, where Run is set to Allow", async () => {
    levels = { run: "allow" };
    try {
      const api = adapter(undefined, { builtin: true });
      const before = waiting().length;
      expect((await call(api, "actions.run", "test")).started).toBe(true);
      expect(waiting().length).toBe(before);
      const risky = call(api, "actions.run", "deploy");
      expect((await answer(true, "session")).approval).toMatchObject({ title: "Run “deploy”?", risky: true, scopes: ["once"] });
      await risky;
      const again = call(api, "actions.run", "deploy", { fresh: true });
      expect((await answer(false)).approval).toMatchObject({ risky: true, scopes: ["once"] });
      await refusal(again);
    } finally {
      levels = {};
    }
  });

  it("refuses a risky action pressed on a paired device, before any sheet", async () => {
    const api = adapter();
    remote = true;
    try {
      const before = waiting().length;
      expect(await refusal(call(api, "actions.run", "deploy"))).toEqual({ code: "denied", message: "“deploy” is risky, so it runs only from this Mac." });
      expect(waiting().length).toBe(before);
      expect(shown.at(-1)).toMatchObject({ tool: "actions.run", state: "denied" });
    } finally {
      remote = false;
    }
  });
});
