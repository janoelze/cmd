import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PANE_ENV, cmdHome, configDir, coreSocketPath, defaultSocketPath, enterInstance, isOwnCore, logDir } from "@cmd/protocol/node";
import { Core } from "../src/core.ts";
import { fakeFactory } from "./fake-pty.ts";

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

function clean(): void {
  for (const k of ["CMD_HOME", "CMD_INSTANCE", "CMD_SOCKET", "CMD_LOG_DIR", "CMD_CONFIG_DIR"]) delete process.env[k];
}

describe("instances", () => {
  it("keeps release and dev apart", () => {
    clean();
    const release = { home: cmdHome(), socket: coreSocketPath(), logs: logDir() };
    process.env.CMD_INSTANCE = "dev";
    expect(path.basename(cmdHome())).toBe("cmd-dev");
    expect(path.dirname(cmdHome())).toBe(path.dirname(release.home));
    expect(coreSocketPath()).toBe(path.join(os.tmpdir(), "cmd-dev", "core.sock"));
    expect(coreSocketPath()).not.toBe(release.socket);
    expect(logDir()).not.toBe(release.logs);
    expect(configDir()).toBe(path.join(os.homedir(), ".config", "cmd")); // shared
  });

  it("an app started in another core's pane ignores that pane's socket", () => {
    clean();
    Object.assign(process.env, { CMD_SOCKET: path.join(os.tmpdir(), "cmd", "core.sock"), CMD_PANE_ID: "p1", CMD_AGENT_ID: "a1" });
    enterInstance("dev");
    expect(process.env.CMD_SOCKET).toBeUndefined();
    expect(process.env.CMD_PANE_ID).toBeUndefined();
    expect(process.env.CMD_AGENT_ID).toBeUndefined();
    expect(defaultSocketPath()).toBe(path.join(os.tmpdir(), "cmd-dev", "core.sock"));
  });

  it("CMD_HOME relocates the core's socket even with CMD_SOCKET set", () => {
    clean();
    process.env.CMD_HOME = "/state";
    process.env.CMD_SOCKET = "/other/core.sock";
    expect(coreSocketPath()).toBe(path.join("/state", "core.sock"));
    expect(defaultSocketPath()).toBe("/other/core.sock"); // clients still talk to their pane's core
    expect(cmdHome()).toBe("/state");
    expect(configDir()).toBe("/state");
  });

  it("tells its own core from another instance's", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-own-"));
    expect(isOwnCore({ pid: 1, stateDir: home + "/" }, home)).toBe(true);
    expect(isOwnCore({ pid: 1, stateDir: "/elsewhere" }, home)).toBe(false);
    // Cores from before stateDir: only the one our pid file names.
    expect(isOwnCore({ pid: 42 }, home)).toBe(false);
    fs.writeFileSync(path.join(home, "core.pid"), "42");
    expect(isOwnCore({ pid: 42 }, home)).toBe(true);
    expect(isOwnCore({ pid: 43 }, home)).toBe(false);
  });

  it("PANE_ENV covers everything a core sets in its panes", () => {
    clean();
    const before = new Set(Object.keys(process.env));
    const { factory, ptys } = fakeFactory();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-pane-env-"));
    const core = new Core({ socketPath: path.join(dir, "core.sock"), dbPath: null, settingsPath: null, terminals: factory, shellRulesFile: path.join(dir, "rules.zsh") });
    core.panes.create({});
    const added = Object.keys(ptys[0]!.opts.env).filter((k) => !before.has(k) && !["TERM", "COLORTERM", "TERM_PROGRAM", "ZDOTDIR"].includes(k));
    expect(added.length).toBeGreaterThan(1);
    expect(added.filter((k) => !PANE_ENV.includes(k))).toEqual([]);
  });
});
