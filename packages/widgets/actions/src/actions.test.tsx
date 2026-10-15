// Run Scripts against the fake host (@cmd/widget-api/testing): the native Workspace Actions' job
// for listing and running. The main action first, the rest under it, risky ones apart and not
// runnable; a click runs one through cmd.actions.run; its state from its terminal's command
// events (running, then failed or done), kept per window; a click on a running one goes to its
// terminal, one whose terminal closed isn't running; the filter past a dozen; a refusal says
// why, the person's no says nothing; no folder, no scripts.

import { describe, expect, it } from "vitest";
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import RunScripts, { FILTER_FROM, runState } from "./actions.tsx";

const { command, event, pane } = fixtures;
const titles = (rows: { props: Record<string, unknown> }[]) => rows.map((r) => JSON.stringify(r).match(/"title":"([^"]+)"/)?.[1]);
const actions = [
  { name: "dev", title: "Starts the dev server", risky: false },
  { name: "test", title: "vitest run", risky: false },
  { name: "lint", title: "lint", risky: false },
  { name: "deploy", title: "wrangler deploy", risky: true },
];

describe("Run Scripts", () => {
  it("puts the main action first, the scripts under it and risky ones apart, which it can't run", async () => {
    const tree = await render(<RunScripts />, createHost({ actions }));
    expect(titles(tree.rows())).toEqual(["dev", "test", "lint", "deploy"]);
    expect(tree.findAll("ListGroup")).toHaveLength(1);
    expect(tree.sections().map((s) => [s.props.title, s.props.count])).toEqual([
      ["Scripts", 2],
      ["Run From a Terminal", 1],
    ]);
    expect(tree.find("Button", "Run")).toBeTruthy();
    const deploy = tree.rows()[3]!;
    expect(deploy.props.dim).toBe(true);
    expect(deploy.props.onClick).toBeUndefined();
    expect(tree.find("StatusLine")).toBeTruthy();
    expect(tree.text()).toContain("4 actions");
    expect(tree.find("Window").props.status).toBeNull();
  });

  it("runs one on a click, then follows it from its terminal's commands: running, then failed", async () => {
    const host = createHost({ actions, terminals: [pane()] });
    const tree = await render(<RunScripts />, host);
    await tree.press(tree.rows()[1]!);
    expect(host.calls).toEqual([["actions.run", "test"]]);
    expect(host.requests).toContainEqual(["state.set", "ran", { test: { terminalId: "t-action-test", at: expect.any(Number) } }]);
    host.set({ terminals: [pane(), pane({ id: "t-action-test" })] });
    host.emit(command({ command: "pnpm test", ago: 0, terminalId: "t-action-test", key: "c-test" }));
    await tree.idle();
    expect(tree.find("Window").props.status).toBe("1 running");
    expect(JSON.stringify(tree.rows()[1])).toContain('"light":"working"');
    // Running: a click goes to its terminal.
    await tree.press(tree.rows()[1]!);
    expect(host.calls.at(-1)).toEqual(["windows.select", "t-action-test"]);
    host.emit(command({ command: "pnpm test", ago: 0, took: 3000, exitCode: 1, terminalId: "t-action-test", key: "c-test" }));
    await tree.idle();
    expect(tree.find("Window").props.status).toBe("1 failed");
    expect(JSON.stringify(tree.rows()[1])).toContain("exit 1");
    expect(tree.text()).toContain("4 actions · 1 failed");
  });

  it("keeps where each ran across a reload; a run whose terminal closed isn't running", async () => {
    const at = Date.now() - 60_000;
    const events = [command({ command: "pnpm dev", ago: 59_000, terminalId: "t-dev" })];
    const open = await render(<RunScripts />, createHost({ actions, terminals: [pane({ id: "t-dev" })], events, state: { ran: { dev: { terminalId: "t-dev", at } } } }));
    expect(open.find("Window").props.status).toBe("1 running");
    expect(JSON.stringify(open.rows()[0])).not.toContain('"label":"Run"');
    const closed = await render(<RunScripts />, createHost({ actions, terminals: [], events, state: { ran: { dev: { terminalId: "t-dev", at } } } }));
    expect(closed.find("Window").props.status).toBeNull();
  });

  it("says why a run couldn't start, and nothing when the person said no", async () => {
    const refused = createHost({ actions, deny: { "actions.run": 'act: ["actions.run"]' } });
    const tree = await render(<RunScripts />, refused);
    await tree.press(tree.rows()[0]!);
    await tree.idle();
    const sent = refused.calls.filter((c) => c[0] === "notify.send");
    expect(sent).toHaveLength(1);
    expect(sent[0]![1]).toMatchObject({ key: "run", title: "dev · couldn't run" });

    const declined = createHost({ actions, approve: false });
    const again = await render(<RunScripts />, declined);
    await again.press(again.rows()[0]!);
    await again.idle();
    expect(declined.requests.some((r) => r[0] === "actions.run")).toBe(true);
    expect(declined.calls.some((c) => c[0] === "notify.send")).toBe(false);
  });

  it("has a filter past a dozen actions, with a way back from no matches", async () => {
    const many = Array.from({ length: FILTER_FROM + 3 }, (_, i) => ({ name: `task-${i}`, title: `make task-${i}`, risky: false }));
    const tree = await render(<RunScripts />, createHost({ actions: many }));
    await tree.change(tree.find("ToolbarSearchField"), "task-1");
    expect(tree.sections().map((s) => s.props.title)).toEqual(["Matches"]);
    expect(titles(tree.rows())).toEqual(["task-1", "task-10", "task-11", "task-12", "task-13", "task-14"]);
    await tree.change(tree.find("ToolbarSearchField"), "zzz");
    expect(tree).toShowState("noResults", "No matches");
    await tree.choose(tree.find("View"), "Clear Filter", "state");
    expect(tree.rows()).toHaveLength(FILTER_FROM + 3);
    expect((await render(<RunScripts />, createHost({ actions }))).findAll("ToolbarSearchField")).toHaveLength(0);
  });

  it("says what goes here without a folder or scripts", async () => {
    expect(await render(<RunScripts />, createHost({ actions: [] }))).toShowState("empty", "No scripts here");
    expect(await render(<RunScripts />, createHost({ workspace: { root: null } }))).toShowState("empty", "No folder");
  });

  it("reads a run's state from the newest command in its terminal since it ran", () => {
    const ran = { terminalId: "t", at: 1000 };
    expect(runState(undefined, [])).toBeNull();
    expect(runState(ran, [event({ type: "command", at: -5000, terminalId: "t", until: -4000, data: { exitCode: 1 } })])).toBeNull();
    expect(runState(ran, [event({ type: "command", at: 2000, terminalId: "t", until: null })])).toEqual({ kind: "running", since: 2000 });
    expect(runState(ran, [event({ type: "command", at: 2000, terminalId: "t", until: 5000, data: { exitCode: 130 } })])).toEqual({ kind: "stopped", took: 3000 });
    expect(runState(ran, [event({ type: "command", at: 2000, terminalId: "t", until: 5000, data: { exitCode: 0 } }), event({ type: "command", at: 9000, terminalId: "other", until: null })])).toEqual({ kind: "done", took: 3000 });
  });
});
