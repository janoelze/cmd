// Events read from history (git, older cmds' imports, past sessions and turns)
// belong to the workspace whose folder they happened in, like live ones: new ones
// get it as they're read, the log's older ones from JournalService.assignWorkspaces,
// so a widget, confined to its workspace, sees backfilled commits too.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "@cmd/protocol/node";
import type { AgentTurn, DataEvent, Workspace } from "@cmd/protocol";
import type { SessionRow } from "../src/data/views/sessions.ts";
import { Core, widgetsSocketPath } from "../src/core.ts";
import { JournalService } from "../src/journal/service.ts";
import { JournalStore, type NewJournalEvent } from "../src/journal/store.ts";
import { inlinePacer, type Pacer } from "../src/scheduler.ts";
import { fakeFactory } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

const ws = (id: string, root: string): Workspace => ({ id, name: id, root, home: false, icon: null, order: 0, closedAt: null, createdAt: 0, lastActiveAt: 0, view: {} }) as unknown as Workspace;
const shop = ws("shop", "/Users/sam/src/shop");
const home = { ...ws("home", "/Users/sam"), home: true } as Workspace;

const commit = (repo: string, hash: string, at = 1000): NewJournalEvent => ({
  at,
  until: null,
  kind: "git.commit",
  key: `git:${repo}:commit:${hash}`,
  workspaceId: null,
  repo,
  cwd: repo,
  thread: null,
  text: `commit ${hash}`,
  data: { kind: "git.commit", hash, subject: `commit ${hash}`, branch: "main", worktree: repo },
  source: "backfill",
});

const turn = (cwd: string): { turn: AgentTurn; cwd: string } => ({
  cwd,
  turn: { agentId: "a1", agentKind: "claude", sessionId: "s1", index: 0, startedAt: 2000, endedAt: 3000, prompt: "fix it", followUps: [], final: null, outcome: "done", error: null, auto: false, files: [], commands: [], tools: [] } as unknown as AgentTurn,
});

const session = (id: string, cwd: string): SessionRow => ({ key: `claude:${id}`, id, agent: "claude", path: null, env: null, cwd, branch: null, title: id, first_prompt: null, started: 2000, updated: 3000, messages: 1, project_id: null, name: null, name_by: null, named_at: null });

/** A pacer that counts steps. */
function counting(): Pacer & { steps: number } {
  const p = { steps: 0, yield: () => (p.steps++, inlinePacer.yield()), mark: () => () => {} };
  return p;
}

describe("backfilled events and workspaces", () => {
  it("gives git read from history the workspace its repository is in, and none outside every workspace", async () => {
    const store = new JournalStore();
    const j = new JournalService({ store, workspaces: () => [home, shop], agentWorkspace: () => null, ai: null, now: () => 5000, git: async (repo) => [commit(repo, repo === shop.root ? "in" : "out")], gitStamp: async () => "s" });
    store.recordAll([{ ...commit("/Users/sam/src/other", "seed"), kind: "note", data: { kind: "note", by: "user", agentSession: null } }]);
    await j.sync();
    const byHash = Object.fromEntries(store.data.query({ types: ["git.commit"] }).map((e) => [(e.data as { hash: string }).hash, e.workspaceId]));
    expect(byHash).toEqual({ in: "shop", out: null }); // Home's folder holds the other repository, but Home isn't given
  });

  it("gives past turns and sessions the workspace their folder is in", () => {
    const store = new JournalStore(null, { workspaces: () => [home, shop], turns: () => [turn(`${shop.root}/packages/a`)], sessions: () => [session("in", shop.root), session("out", "/Users/sam/src/other")] });
    const of = Object.fromEntries(store.events().map((e) => [e.key, e.workspaceId]));
    expect(of).toEqual({ "turn:a1:0": "shop", "session:in": "shop", "session:out": null });
    expect(store.events({ workspaceId: "shop" }).map((e) => e.key).sort()).toEqual(["session:in", "turn:a1:0"]);
  });

  it("places the log's workspace-less backfilled rows once a workspace holds them, in paced steps, and only once", async () => {
    const store = new JournalStore();
    // Recorded before the workspace existed: no workspace.
    store.recordAll(Array.from({ length: 1200 }, (_, i) => commit(shop.root, `c${i}`, 1000 + i)));
    store.recordAll([commit("/Users/sam/src/other", "elsewhere"), { ...commit(shop.root, "theirs"), workspaceId: "other-ws" }]);
    // A live command without a workspace in the same folder: not history, left alone.
    store.data.record({ id: "live-cmd", at: 1500, type: "command", source: "osc", projectId: `dir:${shop.root}`, text: "ls", data: { command: "ls", exitCode: 0, cwd: shop.root } });
    let spaces: Workspace[] = [home];
    const pace = counting();
    const j = new JournalService({ store, workspaces: () => spaces, agentWorkspace: () => null, ai: null, pace });
    expect(await j.assignWorkspaces()).toBe(0);
    spaces = [home, shop];
    expect(await j.assignWorkspaces()).toBe(1200);
    expect(pace.steps).toBeGreaterThanOrEqual(2); // 1200 commits: read 500 at a time
    const rows = store.data.query({ types: ["git.commit", "command"], limit: 5000 });
    const of = (id: string) => rows.find((e) => e.id === id)!.workspaceId;
    expect(rows.filter((e) => e.workspaceId === "shop")).toHaveLength(1200);
    expect(of("git:/Users/sam/src/other:commit:elsewhere")).toBeNull();
    expect(of(`git:${shop.root}:commit:theirs`)).toBe("other-ws");
    expect(of("live-cmd")).toBeNull();
    // Again with the same workspaces: not even read; with the log's meta cleared, read but nothing changes.
    const steps = pace.steps;
    expect(await j.assignWorkspaces()).toBe(0);
    expect(pace.steps).toBe(steps);
    store.data.store.setMeta("journal.workspaces", "[]");
    expect(await j.assignWorkspaces()).toBe(0);
    expect(store.data.query({ types: ["git.commit", "command"], limit: 5000 }).map((e) => [e.id, e.workspaceId])).toEqual(rows.map((e) => [e.id, e.workspaceId]));
  });
});

describe("a widget and backfilled commits", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-jws-")));
  const socketPath = path.join(dir, "core.sock");
  const repo = path.join(dir, "shop");
  let core: Core;

  beforeAll(async () => {
    fs.mkdirSync(repo);
    core = new Core({ socketPath, dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0 });
    await core.listen();
  });
  afterAll(async () => {
    await core.close();
    rmTemp(dir);
  });

  it("sees a commit read from git before its workspace was opened", async () => {
    // Read from git while no workspace held the repository.
    core.journal.store.recordAll([commit(repo, "abc", Date.now() - 3600_000)]);
    const { workspace } = core.workspaces.open(repo);
    const w = await connect(widgetsSocketPath(socketPath));
    await w.client.call("widget.hello", { token: core.widgetTokens.issue({ widgetId: "commits", workspaceId: workspace.id, events: [] }) });
    const commits = () => w.client.call("data.query", { query: { types: ["git.commit"] } }) as Promise<DataEvent[]>;
    expect(await commits()).toEqual([]);
    await core.journal.assignWorkspaces();
    expect((await commits()).map((e) => e.text)).toEqual(["commit abc"]);
    w.close();
  });
});
