import { describe, expect, it } from "vitest";
import { PaneManager } from "../src/panes.ts";
import { ProcessSampler, processName, ResourceMonitor, usageChanged } from "../src/resources.ts";
import { ProcInfo } from "../src/agents/procinfo.ts";
import { needs, until } from "../../../test/system.ts";
import { fakeFactory } from "./fake-pty.ts";

describe("ResourceMonitor", () => {
  it("attaches memory, process count and CPU% (from deltas) to each pane", async () => {
    const f = fakeFactory();
    const panes = new PaneManager(f.factory, { socketPath: "/tmp/x.sock", pollMs: 0 });
    const pane = panes.create();
    let cpu = 0;
    const sampler = async (pids: number[]) =>
      pids.map((pid) => ({
        pid,
        mem: 300 * 1024 * 1024,
        cpu,
        procs: 3,
        top: [{ pid: 1, name: "2.1.288", path: "/Users/me/.local/share/claude/versions/2.1.288", mem: 250 * 1024 * 1024 }],
      }));
    const mon = new ResourceMonitor(panes, sampler, 0);
    await mon.tick(1000);
    expect(panes.get(pane.id)!.usage).toMatchObject({ memory: 300 * 1024 * 1024, cpu: 0, processes: 3 });
    expect(panes.get(pane.id)!.usage!.top[0]!.name).toBe("claude");
    cpu = 500e6; // 0.5 s of CPU over 2 s of wall time = 25%
    await mon.tick(3000);
    expect(panes.get(pane.id)!.usage!.cpu).toBe(25);
  });

  it("samples soon when asked, once for several asks", async () => {
    const panes = new PaneManager(fakeFactory().factory, { socketPath: "/tmp/s.sock", pollMs: 0 });
    panes.create();
    let calls = 0;
    const mon = new ResourceMonitor(panes, async () => (calls++, []), 0);
    mon.soon(10);
    mon.soon(10);
    await until("a sample", () => calls > 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1);
    mon.close();
  });

  it("doesn't sample while no UI is connected", async () => {
    const panes = new PaneManager(fakeFactory().factory, { socketPath: "/tmp/t.sock", pollMs: 0 });
    panes.create();
    let calls = 0;
    let watched = false;
    const mon = new ResourceMonitor(panes, async () => (calls++, []), 0, () => watched);
    await mon.tick(1000);
    expect(calls).toBe(0);
    watched = true;
    await mon.tick(2000);
    expect(calls).toBe(1);
  });

  it("only broadcasts noticeable changes", () => {
    const u = { memory: 100e6, cpu: 5, processes: 2, top: [], sampledAt: 0 };
    expect(usageChanged(null, u)).toBe(true);
    expect(usageChanged(u, { ...u, memory: u.memory + 1000, cpu: 5.4 })).toBe(false);
    expect(usageChanged(u, { ...u, memory: u.memory + 5e6 })).toBe(true);
    expect(usageChanged(u, { ...u, cpu: 7 })).toBe(true);
  });

  it("names processes like the detector does", () => {
    expect(processName("2.1.288", "/Users/me/.local/share/claude/versions/2.1.288")).toBe("claude");
    expect(processName("node", "/opt/homebrew/bin/node")).toBe("node");
  });
});

describe("ProcessSampler", () => {
  it("reports each process's memory and CPU% since the previous sample, leaving out gone ones", async () => {
    let cpu = 0;
    const s = new ProcessSampler(async (pids) => pids.filter((p) => p !== 3).map((pid) => ({ pid, mem: pid * 1e6, cpu })));
    const first = await s.sample([1, 2, 3], 1000);
    expect([...first.values()]).toEqual([
      { pid: 1, memory: 1e6, cpu: 0 },
      { pid: 2, memory: 2e6, cpu: 0 },
    ]);
    cpu = 1e9; // 1 s of CPU over 2 s = 50%
    expect((await s.sample([1], 3000)).get(1)!.cpu).toBe(50);
  });

  // The helper is native/procinfo.c, macOS only.
  it.skipIf(process.platform !== "darwin" || needs(new ProcInfo().available, "procinfo helper (pnpm install builds native/build/procinfo)"))("samples real processes with the procinfo helper", async () => {
    const p = new ProcInfo();
    try {
      const [me] = await p.procs([process.pid, 999_999_999]);
      expect(me).toMatchObject({ pid: process.pid });
      expect(me!.mem).toBeGreaterThan(0);
    } finally {
      p.close();
    }
  });
});
