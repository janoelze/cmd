// The Agents widget against the fake host (@cmd/widget-api/testing): one ranked list as the
// native view (waiting, working, finished unseen, the rest), the tree of subagents, a row's
// end (where, how long ago) and tooltip, where a click goes, and the scope in the title menu, kept per window.

import { describe, expect, it } from "vitest";
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import Agents from "./activity.tsx";

const { agent } = fixtures;
const titles = (rows: { children: unknown[] }[]) => rows.map((r) => JSON.stringify(r).match(/"title":"([^"]+)"/)?.[1]);

describe("Agents", () => {
  it("ranks waiting agents first, then working, then finished ones not seen yet, then the rest, in one list", async () => {
    const host = createHost({
      agents: [
        agent({ name: "Idle", state: "idle", stateSince: Date.now() - 1000 }),
        agent({ name: "Docs", state: "done", stateSince: Date.now() - 60_000 }),
        agent({ name: "Seen", state: "done", bucket: "rest", stateSince: Date.now() - 2000 }),
        agent({ name: "Perf", state: "working" }),
        agent({ name: "Tours", state: "waiting", statusLine: "Wants to run pnpm e2e" }),
      ],
    });
    const tree = await render(<Agents />, host);
    expect(tree.sections()).toHaveLength(0);
    expect(titles(tree.rows())).toEqual(["Tours", "Perf", "Docs", "Idle", "Seen"]);
    expect(tree.find("Window").props.status).toBe("1 waiting for you · 1 working · 2 done");
  });

  it("says where an agent works and how long ago at the row's end, its folder in the tooltip", async () => {
    const tree = await render(<Agents />, createHost({ agents: [agent({ name: "Tours", place: "cmd-tours", cwd: "/Users/me/src/cmd-tours", stateSince: Date.now() - 4 * 60_000 })] }));
    const row = tree.rows()[0]!;
    expect(row.props.tip).toBe("/Users/me/src/cmd-tours");
    expect(tree.find("ListRowContent").props.place).toBeUndefined();
    expect(tree.find("Stack").props).toMatchObject({ gap: 0, align: "end" });
    expect(tree.findAll("Text").map((t) => [t.props.size, t.props.tone])).toEqual([["xs", "dim"], ["xs", "dim"]]);
    expect(tree.text()).toContain("cmd-tours");
    expect(tree.text()).toContain("4m");
    expect(tree.findAll("Chip")).toHaveLength(0);
  });

  it("puts the counts in the title bar", async () => {
    const host = createHost({
      agents: [agent({ name: "Docs", state: "done" }), agent({ name: "Perf", state: "working" }), agent({ name: "Tours", state: "waiting", statusLine: "Wants to run pnpm e2e" })],
    });
    const tree = await render(<Agents />, host);
    expect(tree.find("Window").props.status).toBe("1 waiting for you · 1 working · 1 done");
  });

  it("puts subagents under their host", async () => {
    const host = createHost({
      agents: [
        agent({ name: "Explore", state: "working", parentId: "a-perf", depth: 1, terminalId: null, windowId: null }),
        agent({ name: "Tours", state: "working", stateSince: Date.now() - 1000 }),
        agent({ name: "Perf", state: "working", stateSince: Date.now() - 5000 }),
      ],
    });
    const tree = await render(<Agents />, host);
    expect(titles(tree.rows())).toEqual(["Tours", "Perf", "Explore"]);
    expect(tree.rows().map((r) => r.props.depth)).toEqual([0, 0, 1]);
  });

  it("selects the host's window when a subagent is clicked", async () => {
    const host = createHost({ agents: [agent({ name: "Perf" }), agent({ name: "Explore", parentId: "a-perf", depth: 1, terminalId: null, windowId: null })] });
    const tree = await render(<Agents />, host);
    await tree.press(tree.rows()[1]!);
    await tree.press(tree.rows()[0]!);
    expect(host.calls).toEqual([
      ["windows.select", "w-perf"],
      ["windows.select", "w-perf"],
    ]);
  });

  it("switches scope from the title menu and keeps it in the window's state", async () => {
    const host = createHost({ agents: [agent({ name: "Here" }), agent({ name: "Elsewhere", workspaceId: "ws-2" })] });
    const tree = await render(<Agents />, host);
    expect(tree).toHaveRow("Here");
    expect(tree).not.toHaveRow("Elsewhere");
    await tree.choose(tree.find("Window"), "All Workspaces");
    expect(tree).toHaveRow("Elsewhere");
    expect(host.requests).toContainEqual(["state.set", "scope", "all"]);
    tree.unmount();
    // Opened again (a reload, a restart): the core's state for the window has the scope.
    const again = await render(<Agents />, host);
    expect(again).toHaveRow("Elsewhere");
    expect(again.find("Window").props.menu).toContainEqual(expect.objectContaining({ label: "All Workspaces", checked: true }));
    again.unmount();
  });

  it("says so when there are no agents", async () => {
    const tree = await render(<Agents />, createHost());
    expect(tree).toShowState("empty", "No agents in this workspace");
  });
});
