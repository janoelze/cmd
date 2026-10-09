import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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

  it("keeps paths inside open workspaces and off private files", () => {
    fs.mkdirSync(path.join(home, "proj"));
    fs.writeFileSync(path.join(home, "proj/a.txt"), "hi");
    fs.writeFileSync(path.join(home, "proj/.env"), "TOKEN=1");
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.symlinkSync("/etc", path.join(home, "proj/etc"));
    expect(denied("fs.read", { path: path.join(home, "proj/a.txt") })).toBeNull();
    expect(denied("fs.write", { path: path.join(home, "proj/new.txt"), text: "" })).toBeNull();
    expect(denied("fs.read", { path: "/etc/hosts" })).toMatch(/outside/);
    expect(denied("fs.read", { path: path.join(home, "proj/../../etc/hosts") })).toMatch(/outside/);
    expect(denied("fs.read", { path: path.join(home, "proj/etc/hosts") })).toMatch(/outside/);
    expect(denied("fs.read", { path: path.join(home, "proj/.env") })).toMatch(/private/);
    expect(denied("fs.list", { path: path.join(home, ".ssh") })).toMatch(/private/);
    expect(denied("fs.read", { path: "proj/a.txt" })).toMatch(/absolute/);
    expect(denied("fs.rename", { path: path.join(home, "proj/a.txt"), name: "b.txt" })).toBeNull();
    expect(denied("fs.rename", { path: path.join(home, "proj/a.txt"), name: ".env" })).toMatch(/private/);
    expect(denied("fs.rename", { path: path.join(home, "proj/a.txt"), name: "../../x" })).toMatch(/bad name/);
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
