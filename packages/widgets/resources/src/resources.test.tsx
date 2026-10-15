// Terminal Usage against the fake host (@cmd/widget-api/testing): the native Resources widget's
// job, but for cmd's own processes. Terminals busiest first with their largest processes, a busy
// one lit, the totals in the title bar and the footer; live (a new sample moves the rows and adds
// to the sparklines); a header sorts, kept per window; a click goes to the terminal; every
// workspace's from the title menu; terminals not sampled yet read as loading; nothing running;
// refused; many terminals; an agent's terminal by the agent's name and icon, as the sidebar.

import { describe, expect, it } from "vitest";
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import TerminalUsage, { HOT_CPU, pct, sorted } from "./resources.tsx";

const { agent, pane, usage } = fixtures;
const MB = 2 ** 20;

const terminals = [pane({ title: "Claude · window design", agentId: "a1" }), pane({ title: "pnpm dev", command: "pnpm dev" }), pane({ title: "zsh" })];
const samples = [
  usage({ id: "t-zsh", cpu: 0.2, memory: 6 * MB, top: [{ name: "zsh", memory: 6 * MB }] }),
  usage({ id: "t-claude-window-design", cpu: 92, memory: 812 * MB, processes: 9, top: [{ name: "claude", memory: 600 * MB }, { name: "node", memory: 200 * MB }, { name: "rg", memory: 12 * MB }, { name: "git", memory: MB }] }),
  usage({ id: "t-pnpm-dev", cpu: 21.4, memory: 1240 * MB, processes: 14, top: [{ name: "node", memory: 900 * MB }, { name: "esbuild", memory: 300 * MB }] }),
];

type Grid = { columns: { key: string }[]; rows: { key: string; cells: unknown[]; light?: string; tip?: string }[] };
const grid = (tree: Awaited<ReturnType<typeof render>>) => tree.find("DataGrid").props as unknown as Grid;

describe("Terminal Usage", () => {
  it("lists this workspace's terminals busiest first, a busy one lit, the totals in the title bar", async () => {
    const tree = await render(<TerminalUsage />, createHost({ terminals, terminalUsage: samples }));
    const g = grid(tree);
    expect(g.columns.map((c) => c.key)).toEqual(["mark", "name", "top", "cpu", "memory"]);
    expect(g.rows.map((r) => r.cells[1])).toEqual(["Claude · window design", "pnpm dev", "zsh"]);
    expect(g.rows[0]).toMatchObject({ cells: ["sparkles", "Claude · window design", "claude, node, rg", "92%", "812 MB"], light: "working" });
    expect(g.rows[0]!.tip).toContain("9 processes");
    expect(g.rows[1]).toMatchObject({ cells: ["terminal", "pnpm dev", "node, esbuild", "21%", "1.2 GB"] });
    expect(g.rows[1]!.light).toBeUndefined();
    expect(tree).toHaveStat("CPU", "114");
    expect(tree).toHaveStat("Memory", "2 GB");
    expect(tree.find("Window").props.status).toBe("114% · 2 GB");
    expect(tree.find("Pane", (p) => p.props.title === "Terminals").props.aside).toBe(3);
    expect(tree.find("StatusLine").children[0]).toMatchObject({ text: "3 terminals · 24 processes" });
  });

  it("names an agent's terminal by the agent, with its kind's icon, as the sidebar does", async () => {
    const codex = agent({ id: "a1", name: "Codex · sqlite viewer", kind: "codex", terminalId: "t-claude-window-design" });
    const tree = await render(<TerminalUsage />, createHost({ terminals, agents: [codex], terminalUsage: samples }));
    const g = grid(tree);
    expect(g.rows[0]!.cells.slice(0, 2)).toEqual([codex.icon, "Codex · sqlite viewer"]);
    expect(codex.icon).not.toBe("sparkles");
    expect(g.rows[0]!.tip).toContain("Codex · sqlite viewer");
  });

  it("follows cmd's samples live: the rows move and the sparklines grow", async () => {
    const host = createHost({ terminals, terminalUsage: samples });
    const tree = await render(<TerminalUsage />, host);
    expect(tree.findAll("Sparkline")).toHaveLength(0); // one sample: no line yet
    host.set({ terminalUsage: [usage({ id: "t-zsh", cpu: 99, memory: 8 * MB, at: Date.now() + 2000 }), { ...samples[1]!, cpu: 1, at: Date.now() + 2000 }] });
    await tree.idle();
    expect(grid(tree).rows.map((r) => r.cells[1])).toEqual(["zsh", "Claude · window design"]);
    expect(grid(tree).rows[0]!.light).toBe("working");
    expect(tree.findAll("Sparkline")[0]!.props.values).toEqual([113.6, 100]);
    expect(tree.find("StatusLine").children[0]).toMatchObject({ text: "2 terminals · 10 processes" });
  });

  it("sorts by a header, kept per window", async () => {
    const host = createHost({ terminals, terminalUsage: samples });
    const tree = await render(<TerminalUsage />, host);
    await tree.pick(tree.find("DataGrid"), { key: "memory", desc: true }, "onSort");
    expect(grid(tree).rows.map((r) => r.cells[1])).toEqual(["pnpm dev", "Claude · window design", "zsh"]);
    expect(host.requests).toContainEqual(["state.set", "sort", { key: "memory", desc: true }]);
    await tree.pick(tree.find("DataGrid"), { key: "name", desc: false }, "onSort");
    expect(grid(tree).rows.map((r) => r.cells[1])).toEqual(["Claude · window design", "pnpm dev", "zsh"]);
    expect(tree.find("DataGrid").props.sort).toEqual({ key: "name", desc: false });
  });

  it("goes to a terminal from its row", async () => {
    const host = createHost({ terminals, terminalUsage: samples });
    const tree = await render(<TerminalUsage />, host);
    await tree.pick(tree.find("DataGrid"), "t-pnpm-dev", "onRowClick");
    expect(host.calls).toEqual([["windows.select", "w-pnpm-dev"]]);
  });

  it("shows every workspace's terminals from the title menu, with where each runs", async () => {
    const other = pane({ title: "make", workspaceId: "ws-2", cwd: "/Users/me/src/site" });
    const host = createHost({ terminals: [...terminals, other], terminalUsage: [...samples, usage({ id: other.id, workspaceId: "ws-2", cpu: 50, memory: 100 * MB })] });
    const tree = await render(<TerminalUsage />, host);
    expect(grid(tree).rows).toHaveLength(3);
    await tree.choose(tree.find("Window"), "All Workspaces");
    expect(host.requests).toContainEqual(["state.set", "scope", "all"]);
    expect(host.subscriptions()).toContainEqual(expect.objectContaining({ topic: "terminalUsage", query: { scope: "all" } }));
    const g = grid(tree);
    expect(g.columns.map((c) => c.key)).toEqual(["mark", "name", "where", "top", "cpu", "memory"]);
    expect(g.rows.map((r) => [r.cells[1], r.cells[2]])).toEqual([["Claude · window design", "app"], ["make", "site"], ["pnpm dev", "app"], ["zsh", "app"]]);
  });

  it("reads as loading while its terminals have no sample yet", async () => {
    const tree = await render(<TerminalUsage />, createHost({ terminals, terminalUsage: [] }));
    expect(tree).toShowState("loading");
    expect(tree.find("Window").props.status).toBeNull();
  });

  it("says what goes here when nothing is running", async () => {
    const host = createHost({ terminals: [], terminalUsage: [] });
    const tree = await render(<TerminalUsage />, host);
    expect(tree).toShowState("empty", "Nothing running");
    expect(JSON.stringify(tree.find("View").props.state)).toContain("in this workspace");
    await tree.choose(tree.find("Window"), "All Workspaces");
    expect(JSON.stringify(tree.find("View").props.state)).not.toContain("in this workspace");
  });

  it("says what it needs when cmd refuses its terminals", async () => {
    const host = createHost({ terminals, terminalUsage: samples });
    const tree = await render(<TerminalUsage />, host);
    // The fake host serves every topic; a refusal is the core's answer to the subscription.
    const sub = host.subscriptions().find((s) => s.topic === "terminalUsage")!;
    host.deliver({ kind: "result", id: sub.id, ok: false, error: { code: "permission", permission: 'workspace: ["read"]', message: 'Add "workspace: [\\"read\\"]" to the widget\'s permissions to use terminals.usage.' } });
    await tree.idle();
    expect(tree).toShowState("error");
    expect(tree.text()).toContain("terminals.usage");
  });

  it("draws many terminals", async () => {
    const many = Array.from({ length: 60 }, (_, i) => pane({ title: `job ${i}` }));
    const tree = await render(<TerminalUsage />, createHost({ terminals: many, terminalUsage: many.map((t, i) => usage({ id: t.id, cpu: 2 * i, memory: (i + 1) * MB })) }));
    expect(grid(tree).rows).toHaveLength(60);
    expect(grid(tree).rows[0]!.cells[1]).toBe("job 59");
    expect(grid(tree).rows.filter((r) => r.light === "working")).toHaveLength(60 - HOT_CPU / 2);
  });

  it("writes shares and orders rows as the native view does", () => {
    expect([pct(0.24), pct(9.96), pct(21.4), pct(140)]).toEqual(["0.2%", "10.0%", "21%", "140%"]);
    const r = (name: string, cpu: number, memory: number) => ({ id: name, name, icon: "terminal", cpu, memory, top: [], processes: 1, where: "", windowId: null });
    expect(sorted([r("a", 1, 5), r("b", 1, 9), r("c", 3, 0)], null).map((x) => x.name)).toEqual(["c", "b", "a"]);
    expect(sorted([r("b", 1, 9), r("a", 1, 5)], { key: "name", desc: true }).map((x) => x.name)).toEqual(["b", "a"]);
  });
});
