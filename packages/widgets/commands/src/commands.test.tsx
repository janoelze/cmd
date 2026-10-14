// Recent Commands against the fake host (@cmd/widget-api/testing): the native Commands view's
// job. Running first, then finished, newest first; a failure's exit status and the title bar's
// count; a command recorded again as it ends replaces its running row; a click goes to its
// terminal; Run Again opens a terminal with the command typed, not run; Failed Only and the scope
// from the title menu, kept per window; the empty states.

import { describe, expect, it } from "vitest";
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import RecentCommands from "./commands.tsx";

const { command, pane } = fixtures;
const titles = (rows: { props: Record<string, unknown> }[]) => rows.map((r) => JSON.stringify(r).match(/"title":"([^"]+)"/)?.[1]);

describe("Recent Commands", () => {
  it("lists running commands first, then finished ones newest first, failures with their exit status", async () => {
    const host = createHost({
      terminals: [pane()],
      events: [command({ command: "pnpm build", exitCode: 0, ago: 300_000, took: 12_000, branch: "main" }), command({ command: "pnpm test", exitCode: 1, ago: 60_000, took: 4000 }), command({ command: "pnpm dev", ago: 30_000 })],
    });
    const tree = await render(<RecentCommands />, host);
    expect(tree.sections().map((s) => s.props.title)).toEqual(["Running", "Finished"]);
    expect(titles(tree.rows())).toEqual(["pnpm dev", "pnpm test", "pnpm build"]);
    expect(tree).toHaveRow("pnpm test");
    expect(JSON.stringify(tree.rows()[1])).toContain("Failed · exit 1 · 4s");
    expect(JSON.stringify(tree.rows()[0])).toMatch(/Running · /);
    expect(tree.find("Window").props.status).toBe("1 failed");
  });

  it("replaces a running command's row when the log records its end", async () => {
    const host = createHost({ terminals: [pane()], events: [command({ command: "pnpm e2e", ago: 10_000, key: "command:1" })] });
    const tree = await render(<RecentCommands />, host);
    expect(tree.find("Window").props.status).toBe("1 running");
    host.emit(command({ command: "pnpm e2e", ago: 10_000, exitCode: 0, took: 9000, key: "command:1" }));
    await tree.idle();
    expect(tree.rows()).toHaveLength(1);
    expect(tree.sections().map((s) => s.props.title)).toEqual(["Finished"]);
    expect(tree.find("Window").props.status).toBeNull();
    // Its start and its end in one burst: one row, as it is now.
    host.emit(command({ command: null as never, ago: 2000, key: "command:2" }), command({ command: "ls", ago: 2000, exitCode: 0, took: 100, key: "command:2" }));
    await tree.idle();
    expect(titles(tree.rows())).toEqual(["ls", "pnpm e2e"]);
  });

  it("goes to the command's terminal, and Run Again opens a terminal with it typed, not run", async () => {
    const host = createHost({ terminals: [pane()], events: [command({ command: "pnpm test", exitCode: 1, cwd: "/Users/me/src/app/web" }), command({ command: "ls", exitCode: 0, cwd: "/tmp", ago: 120_000 })] });
    const tree = await render(<RecentCommands />, host);
    await tree.press(tree.rows()[0]!);
    await tree.choose(tree.rows()[0]!, "Run Again");
    expect(host.calls).toEqual([
      ["windows.select", "t-zsh"],
      ["terminals.open", { cwd: "/Users/me/src/app/web", command: "pnpm test" }],
    ]);
    expect(host.calls.some((c) => c[0] === "terminals.type")).toBe(false);
    // Outside the workspace's folder there is nowhere for it to open.
    const menu = tree.rows()[1]!.props.menu as { label: string; disabled?: boolean }[];
    expect(menu.find((m) => m.label === "Run Again")?.disabled).toBe(true);
  });

  it("switches to Failed Only and to every workspace from the title menu, kept in the window's state", async () => {
    const host = createHost({
      terminals: [pane()],
      events: [command({ command: "pnpm test", exitCode: 1 }), command({ command: "git status", exitCode: 0 }), command({ command: "make", exitCode: 2, workspaceId: "ws-2" })],
    });
    const tree = await render(<RecentCommands />, host);
    await tree.choose(tree.find("Window"), "Failed Only");
    expect(titles(tree.rows())).toEqual(["pnpm test"]);
    expect(tree.sections().map((s) => s.props.title)).toEqual(["Failed"]);
    expect(host.requests).toContainEqual(["state.set", "failedOnly", true]);
    await tree.choose(tree.find("Window"), "All Workspaces");
    expect(titles(tree.rows()).sort()).toEqual(["make", "pnpm test"]);
    expect(host.requests).toContainEqual(["events.query", { types: ["command"], scope: "all", limit: 300 }]);
  });

  it("says what goes here when nothing ran, and when nothing failed", async () => {
    const tree = await render(<RecentCommands />, createHost({ events: [] }));
    expect(tree).toShowState("empty", "No commands yet");
    const failedOnly = await render(<RecentCommands />, createHost({ events: [command({ exitCode: 0 })], state: { failedOnly: true } }));
    expect(failedOnly).toShowState("empty", "Nothing failed");
  });
});
