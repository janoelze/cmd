import { describe, expect, it } from "vitest";
import { PaneManager } from "../src/panes.ts";
import { processName, ResourceMonitor, usageChanged } from "../src/resources.ts";
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
