// Integration: real core, real PTYs, real socket, real CLI transport.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Connection } from "@cmd/protocol/node";
import { Core } from "../src/core.ts";
import { nodePtyFactory } from "../src/panes.ts";
import { ProcInfo } from "../src/agents/procinfo.ts";
import { fakeFactory } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

const procinfo = new ProcInfo();

let core: Core;
let conn: Connection;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-test-"));
const socketPath = path.join(dir, "core.sock");

beforeAll(async () => {
  core = new Core({
    socketPath,
    dbPath: path.join(dir, "db.sqlite"),
    terminals: await nodePtyFactory(),
    pollMs: 100,
    inspector: (pid) => procinfo.query(pid),
    sampler: (pids) => procinfo.trees(pids),
    statusRoot: path.join(dir, "status"),
    shellRulesFile: path.join(dir, "shell-open.zsh"),
  });
  await core.listen();
  conn = await connect(socketPath);
});

afterAll(async () => {
  procinfo.close();
  conn?.close();
  await core?.close();
  rmTemp(dir);
});

const until = async (fn: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
};

describe("core over the socket", () => {
  it("answers hello", async () => {
    expect(await conn.client.call("core.hello", {})).toMatchObject({ socket: socketPath });
  });

  it("reports diagnostics", async () => {
    const info = await conn.client.call("core.info", {});
    expect(info).toMatchObject({ pid: process.pid, socket: socketPath, dbPath: path.join(dir, "db.sqlite"), settingsPath: null });
    expect(info.connections).toBeGreaterThanOrEqual(1);
    expect(info.rssBytes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(info.root, "packages/core/src/main.ts"))).toBe(true);
    // Startup work runs behind the socket; a test core has none left by now.
    await core.scheduler.idle();
    expect((await conn.client.call("core.info", {})).startup).toMatchObject({ phase: "ready", tasks: [] });
    expect(Array.isArray(info.stalls)).toBe(true);
  });

  it("runs a shell, streams output and tracks OSC title", async () => {
    const events: string[] = [];
    conn.client.onEvent((e) => {
      if (e.type === "pane.output") events.push(e.data);
    });
    await conn.client.call("events.subscribe", {});
    const pane = await conn.client.call("pane.create", {
      cwd: dir,
      // Panes run PowerShell on Windows.
      command:
        process.platform === "win32"
          ? 'Write-Host -NoNewline "`e]2;hello-title`a"; echo "pane=$env:CMD_PANE_ID"'
          : `printf '\\033]2;hello-title\\007'; echo "pane=$CMD_PANE_ID"`,
    });
    await until(() => events.join("").includes(`pane=${pane.id}`));
    await until(async () => (await conn.client.call("pane.list", {})).find((p) => p.id === pane.id)?.title === "hello-title");
    const { text } = await conn.client.call("pane.read", { paneId: pane.id, lines: 200 });
    expect(text).toContain(`pane=${pane.id}`);
    await conn.client.call("pane.kill", { paneId: pane.id });
  });

  it("ingests hooks for a pane and reports errors as RPC errors", async () => {
    const pane = await conn.client.call("pane.create", { cwd: dir });
    // Hooks come from an agent already in the foreground; a shell that is still
    // starting would later read as "the agent exited" (slow CI machines).
    await until(() => core.panes.foreground(pane.id)?.class.kind === "shell");
    const r = await conn.client.call("hook.ingest", {
      paneId: pane.id,
      agent: "claude",
      event: "Notification",
      payload: { notification_type: "permission_prompt", message: "Allow?" },
    });
    expect(r.agentId).toBeTruthy();
    const { agent } = await conn.client.call("identify", { paneId: pane.id });
    expect(agent).toMatchObject({ state: "needs_input", detail: "Allow?" });
    await expect(conn.client.call("agent.kill", { agentId: "nope" })).rejects.toThrow(/no such agent/);
  });
});

describe("agent detection with the native helper", () => {
  it.skipIf(!procinfo.available)("sees an agent behind a wrapper and drops it when it exits", async () => {
    // argv is ["sh", "-c", "sleep 2", "claude"]: like `bash …/safehouse … claude`
    const pane = await conn.client.call("pane.create", { cwd: dir, command: "sh -c 'sleep 2; true' claude" });
    await until(async () => (await conn.client.call("identify", { paneId: pane.id })).agent?.kind === "claude", 8000);
    const fg = (await conn.client.call("pane.list", {})).find((p) => p.id === pane.id)!.foreground;
    expect(fg).toBe("claude");
    await until(async () => (await conn.client.call("identify", { paneId: pane.id })).agent === null, 8000);
    await conn.client.call("pane.kill", { paneId: pane.id });
  }, 20_000);

  it.skipIf(!procinfo.available)("reports the real foreground program", async () => {
    const pane = await conn.client.call("pane.create", { cwd: dir, command: "sleep 3" });
    await until(async () => (await conn.client.call("pane.list", {})).find((p) => p.id === pane.id)?.foreground === "sleep", 8000);
    await conn.client.call("pane.kill", { paneId: pane.id });
  });
});

describe("ui state", () => {
  it("round-trips values, deletes with null and rejects oversized values", async () => {
    await conn.client.call("ui.set", { key: "view.mode", value: "grid" });
    await conn.client.call("ui.set", { key: "sidebar.collapsed", value: ["a", "b"] });
    expect(await conn.client.call("ui.get", {})).toMatchObject({ "view.mode": "grid", "sidebar.collapsed": ["a", "b"] });
    expect((await conn.client.call("events.subscribe", {})).ui["view.mode"]).toBe("grid");
    await conn.client.call("ui.set", { key: "view.mode", value: null });
    expect(await conn.client.call("ui.get", {})).not.toHaveProperty("view.mode");
    await expect(conn.client.call("ui.set", { key: "x", value: "y".repeat(70_000) })).rejects.toThrow(/too large/);
  });
});

describe("resource usage", () => {
  it.skipIf(!procinfo.available)("samples memory of the pane's process tree", async () => {
    const pane = await conn.client.call("pane.create", { cwd: dir, command: "sleep 5" });
    await core.resources!.tick();
    await until(async () => {
      await core.resources!.tick();
      const p = (await conn.client.call("pane.list", {})).find((x) => x.id === pane.id);
      return !!p?.usage && p.usage.processes >= 2 && p.usage.top.some((t) => t.name === "sleep");
    }, 8000);
    const p = (await conn.client.call("pane.list", {})).find((x) => x.id === pane.id)!;
    expect(p.usage!.memory).toBeGreaterThan(1024 * 1024);
    await conn.client.call("pane.kill", { paneId: pane.id });
  });
});

describe("zsh shell integration", () => {
  const zsh = fs.existsSync("/bin/zsh");
  it.skipIf(!zsh)("reports the cwd and turns `open <folder>` into a file window; forged requests are ignored", async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-open-"));
    const real = fs.realpathSync(target);
    const focused: string[] = [];
    conn.client.onEvent((e) => {
      if (e.type === "window.focus") focused.push(e.id);
    });
    await conn.client.call("events.subscribe", {});
    // Panes default to $SHELL, which isn't zsh everywhere (CI runners use bash).
    await conn.client.call("settings.set", { key: "shell.program", value: "/bin/zsh" });
    // A forged request (wrong token) printed by a command must not open anything.
    const pane = await conn.client.call("pane.create", {
      cwd: dir,
      command: `printf '\\033]777;cmd;forged;open;/tmp\\007'; cd ${JSON.stringify(target)} && open .`,
    });
    await until(async () => (await conn.client.call("window.list", {})).some((w) => w.kind === "files"), 15000);
    const files = (await conn.client.call("window.list", {})).filter((w) => w.kind === "files");
    expect(files).toHaveLength(1);
    expect(files[0]!.state.path).toBe(real);
    expect(focused).toContain(files[0]!.id);
    // zsh reports the logical path (/var/…); compare resolved paths (/private/var/…).
    const cwdOf = async () => (await conn.client.call("pane.list", {})).find((p) => p.id === pane.id)?.cwd ?? "";
    await until(async () => fs.realpathSync(await cwdOf()) === real, 5000);
    await conn.client.call("window.close", { id: files[0]!.id });
    await conn.client.call("pane.kill", { paneId: pane.id });
    await conn.client.call("settings.reset", { key: "shell.program" });
  }, 25_000); // a first zsh start on a fresh CI machine is slow
});

describe("restart", () => {
  it("a closing core cuts its clients and leaves another core's socket", async () => {
    const sock = path.join(dir, "restart.sock");
    const a = new Core({ socketPath: sock, dbPath: null, terminals: fakeFactory().factory, pollMs: 0 });
    await a.listen();
    // A client that never lets go must not keep a from closing.
    const lingering = await connect(sock);
    // a's socket file is gone (removed by hand, a cleaner, a crash) and b took the path.
    fs.unlinkSync(sock);
    const b = new Core({ socketPath: sock, dbPath: null, terminals: fakeFactory().factory, pollMs: 0 });
    await b.listen();
    await a.close();
    lingering.close();
    const c = await connect(sock);
    expect(await c.client.call("core.hello", {})).toMatchObject({ pid: process.pid });
    c.close();
    await b.close();
    expect(fs.existsSync(sock)).toBe(false);
  });

  it("puts its socket file back when it is removed", async () => {
    const sock = path.join(dir, "lost.sock");
    const a = new Core({ socketPath: sock, dbPath: null, terminals: fakeFactory().factory, pollMs: 0, socketCheckMs: 50 });
    await a.listen();
    const before = await connect(sock); // a client from before keeps working
    fs.unlinkSync(sock);
    await until(() => fs.existsSync(sock));
    const after = await connect(sock);
    expect(await after.client.call("core.hello", {})).toMatchObject({ pid: process.pid });
    expect(await before.client.call("core.hello", {})).toMatchObject({ pid: process.pid });
    before.close();
    after.close();
    await a.close();
    expect(fs.existsSync(sock)).toBe(false);
  });
});
