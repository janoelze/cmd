// The PTY host keeps terminals running while the core restarts (terminals/host.ts,
// remote.ts, restore.ts). The host runs in-process here, over a real socket.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Core } from "../src/core.ts";
import { PtyHost } from "../src/terminals/host.ts";
import { HostMismatch, RemoteBackend } from "../src/terminals/remote.ts";
import { fakeFactory, type FakePty } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

let dir: string;
let hosts: PtyHost[];
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-host-")));
  hosts = [];
});
afterEach(async () => {
  for (const h of hosts) await h.close();
  rmTemp(dir);
});

async function startHost(name = "host"): Promise<{ host: PtyHost; ptys: FakePty[]; sock: string }> {
  const f = fakeFactory();
  const host = new PtyHost(f.factory, { idleMs: 60_000 });
  const sock = path.join(dir, `${name}.sock`);
  await host.listen(sock);
  hosts.push(host);
  return { host, ptys: f.ptys, sock };
}

let n = 0;
async function startCore(db: string, sock: string, reconnect?: () => Promise<RemoteBackend>): Promise<Core> {
  const core = new Core({ socketPath: path.join(dir, `core${n++}.sock`), dbPath: db, terminals: await RemoteBackend.connect(sock), reconnectTerminals: reconnect, pollMs: 0, home: dir });
  core.restore();
  return core;
}

const until = async (fn: () => boolean | Promise<boolean>, what = "condition") => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe("PTY host", () => {
  it("keeps terminals and their agents running across a core restart", async () => {
    const { ptys, sock } = await startHost();
    const db = path.join(dir, "a.sqlite");
    const a = await startCore(db, sock);
    const pane = a.panes.create({ cwd: dir });
    await until(() => a.panes.get(pane.id)!.pid > 0, "pid");
    const agent = a.agents.ingestHook(pane.id, "claude", "Notification", { session_id: "s1", message: "Allow?" })!;
    ptys[0]!.output("$ echo hello\r\nhello\r\n");
    await a.close();
    expect(ptys[0]!.written).toEqual([]); // not killed, nothing typed

    const b = new Core({ socketPath: path.join(dir, `core${n++}.sock`), dbPath: db, terminals: await RemoteBackend.connect(sock), pollMs: 0, home: dir });
    const notified: string[] = [];
    b.notifications.on("notification", (x) => notified.push(x.title));
    b.restore();
    expect(notified).toEqual([]); // it needed input before the restart too: already announced
    expect(b.panes.get(pane.id)).toMatchObject({ pid: ptys[0]!.pid, cwd: dir, agentId: agent.id });
    expect(b.agents.get(agent.id)).toMatchObject({ state: "needs_input", paneId: pane.id });
    const { data } = await b.panes.snapshot(pane.id);
    expect(data).toContain("hello");
    expect(data).not.toContain("Restored");

    const seen: string[] = [];
    b.panes.on("output", (_id, d) => seen.push(d));
    b.panes.write(pane.id, "ls\r");
    ptys[0]!.output("README.md\r\n");
    await until(() => seen.join("").includes("README.md"), "output");
    await until(() => ptys[0]!.written.includes("ls\r"), "input");
    await b.close();
  });

  it("drops a terminal that exited while no core was attached", async () => {
    const { ptys, sock } = await startHost();
    const db = path.join(dir, "b.sqlite");
    const a = await startCore(db, sock);
    const pane = a.panes.create({ cwd: dir });
    await until(() => a.panes.get(pane.id)!.pid > 0, "pid");
    await a.close();
    ptys[0]!.exit(0);

    const b = await startCore(db, sock);
    expect(b.panes.list()).toEqual([]);
    expect(b.store.panes()).toEqual([]);
    expect(ptys).toHaveLength(1);
    await b.close();
  });

  it("resurrects the terminals when the host dies under a running core", async () => {
    const first = await startHost("first");
    const second = await startHost("second");
    // A proxy between core and host, cut to play a host crash.
    const conns: net.Socket[] = [];
    const proxy = net.createServer((c) => {
      const up = net.createConnection(first.sock);
      c.pipe(up).pipe(c);
      conns.push(c, up);
    });
    const proxySock = path.join(dir, "proxy.sock");
    await new Promise<void>((r) => proxy.listen(proxySock, r));

    const db = path.join(dir, "c.sqlite");
    const core = await startCore(db, proxySock, () => RemoteBackend.connect(second.sock));
    const pane = core.panes.create({ cwd: dir });
    await until(() => core.panes.get(pane.id)!.pid > 0, "pid");
    first.ptys[0]!.output("before the crash\r\n");
    await until(async () => (await core.panes.read(pane.id)).includes("before"), "output");
    await core.panes.saveScreens();

    for (const c of conns) c.destroy();
    await until(() => second.ptys.length === 1, "resurrection");
    await until(() => core.panes.get(pane.id)?.pid === second.ptys[0]!.pid, "new pid");
    const text = await core.panes.read(pane.id);
    expect(text).toContain("before the crash");
    expect(text).toContain("Restored");
    await core.close();
    proxy.close();
  });

  it("won't talk to a host of another protocol", async () => {
    const sock = path.join(dir, "old.sock");
    const old = net.createServer((c) => c.on("data", () => c.write(JSON.stringify({ id: 0, r: { protocol: 999, instance: "x", pid: 1, terms: [] } }) + "\n")));
    await new Promise<void>((r) => old.listen(sock, r));
    await expect(RemoteBackend.connect(sock)).rejects.toBeInstanceOf(HostMismatch);
    old.close();
  });

  it("hands the host to the core that says hello last", async () => {
    const { ptys, sock } = await startHost();
    const a = await RemoteBackend.connect(sock);
    const t = a.spawn({ id: "p1", shell: "zsh", args: [], cwd: dir, cols: 80, rows: 24, env: {}, scrollback: 100 });
    await t.ready;
    const heard: string[] = [];
    a.onLost(() => heard.push("lost"));
    a.onReplaced(() => heard.push("replaced"));
    const b = await RemoteBackend.connect(sock);
    expect(b.attached().map((x) => x.id)).toEqual(["p1"]);
    await until(() => heard.length === 1, "takeover");
    expect(heard).toEqual(["replaced"]); // not a crash
    ptys[0]!.output("x");
    b.dispose();
  });

  it("a core that lost the host to another stops instead of taking it back", async () => {
    const { ptys, sock } = await startHost();
    const db = path.join(dir, "d.sqlite");
    let reconnects = 0;
    let replaced = 0;
    const a = new Core({
      socketPath: path.join(dir, `core${n++}.sock`),
      dbPath: db,
      terminals: await RemoteBackend.connect(sock),
      reconnectTerminals: () => (reconnects++, RemoteBackend.connect(sock)),
      onReplaced: () => replaced++,
      pollMs: 0,
      home: dir,
    });
    a.restore();
    const pane = a.panes.create({ cwd: dir });
    await until(() => a.panes.get(pane.id)!.pid > 0, "pid");
    await a.panes.saveScreens();
    const b = await startCore(db, sock);
    await until(() => replaced === 1, "replaced");
    expect(reconnects).toBe(0);
    expect(b.panes.get(pane.id)?.pid).toBe(ptys[0]!.pid);
    expect(ptys[0]!.written).toEqual([]);
    await a.close();
    await b.close();
  });
});
