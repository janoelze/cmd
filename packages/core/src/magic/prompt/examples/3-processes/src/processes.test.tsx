// The CPU widget against the fake host: ps's answer as rows, busiest first, the busiest in
// the title bar, a failed ps as an error, and top typed (not run) from a row's menu.

import { describe, expect, it } from "vitest";
import { render, createHost, type HostData } from "@cmd/widget-api/testing";
import busy from "../fixtures/busy.json" with { type: "json" };
import Processes, { parsePs } from "./processes.tsx";

describe("CPU", () => {
  it("lists the busiest processes, the top one in the title bar", async () => {
    const host = createHost(busy as HostData);
    const tree = await render(<Processes />, host);
    expect(tree.find("Window").props.status).toBe("Google Chrome Helper (Renderer) · 96%");
    expect(tree).toHaveSection("By CPU", { count: 5 });
    expect(host.calls.find((c) => c[0] === "run.exec")?.slice(0, 3)).toEqual(["run.exec", "ps", ["-Ao", "pid,pcpu,pmem,comm", "-r"]]);
  });

  it("says when ps fails", async () => {
    const host = createHost({ run: { "ps -Ao pid,pcpu,pmem,comm -r": { code: 1, stderr: "ps: not allowed" } } });
    expect(await render(<Processes />, host)).toShowState("error", "No processes");
  });

  it("opens top in a terminal, typed, from a row's menu", async () => {
    const host = createHost(busy as HostData);
    const tree = await render(<Processes />, host);
    await tree.choose(tree.rows()[0]!, "Open top in a Terminal");
    expect(host.calls).toContainEqual(["terminals.open", { command: "top -o cpu" }]);
  });

  it("skips what doesn't parse", () => {
    expect(parsePs("PID %CPU %MEM COMM\nnot a row\n 12 1.0 0.1 /bin/zsh\n")).toEqual([{ pid: 12, cpu: 1, mem: 0.1, name: "zsh" }]);
  });
});
