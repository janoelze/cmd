import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { API, API_VERBS, type CoreEvent, type Method } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { checkRemoteCall, MAX_WATCHES, NO_ARGS, REMOTE_ACCESS, RemoteDenied, remoteEvent, remoteEventVisible, remoteResult, scopeAllows, type PolicyContext } from "../src/remote/policy.ts";
import { fakeFactory } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-policy-")));
const core = new Core({ socketPath: path.join(home, "core.sock"), dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, home });
const ctx: PolicyContext = { panes: core.panes, agents: core.agents, workspaces: core.workspaces, windows: core.windows, windowTypes: core.windowTypes, home };
afterAll(async () => {
  await core.close();
  rmTemp(home);
});

const denied = (method: string, params: unknown, scope: "view" | "control" = "control") => {
  try {
    checkRemoteCall(method, params, scope, ctx);
    return null;
  } catch (err) {
    if (!(err instanceof RemoteDenied)) throw err;
    return err.message;
  }
};

describe("remote policy table", () => {
  it("has an entry for every method the core handles", () => {
    expect(Object.keys(REMOTE_ACCESS).sort()).toEqual(Object.keys(core.handlers).sort());
  });

  it("applies scopes as the table says", () => {
    for (const [m, access] of Object.entries(REMOTE_ACCESS) as [Method, string][]) {
      expect(scopeAllows("view", REMOTE_ACCESS[m]), m).toBe(access === "view");
      expect(scopeAllows("control", REMOTE_ACCESS[m]), m).toBe(access !== "never");
    }
    expect(denied("settings.set", { key: "remote.enabled", value: false })).toMatch(/isn't available/);
    expect(denied("pane.write", { paneId: "x", data: "" }, "view")).toMatch(/needs control/);
    expect(denied("no.such.method", {})).toMatch(/isn't available/);
    expect(denied("__proto__", {})).toMatch(/isn't available/);
  });

  it("checks that targets exist", () => {
    expect(denied("pane.write", { paneId: "nope", data: "ls" })).toMatch(/no such terminal/);
    const pane = core.panes.create({ workspaceId: core.workspaces.home().id });
    expect(denied("pane.write", { paneId: pane.id, data: "ls\r" })).toBeNull();
    expect(denied("pane.write", { paneId: pane.id, data: "x".repeat(65 * 1024) })).toMatch(/too long/);
  });

  it("never treats Home as a root: with only Home open, nothing in the home folder is reachable", () => {
    expect(core.workspaces.list().map((s) => s.id)).toEqual([core.workspaces.home().id]);
    fs.writeFileSync(path.join(home, "x"), "hi");
    fs.mkdirSync(path.join(home, "dir"));
    for (const scope of ["view", "control"] as const) {
      for (const [method, params] of [
        ["fs.read", { path: path.join(home, "x") }],
        ["fs.list", { path: path.join(home, "dir") }],
        ["fs.list", { path: "~" }],
        ["fs.watch", { path: home }],
        ["git.status", { path: path.join(home, "x") }],
        ["sqlite.schema", { path: path.join(home, "x") }],
        ["sqlite.rows", { path: path.join(home, "x"), table: "t" }],
        ["sqlite.query", { path: path.join(home, "x"), sql: "SELECT 1" }],
      ] as const) {
        expect(denied(method, params, scope), `${scope} ${method}`).toMatch(/outside your workspaces/);
      }
    }
  });

  it("keeps paths inside open workspaces and off private files", () => {
    fs.mkdirSync(path.join(home, "proj"));
    fs.writeFileSync(path.join(home, "proj/a.txt"), "hi");
    fs.writeFileSync(path.join(home, "proj/.env"), "TOKEN=1");
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.symlinkSync("/etc", path.join(home, "proj/etc"));
    expect(denied("fs.read", { path: path.join(home, "proj/a.txt") })).toMatch(/outside your workspaces/);
    const ws = core.workspaces.open(path.join(home, "proj")).workspace;
    expect(ws.home).toBeFalsy();
    expect(denied("fs.read", { path: path.join(home, "proj/a.txt") })).toBeNull();
    expect(denied("fs.write", { path: path.join(home, "proj/new.txt"), text: "" })).toBeNull();
    expect(denied("fs.read", { path: "/etc/hosts" })).toMatch(/outside/);
    expect(denied("fs.read", { path: path.join(home, "proj/../../etc/hosts") })).toMatch(/outside/);
    expect(denied("fs.read", { path: path.join(home, "proj/etc/hosts") })).toMatch(/outside/);
    expect(denied("fs.read", { path: path.join(home, "proj/.env") })).toMatch(/private/);
    expect(denied("fs.list", { path: path.join(home, ".ssh") })).toMatch(/outside/);
    expect(denied("fs.read", { path: "proj/a.txt" })).toMatch(/absolute/);
    expect(denied("fs.rename", { path: path.join(home, "proj/a.txt"), name: "b.txt" })).toBeNull();
    expect(denied("fs.rename", { path: path.join(home, "proj/a.txt"), name: ".env" })).toMatch(/private/);
    expect(denied("fs.rename", { path: path.join(home, "proj/a.txt"), name: "../../x" })).toMatch(/bad name/);
    core.workspaces.markClosed(ws.id);
    expect(denied("fs.read", { path: path.join(home, "proj/a.txt") })).toMatch(/outside your workspaces/);
  });

  it("keeps cmd's own state, credentials and agents' transcripts private even inside a workspace", () => {
    // A workspace whose root holds all of them: a home folder (h) opened as a plain workspace.
    const h = path.join(home, "h");
    const support = path.join(h, "Library/Application Support");
    const files = [
      path.join(support, "cmd/remote/host.json"),
      path.join(support, "cmd/secrets.json"),
      path.join(support, "cmd-dev/remote/host.json"),
      path.join(support, "cmd-dev/secrets.json"),
      path.join(h, ".config/cmd/settings.json"),
      path.join(h, "Library/Logs/cmd/core.log"),
      path.join(h, "src/cmd-x/.cmd-dev/remote/host.json"),
      path.join(h, "src/cmd-x/.cmd-dev/settings.json"),
      path.join(h, "src/cmd-x/.cmd-dev/secrets.json"),
      path.join(h, ".ssh/id_ed25519"),
      path.join(h, ".zsh_history"),
      path.join(h, ".config/gh/hosts.yml"),
      path.join(h, ".claude/projects/p/s.jsonl"),
      path.join(h, ".codex/sessions/2026/01/01/r.jsonl"),
    ];
    for (const f of files) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "secret");
    }
    // This instance's own folder, wherever $CMD_HOME puts it.
    const own = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-policy-own-")));
    fs.writeFileSync(path.join(own, "host.json"), "secret");
    const extra = path.join(h, "elsewhere/agent-home");
    fs.writeFileSync(path.join(h, "notes.txt"), "hi");
    fs.mkdirSync(extra, { recursive: true });
    fs.writeFileSync(path.join(extra, "t.jsonl"), "secret");
    vi.stubEnv("CMD_HOME", own);
    const all = core.workspaces.open(h, { gitRoot: false }).workspace;
    const ownWs = core.workspaces.open(own, { gitRoot: false }).workspace;
    const withPrivate: PolicyContext = { ...ctx, home: h, private: () => [extra] };
    const check = (method: string, params: unknown, scope: "view" | "control") => {
      try {
        checkRemoteCall(method, params, scope, withPrivate);
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    };
    try {
      expect(all.home).toBeFalsy();
      for (const f of [...files, path.join(own, "host.json"), path.join(extra, "t.jsonl")]) {
        for (const scope of ["view", "control"] as const) {
          expect(check("fs.read", { path: f }, scope), f).toMatch(/private/);
          if (path.dirname(f) !== h) expect(check("fs.list", { path: path.dirname(f) }, scope), f).toMatch(/private/);
        }
      }
      expect(check("fs.read", { path: path.join(h, "notes.txt") }, "view")).toBeNull();
      expect(check("fs.list", { path: h }, "view")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      core.workspaces.markClosed(all.id);
      core.workspaces.markClosed(ownWs.id);
      rmTemp(own);
    }
  });

  it("refuses ATTACH, DETACH and VACUUM in SQLite queries", () => {
    const dir = path.join(home, "db");
    fs.mkdirSync(dir);
    const ws = core.workspaces.open(dir, { gitRoot: false }).workspace;
    const db = path.join(dir, "a.db");
    try {
      expect(denied("sqlite.query", { path: db, sql: "SELECT 1" }, "view")).toBeNull();
      for (const sql of [
        `ATTACH '${path.join(home, "secret.db")}' AS x`,
        `attach database '/x.db' as x`,
        `  -- hi\n/* there */ ;AtTaCh '/x.db' AS x`,
        "DETACH x",
        "VACUUM INTO '/tmp/copy.db'",
      ]) {
        for (const scope of ["view", "control"] as const) expect(denied("sqlite.query", { path: db, sql }, scope), sql).toMatch(/isn't allowed/);
      }
    } finally {
      core.workspaces.markClosed(ws.id);
    }
  });

  it("checks the arguments of every reachable method that has any", () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "../src/remote/policy.ts"), "utf8");
    const args = src.slice(src.indexOf("const ARGS"), src.indexOf("// ── argument checks"));
    const checked = new Set([...args.matchAll(/^  "([a-z][\w.]+)":/gm)].map((m) => m[1]));
    const reachable = (Object.keys(REMOTE_ACCESS) as Method[]).filter((m) => REMOTE_ACCESS[m] !== "never");
    expect(reachable.filter((m) => !checked.has(m) && !NO_ARGS.has(m))).toEqual([]);
    expect([...NO_ARGS].filter((m) => checked.has(m) || REMOTE_ACCESS[m] === "never")).toEqual([]);
    expect(denied("jam.change", { code: "x".repeat(70_000), request: "r" })).toMatch(/too long/);
  });

  it("tells a device only of open workspaces, without prompts or window state", async () => {
    fs.mkdirSync(path.join(home, "shown"), { recursive: true });
    fs.mkdirSync(path.join(home, "gone"), { recursive: true });
    const shown = core.workspaces.open(path.join(home, "shown")).workspace;
    const gone = core.workspaces.open(path.join(home, "gone")).workspace;
    const p1 = core.panes.create({ cwd: path.join(home, "shown"), workspaceId: shown.id });
    const p2 = core.panes.create({ cwd: path.join(home, "gone"), workspaceId: gone.id });
    const browser = core.windows.open("browser", { url: "https://example.test/private-page" }, shown);
    core.workspaces.markClosed(gone.id);
    const boot = remoteResult("remote.bootstrap", await core.call("remote.bootstrap", {}), ctx) as { panes: { id: string }[]; workspaces: { id: string }[]; windows: { id: string; state: Record<string, unknown> }[] };
    expect(boot.panes.map((p) => p.id)).toContain(p1.id);
    expect(boot.panes.map((p) => p.id)).not.toContain(p2.id);
    expect(boot.workspaces.map((w) => w.id)).not.toContain(gone.id);
    expect(boot.windows.find((w) => w.id === browser.id)?.state).toEqual({});
    // Its title is what it shows now; its state (history, the page before) stays on the Mac.
    expect((remoteResult("window.list", core.windows.list(), ctx) as { state: unknown }[]).every((w) => JSON.stringify(w.state) === "{}")).toBe(true);
    expect(core.windows.list().find((w) => w.id === browser.id)?.state).not.toEqual({});
    expect(remoteEvent({ type: "pane.updated", pane: core.panes.get(p2.id)! }, ctx, new Set(), [])).toBeNull();
    expect(remoteEvent({ type: "pane.updated", pane: core.panes.get(p1.id)! }, ctx, new Set(), [])).not.toBeNull();
    expect(remoteEvent({ type: "window.updated", window: browser }, ctx, new Set(), [])).toMatchObject({ window: { state: {} } });
    expect(remoteEvent({ type: "workspace.updated", workspace: core.workspaces.get(gone.id)! }, ctx, new Set(), [])).toEqual({ type: "workspace.removed", id: gone.id });
    const agent = { id: "a", paneId: p1.id, workspaceId: shown.id, lastPrompt: "my secret", spawn: { source: "user", prompt: "also secret" } };
    expect(JSON.stringify(remoteEvent({ type: "agent.updated", agent } as never, ctx, new Set(), []))).not.toContain("secret");
  });

  it("lets a session watch 32 paths, not 33", async () => {
    fs.mkdirSync(path.join(home, "watched"), { recursive: true });
    core.workspaces.open(path.join(home, "watched"));
    const replies: { id: number; result?: unknown; error?: { message: string } }[] = [];
    const served = core.serve({ access: "view", deviceId: "d", send: (l) => void replies.push(JSON.parse(l)), close: () => {} });
    for (let i = 0; i <= MAX_WATCHES; i++) {
      const dir = path.join(home, "watched", `d${i}`);
      fs.mkdirSync(dir, { recursive: true });
      served.receive(JSON.stringify({ jsonrpc: "2.0", id: i, method: "fs.watch", params: { path: dir } }));
    }
    await vi.waitFor(() => expect(replies).toHaveLength(MAX_WATCHES + 1));
    expect(replies.filter((r) => r.error)).toEqual([{ jsonrpc: "2.0", id: MAX_WATCHES, error: { code: -32001, message: `watching ${MAX_WATCHES} paths already` } }]);
    served.closed();
  });

  it("filters events", () => {
    const out: CoreEvent = { type: "pane.output", paneId: "p1", data: "x" };
    expect(remoteEventVisible(out, new Set(), [])).toBe(false);
    expect(remoteEventVisible(out, new Set(["p1"]), [])).toBe(true);
    expect(remoteEventVisible({ type: "fs.changed", path: "/a/b/c" }, new Set(), ["/a/b"])).toBe(true);
    expect(remoteEventVisible({ type: "fs.changed", path: "/a/bc" }, new Set(), ["/a/b"])).toBe(false);
    expect(remoteEventVisible({ type: "settings.updated", snapshot: core.settings.snapshot() }, new Set(), [])).toBe(false);
    expect(remoteEventVisible({ type: "secrets.updated", status: core.secrets.status() }, new Set(), [])).toBe(false);
  });
});

describe("widget trees to devices (docs/56, Remote)", () => {
  const run = { $handler: 7 };
  const tree: CoreEvent = {
    type: "widget.tree",
    windowId: "w1",
    message: {
      kind: "tree",
      rev: 1,
      nodes: [
        { id: 1, type: "Window", props: { status: "1 waiting", menu: [{ label: "All Workspaces", checked: false, run }] }, children: [
          { id: 2, type: "ListRow", props: { onClick: { $handler: 8 }, menu: [{ label: "Mark Seen", run: { $handler: 9 } }] }, children: [{ id: 3, type: "ListRowContent", props: { title: "Tours" }, children: [] }] },
          { id: 4, type: "EmptyState", props: { title: "No agents", action: { label: "Start", run: { $handler: 10 } } }, children: [] },
        ] },
      ],
    },
  };
  const patch: CoreEvent = { type: "widget.tree", windowId: "w1", message: { kind: "patch", rev: 2, ops: [{ op: "props", id: 2, set: { onClick: { $handler: 11 }, dim: true }, unset: [] }, { op: "insert", parent: 1, index: 0, node: { id: 5, type: "Button", props: { onClick: { $handler: 12 } }, children: [] } }] } };

  it("is told only to devices that follow the window", () => {
    expect(remoteEvent(tree, ctx, new Set(), [])).toBeNull();
    expect(remoteEvent(tree, ctx, new Set(["w1"]), [], "control")).not.toBeNull();
  });

  it("carries no handler ids to view scope, trees and patches alike", () => {
    for (const e of [tree, patch]) {
      const view = remoteEvent(e, ctx, new Set(["w1"]), [], "view");
      expect(JSON.stringify(view)).not.toContain("$handler");
      // Without a scope it fails closed, as view.
      expect(JSON.stringify(remoteEvent(e, ctx, new Set(["w1"]), []))).not.toContain("$handler");
    }
    const view = remoteEvent(tree, ctx, new Set(["w1"]), [], "view") as Extract<CoreEvent, { type: "widget.tree" }>;
    // What isn't a handler stays: the status, the menu's labels, the row's text.
    expect(JSON.stringify(view)).toContain("All Workspaces");
    expect(JSON.stringify(view)).toContain("Tours");
    // A props op's handler becomes an unset, so one sent earlier doesn't linger.
    const p = remoteEvent(patch, ctx, new Set(["w1"]), [], "view") as Extract<CoreEvent, { type: "widget.tree" }>;
    expect(p.message.kind === "patch" && p.message.ops[0]).toEqual({ op: "props", id: 2, set: { dim: true }, unset: ["onClick"] });
  });

  it("keeps handlers for control scope, whose presses confirm on the Mac", () => {
    expect(JSON.stringify(remoteEvent(tree, ctx, new Set(["w1"]), [], "control"))).toContain("$handler");
    expect(REMOTE_ACCESS["widget.interact"]).toBe("control");
    expect(denied("widget.interact", { windowId: "w1", handler: 8, event: "onClick" }, "view")).toMatch(/needs control/);
  });

  // API 1.1's acts (widgets/api/act.ts): a widget acts only after a press, and a device's press is
  // widget.interact. View scope has none to make (never); control scope's press is marked as a
  // device's, so the act it leads to asks on the Mac every time, Once only, whatever was kept.
  it("leaves act verbs never for view scope and confirm on the Mac for control scope", () => {
    const acts = API_VERBS.filter((v) => API[v].mode === "confirm");
    expect(acts.length).toBe(7);
    expect(scopeAllows("view", REMOTE_ACCESS["widget.interact"])).toBe(false);
    const seen: boolean[] = [];
    const real = core.library.host.interact.bind(core.library.host);
    core.library.host.interact = (_w, _h, _e, _v, remote = false) => void seen.push(remote);
    try {
      core.handlers["widget.interact"]({ windowId: "w1", handler: 8, event: "onClick" }, { conn: { access: "control", deviceId: "phone", send: () => {}, close: () => {} } });
      core.handlers["widget.interact"]({ windowId: "w1", handler: 8, event: "onClick" }, { conn: { access: "local", send: () => {}, close: () => {} } });
    } finally {
      core.library.host.interact = real;
    }
    expect(seen).toEqual([true, false]);
  });
});
