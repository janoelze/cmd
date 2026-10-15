// Terminal Usage against the fake host (@cmd/widget-api/testing): the native Resources widget's
// job. Terminals busiest first with their largest processes, a busy one lit, the totals in tiles
// with their sparklines inside and in the title bar and the footer; cmd's own pane (the app, the
// background process); live (a new sample moves the rows and adds to the sparklines; cmd's own
// numbers follow theirs); a header sorts, kept per window; a click goes to the terminal; every
// workspace's from the title menu, each row with its workspace's name; loading until the first
// sample; nothing running; refused; many terminals; an agent's terminal by the agent's name.

import { describe, expect, it } from "vitest";
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import TerminalUsage, { HOT_CPU, mem, pct, sorted } from "./resources.tsx";

const { agent, pane, usage, appUsage } = fixtures;
const MB = 2 ** 20;

const terminals = [pane({ title: "Claude · window design", agentId: "a1" }), pane({ title: "pnpm dev", command: "pnpm dev" }), pane({ title: "zsh" })];
const samples = [
  usage({ id: "t-zsh", cpu: 0.2, memory: 6 * MB, top: [{ name: "zsh", memory: 6 * MB }] }),
  usage({ id: "t-claude-window-design", cpu: 92, memory: 812 * MB, processes: 9, top: [{ name: "claude", memory: 600 * MB }, { name: "node", memory: 200 * MB }, { name: "rg", memory: 12 * MB }, { name: "git", memory: MB }] }),
  usage({ id: "t-pnpm-dev", cpu: 21.4, memory: 1240 * MB, processes: 14, top: [{ name: "node", memory: 900 * MB }, { name: "esbuild", memory: 300 * MB }] }),
];

type Grid = { columns: { key: string; label: string }[]; rows: { key: string; cells: unknown[]; light?: string; tip?: string }[] };
type Tree = Awaited<ReturnType<typeof render>>;
type El = { props: Record<string, unknown>; children: El[] };
const first = (tree: Tree, type: string, title: string) => tree.find(type, (p) => p.props.title === title).children[0] as unknown as El;
const grid = (tree: Tree, title = "Terminals") => first(tree, "Pane", title).props as unknown as Grid;
const names = (tree: Tree) => grid(tree).rows.map((r) => r.cells[1]);

describe("Terminal Usage", () => {
  it("lists this workspace's terminals busiest first, a busy one lit, the totals in tiles and the title bar", async () => {
    const tree = await render(<TerminalUsage />, createHost({ terminals, terminalUsage: samples }));
    const g = grid(tree);
    expect(g.columns.map((c) => c.key)).toEqual(["mark", "name", "top", "cpu", "memory"]);
    expect(names(tree)).toEqual(["Claude · window design", "pnpm dev", "zsh"]);
    expect(g.rows[0]).toMatchObject({ cells: ["terminal", "Claude · window design", "claude, node, rg", "92%", "812 MB"], light: "working" });
    expect(g.rows[0]!.tip).toContain("9 processes");
    expect(g.rows[1]).toMatchObject({ cells: ["terminal", "pnpm dev", "node, esbuild", "21%", "1.2 GB"] });
    expect(g.rows[1]!.light).toBeUndefined();
    expect(tree).toHaveStat("CPU", "114");
    expect(tree.find("Stat", "CPU").props.unit).toBe("%");
    expect(tree).toHaveStat("Memory", "2.0 GB");
    expect(tree.find("Window").props.status).toBe("114% · 2.0 GB");
    expect(tree.find("Pane", (p) => p.props.title === "Terminals").props.aside).toBe(3);
    expect(tree.find("StatusLine").children[0]).toMatchObject({ text: "3 terminals · 24 processes" });
  });

  it("draws the sparklines inside their tiles, in the chart palette: CPU the first colour, memory the second", async () => {
    const tree = await render(<TerminalUsage />, createHost({ terminals, terminalUsage: samples }));
    expect(tree.find("Stat", "CPU").children).toMatchObject([{ type: "Sparkline", props: { series: 0 } }]);
    expect(tree.find("Stat", "Memory").children).toMatchObject([{ type: "Sparkline", props: { series: 1 } }]);
  });

  it("shows what cmd itself uses: the app and the background process", async () => {
    const host = createHost({ terminals, terminalUsage: samples, appUsage: appUsage({ app: { cpu: 8.2, memory: 640 * MB }, background: { cpu: 1.4, memory: 96 * MB } }) });
    const tree = await render(<TerminalUsage />, host);
    const g = grid(tree, "cmd");
    expect(g.columns.map((c) => c.label)).toEqual(["", "Part", "CPU", "Memory"]);
    expect(g.rows.map((r) => r.cells)).toEqual([["macwindow", "App", "8.2%", "640 MB"], ["gearshape.2", "Background", "1.4%", "96 MB"]]);
    expect(g.rows[1]!.tip).toBe("Keeps your terminals and agents running while the app is closed");
    // Live: the next sample.
    host.set({ appUsage: appUsage({ app: { cpu: 30, memory: 700 * MB }, background: { cpu: 2, memory: 96 * MB }, at: Date.now() + 2000 }) });
    await tree.idle();
    expect(grid(tree, "cmd").rows[0]!.cells).toEqual(["macwindow", "App", "30%", "700 MB"]);
  });

  it("leaves cmd's pane out where cmd can't tell what it uses", async () => {
    const tree = await render(<TerminalUsage />, createHost({ terminals, terminalUsage: samples, appUsage: appUsage({ app: null, background: null }) }));
    expect(tree.findAll("Pane").map((p) => p.props.title ?? null)).toEqual([null, "Terminals"]);
  });

  it("names an agent's terminal by the agent, with its kind's icon, as the sidebar does", async () => {
    const codex = agent({ id: "a1", name: "Codex · sqlite viewer", kind: "codex", terminalId: "t-claude-window-design" });
    const tree = await render(<TerminalUsage />, createHost({ terminals, agents: [codex], terminalUsage: samples }));
    const g = grid(tree);
    expect(g.rows[0]!.cells.slice(0, 2)).toEqual([codex.icon, "Codex · sqlite viewer"]);
    expect(g.rows[0]!.tip).toContain("Codex · sqlite viewer");
  });

  it("names a shell whose title says nothing by what runs in it", async () => {
    const t = pane({ title: "zsh", command: "while :; do make; done" });
    const tree = await render(<TerminalUsage />, createHost({ terminals: [t], terminalUsage: [usage({ id: t.id, top: [{ name: "make", memory: 9 * MB }, { name: "zsh", memory: 3 * MB }] })] }));
    expect(names(tree)).toEqual(["make"]);
  });

  it("follows cmd's samples live: the rows move and the sparklines grow", async () => {
    const host = createHost({ terminals, terminalUsage: samples });
    const tree = await render(<TerminalUsage />, host);
    const at = Date.now() + 2000;
    host.set({ terminalUsage: [usage({ id: "t-zsh", cpu: 99, memory: 8 * MB, at }), { ...samples[1]!, cpu: 1, at }] });
    await tree.idle();
    expect(names(tree)).toEqual(["zsh", "Claude · window design"]);
    expect(grid(tree).rows[0]!.light).toBe("working");
    expect((tree.find("Stat", "CPU").children[0] as unknown as El).props.values).toEqual([113.6, 100]);
    expect(tree.find("StatusLine").children[0]).toMatchObject({ text: "2 terminals · 10 processes" });
  });

  it("sorts by a header, kept per window", async () => {
    const host = createHost({ terminals, terminalUsage: samples });
    const tree = await render(<TerminalUsage />, host);
    await tree.pick(tree.find("DataGrid"), { key: "memory", desc: true }, "onSort");
    expect(names(tree)).toEqual(["pnpm dev", "Claude · window design", "zsh"]);
    expect(host.requests).toContainEqual(["state.set", "sort", { key: "memory", desc: true }]);
    await tree.pick(tree.find("DataGrid"), { key: "name", desc: false }, "onSort");
    expect(names(tree)).toEqual(["Claude · window design", "pnpm dev", "zsh"]);
    expect(tree.find("DataGrid").props.sort).toEqual({ key: "name", desc: false });
  });

  it("goes to a terminal from its row", async () => {
    const host = createHost({ terminals, terminalUsage: samples });
    const tree = await render(<TerminalUsage />, host);
    await tree.pick(tree.find("DataGrid"), "t-pnpm-dev", "onRowClick");
    expect(host.calls).toEqual([["windows.select", "w-pnpm-dev"]]);
  });

  it("shows every workspace's terminals from the title menu, each with its workspace's name", async () => {
    const other = pane({ title: "make", workspaceId: "ws-2", cwd: "/Users/me/src/site" });
    const host = createHost({ terminals: [...terminals, other], terminalUsage: [...samples, usage({ id: other.id, workspaceId: "ws-2", cpu: 50, memory: 100 * MB })], workspaces: [{ id: "ws-1", name: "app" }, { id: "ws-2", name: "fl-studio-web" }] });
    const tree = await render(<TerminalUsage />, host);
    expect(grid(tree).rows).toHaveLength(3);
    await tree.choose(tree.find("Window"), "All Workspaces");
    expect(host.requests).toContainEqual(["state.set", "scope", "all"]);
    expect(host.subscriptions()).toContainEqual(expect.objectContaining({ topic: "terminalUsage", query: { scope: "all" } }));
    expect(grid(tree).columns.map((c) => c.key)).toEqual(["mark", "name", "top", "cpu", "memory"]);
    expect(names(tree)).toEqual(["Claude · window design · app", "make · fl-studio-web", "pnpm dev · app", "zsh · app"]);
  });

  it("says its terminals are being measured until cmd has sampled them", async () => {
    const tree = await render(<TerminalUsage />, createHost({ terminals, terminalUsage: [] }));
    expect(tree.find("Window").props.status).toBeNull();
    expect(first(tree, "Pane", "Terminals").children[0]).toMatchObject({ text: "Measuring…" });
    expect(tree.findAll("DataGrid")).toHaveLength(1); // cmd's own pane
  });

  it("says no terminals are running, with cmd's own pane still there", async () => {
    const host = createHost({ terminals: [], terminalUsage: [] });
    const tree = await render(<TerminalUsage />, host);
    expect(tree.text()).toContain("No terminals are running in this workspace.");
    expect(tree).toHaveStat("CPU", "0.0");
    expect(tree.find("StatusLine").children[0]).toMatchObject({ text: "0 terminals · 0 processes" });
    await tree.choose(tree.find("Window"), "All Workspaces");
    expect(tree.text()).toContain("No terminals are running.");
  });

  it("says what goes here when nothing is running and cmd can't tell its own use", async () => {
    const tree = await render(<TerminalUsage />, createHost({ terminals: [], terminalUsage: [], appUsage: appUsage({ app: null, background: null }) }));
    expect(tree).toShowState("empty", "Nothing running");
    expect(JSON.stringify(tree.find("View").props.state)).toContain("in this workspace");
  });

  it("says what it needs when cmd refuses its terminals", async () => {
    const tree = await render(<TerminalUsage />, createHost({ terminals, terminalUsage: samples, deny: { "terminals.usage": 'workspace: ["read"]' } }));
    expect(tree).toShowState("error");
    expect(tree.text()).toContain("terminals.usage");
  });

  it("draws many terminals", async () => {
    const many = Array.from({ length: 60 }, (_, i) => pane({ title: `job ${i}` }));
    const tree = await render(<TerminalUsage />, createHost({ terminals: many, terminalUsage: many.map((t, i) => usage({ id: t.id, cpu: 2 * i, memory: (i + 1) * MB })) }));
    expect(grid(tree).rows).toHaveLength(60);
    expect(names(tree)[0]).toBe("job 59");
    expect(grid(tree).rows.filter((r) => r.light === "working")).toHaveLength(60 - HOT_CPU / 2);
  });

  it("writes shares and memory and orders rows as the native view does", () => {
    expect([pct(0.24), pct(9.96), pct(21.4), pct(140)]).toEqual(["0.2%", "10.0%", "21%", "140%"]);
    expect([mem(512), mem(1536), mem(6 * MB), mem(1240 * MB), mem(2048 * MB), mem(12 * 1024 * MB)]).toEqual(["512 B", "2 KB", "6 MB", "1.2 GB", "2.0 GB", "12 GB"]);
    const r = (name: string, cpu: number, memory: number) => ({ id: name, name, icon: "terminal", cpu, memory, top: [], processes: 1, workspace: null, windowId: null });
    expect(sorted([r("a", 1, 5), r("b", 1, 9), r("c", 3, 0)], null).map((x) => x.name)).toEqual(["c", "b", "a"]);
    expect(sorted([r("b", 1, 9), r("a", 1, 5)], { key: "name", desc: true }).map((x) => x.name)).toEqual(["b", "a"]);
  });
});
