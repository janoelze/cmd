import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { CoreEvent, Method } from "@cmd/protocol";
import { Core } from "../src/core.ts";
import { checkRemoteCall, REMOTE_ACCESS, RemoteDenied, remoteEventVisible, scopeAllows, type PolicyContext } from "../src/remote/policy.ts";
import { fakeFactory } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-policy-")));
const core = new Core({ socketPath: path.join(home, "core.sock"), dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, home });
const ctx: PolicyContext = { panes: core.panes, agents: core.agents, workspaces: core.workspaces, windows: core.windows, home };
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
