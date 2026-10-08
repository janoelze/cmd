import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchAgents, nameFromBranch, type Agent } from "@cmd/protocol";
import { connect, type Connection } from "@cmd/protocol/node";
import { foldersOf, worktreeName } from "../src/agents/names.ts";
import { Core } from "../src/core.ts";
import { fakeFactory } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-names-")));
const repo = path.join(dir, "cmd");
const wt = path.join(dir, "cmd-notify-permission");
const wt2 = path.join(dir, "cmd-tours");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });

beforeAll(() => {
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "master");
  fs.writeFileSync(path.join(repo, "a.txt"), "a");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "a");
  git(repo, "worktree", "add", "-q", wt, "-b", "notify-permission");
  git(repo, "worktree", "add", "-q", wt2, "-b", "feature/tours");
});
afterAll(() => rmTemp(dir));

describe("names from branches", () => {
  it("reads a branch as 1–3 words in sentence case", () => {
    expect(nameFromBranch("notify-permission")).toBe("Notify permission");
    expect(nameFromBranch("feature/tours")).toBe("Tours");
    expect(nameFromBranch("fix-flaky-test")).toBe("Flaky test");
    expect(nameFromBranch("agent-state")).toBe("Agent state");
    expect(nameFromBranch("jan/session_names")).toBe("Session names");
    expect(nameFromBranch("ABC-123-login-redirect")).toBe("Login redirect");
  });

  it("gives none for a main line, an id or more than three words", () => {
    for (const b of ["master", "main", "HEAD", null, "1234", "nav-seo-hardening-and-tests"]) expect(nameFromBranch(b)).toBeNull();
  });
});

describe("the worktree an agent works in", () => {
  it("is where it writes, then where it goes, then its cwd", () => {
    expect(foldersOf({ cwd: repo, tool: { name: "Edit", label: null, paths: [path.join(wt, "x.ts")] } }).map((f) => [f.dir, f.wrote])).toEqual([[wt, true], [repo, false]]);
    expect(foldersOf({ cwd: repo, tool: { name: "Bash", label: null, command: `cd ${wt2} && git -C "${wt}" status` } }).map((f) => f.dir)).toEqual([wt2, wt, repo]);
  });

  it("follows variables the command sets, and leaves out ones it doesn't", () => {
    const dirs = (command: string) => foldersOf({ cwd: repo, tool: { name: "Bash", label: null, command } }).map((f) => f.dir);
    expect(dirs(`WT=${wt} && git worktree add -q "$WT" main && cd "$WT" && ls`)).toEqual([wt, repo]);
    expect(dirs(`export D="${dir}"; cd \${D}/cmd-tours`)).toEqual([wt2, repo]);
    expect(dirs(`cd "$SOMEWHERE" && ls`)).toEqual([repo]);
  });

  it("names from a linked worktree, never the main checkout", () => {
    expect(worktreeName({ cwd: repo, tool: { name: "Edit", label: null, paths: [path.join(wt, "a.txt")] } })).toMatchObject({ name: "Notify permission", wrote: true });
    expect(worktreeName({ cwd: wt2, tool: undefined })).toMatchObject({ name: "Tours", wrote: false });
    expect(worktreeName({ cwd: repo, tool: undefined })).toBeNull();
  });
});

describe("agents by name", () => {
  const a = (id: string, name: string | null, spaceId = "s1", extra: Partial<Agent> = {}) => ({ id, name, spaceId, ...extra });
  const agents = [a("aaaa1111", "Notify permission"), a("bbbb2222", "Tours"), a("cccc3333", "Tours", "s2"), a("dddd4444", "Session names", "s1", { nameWas: "Data model", namedAt: 1000 })];

  it("takes an id or its start first", () => {
    expect(matchAgents(agents, "bbbb").map((x) => x.id)).toEqual(["bbbb2222"]);
  });

  it("matches names loosely, in the caller's Space first", () => {
    expect(matchAgents(agents, "notify-permission").map((x) => x.id)).toEqual(["aaaa1111"]);
    expect(matchAgents(agents, "NOTIFY PERMISSION").map((x) => x.id)).toEqual(["aaaa1111"]);
    expect(matchAgents(agents, "Tours", { spaceId: "s2" }).map((x) => x.id)).toEqual(["cccc3333"]);
    expect(matchAgents(agents, "tours").length).toBe(2);
    expect(matchAgents(agents, "perm").map((x) => x.id)).toEqual(["aaaa1111"]);
  });

  it("still answers to a former name for an hour", () => {
    expect(matchAgents(agents, "data model", { now: 2000 }).map((x) => x.id)).toEqual(["dddd4444"]);
    expect(matchAgents(agents, "data model", { now: 1000 + 3_600_001 })).toEqual([]);
  });
});

describe("names in the core", () => {
  const socketPath = path.join(dir, "core.sock");
  let core: Core;
  let conn: Connection;
  beforeAll(async () => {
    core = new Core({ socketPath, dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0 });
    await core.listen();
    conn = await connect(socketPath);
  });
  afterAll(async () => {
    conn.close();
    await core.close();
  });

  const names = () => core.data.query({ types: ["session.name"], by: "seq" }).map((e) => [e.sessionId, e.data]);

  it("names an agent from the worktree it writes in, and records it with its session", () => {
    const pane = core.panes.create({ cwd: repo });
    core.agents.ingestHook(pane.id, "claude", "SessionStart", { session_id: "s1", cwd: repo });
    const a = core.agents.ingestHook(pane.id, "claude", "PreToolUse", { session_id: "s1", cwd: repo, tool_name: "Edit", tool_input: { file_path: path.join(wt, "a.txt"), old_string: "a", new_string: "b" } })!;
    expect(core.agents.get(a.id)).toMatchObject({ name: "Notify permission", nameBy: "worktree" });
    expect(names()).toEqual([["claude:s1", expect.objectContaining({ name: "Notify permission", by: "worktree", lang: "en" })]]);
    expect(core.sessions.get("claude:s1")).toMatchObject({ name: "Notify permission", name_by: "worktree" });
  });

  it("only renames on a write elsewhere, not a look", () => {
    const [a] = core.agents.list();
    core.agents.ingestHook(a!.paneId!, "claude", "PreToolUse", { session_id: "s1", cwd: repo, tool_name: "Bash", tool_input: { command: `cd ${wt2} && git log` } });
    expect(core.agents.get(a!.id)!.name).toBe("Notify permission");
    core.agents.ingestHook(a!.paneId!, "claude", "PreToolUse", { session_id: "s1", cwd: repo, tool_name: "Write", tool_input: { file_path: path.join(wt2, "b.txt"), content: "b" } });
    expect(core.agents.get(a!.id)).toMatchObject({ name: "Tours", nameWas: "Notify permission" });
  });

  it("keeps a person's name over the worktree's, and hands naming back", async () => {
    const [a] = core.agents.list();
    const r = await conn.client.call("agent.rename", { agentId: a!.id, name: "  Hack   the planet " });
    expect(r).toMatchObject({ name: "Hack the planet", nameBy: "user", nameWas: "Tours" });
    core.agents.ingestHook(a!.paneId!, "claude", "PreToolUse", { session_id: "s1", cwd: repo, tool_name: "Write", tool_input: { file_path: path.join(wt, "c.txt"), content: "c" } });
    expect(core.agents.get(a!.id)!.name).toBe("Hack the planet");
    expect(core.sessions.get("claude:s1")).toMatchObject({ name: "Hack the planet", name_by: "user" });

    await conn.client.call("agent.rename", { agentId: a!.id, name: null });
    expect(core.agents.get(a!.id)).toMatchObject({ name: null, nameBy: null });
    core.agents.ingestHook(a!.paneId!, "claude", "PreToolUse", { session_id: "s1", cwd: repo, tool_name: "Write", tool_input: { file_path: path.join(wt, "c.txt"), content: "c" } });
    expect(core.agents.get(a!.id)!.name).toBe("Notify permission");
  });

  it("keeps names when the sessions view is rebuilt", async () => {
    await core.sessions.rebuild();
    expect(core.sessions.get("claude:s1")).toMatchObject({ name: "Notify permission", name_by: "worktree" });
  });
});
