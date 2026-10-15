// Run Scripts against the fake host (@cmd/widget-api/testing): the native Workspace Actions' job
// for listing, running and stopping. cmd's main action first, the rest in sections by kind,
// pinned ones first, risky ones apart and not runnable; a click runs one through
// cmd.actions.run; its state is the action's own (running, then failed or done, from wherever it
// started), how long from its terminal's command events; a click on a running one goes to its
// terminal, Stop and Restart are on its row; a dev server's address opens; Copy Command; the
// filter past a dozen; a refusal says why, the person's no says nothing; no folder, no scripts.

import { describe, expect, it } from "vitest";
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import type { WorkspaceAction } from "@cmd/widget-api";
import RunScripts, { FILTER_FROM, runState, shortUrl } from "./actions.tsx";

const { command, event } = fixtures;
const titles = (rows: { props: Record<string, unknown> }[]) => rows.map((r) => JSON.stringify(r).match(/"title":"([^"]+)"/)?.[1]);
const act = (over: Partial<WorkspaceAction> & { name: string }): WorkspaceAction => ({ title: over.name, risky: false, command: `pnpm ${over.name}`, kind: "run", package: null, pinned: false, primary: false, running: false, terminalId: null, url: null, exitCode: null, ...over });
const actions = [
  act({ name: "dev", title: "Starts the dev server", kind: "dev", primary: true }),
  act({ name: "test", title: "vitest run", kind: "test" }),
  act({ name: "lint", kind: "check" }),
  act({ name: "deploy", title: "wrangler deploy", kind: "deploy", risky: true }),
];

describe("Run Scripts", () => {
  it("puts cmd's main action first, the rest by kind and risky ones apart, which it can't run", async () => {
    const tree = await render(<RunScripts />, createHost({ actions }));
    expect(titles(tree.rows())).toEqual(["dev", "test", "lint", "deploy"]);
    expect(tree.findAll("ListGroup")).toHaveLength(1);
    expect(tree.sections().map((s) => [s.props.title, s.props.count])).toEqual([
      ["Test", 1],
      ["Check", 1],
      ["Run From a Terminal", 1],
    ]);
    expect(tree.find("Button", "Run")).toBeTruthy();
    const deploy = tree.rows()[3]!;
    expect(deploy.props.dim).toBe(true);
    expect(deploy.props.onClick).toBeUndefined();
    expect(tree.text()).toContain("4 actions");
    expect(tree.find("Window").props.status).toBeNull();
  });

  it("lists pinned ones first; on an older cmd (no run fields) the first that isn't risky is the main one", async () => {
    const tree = await render(<RunScripts />, createHost({ actions: [...actions, act({ name: "e2e", kind: "test", pinned: true })] }));
    expect(tree.sections()[0]!.props.title).toBe("Pinned");
    const mono = await render(<RunScripts />, createHost({ actions: [...actions, act({ name: "dev", kind: "dev", package: "web" })] }));
    expect(mono.sections().map((s) => s.props.title)).toEqual(["Test", "Check", "web", "Run From a Terminal"]);
    const older = await render(<RunScripts />, createHost({ actions: [{ name: "build", title: "vite build", risky: false }, { name: "test", title: "vitest", risky: false }] }));
    expect(older.findAll("ListGroup")).toHaveLength(1);
    expect(titles(older.rows())[0]).toBe("build");
  });

  it("runs one on a click, then shows its state from the action: running, then failed", async () => {
    const host = createHost({ actions });
    const tree = await render(<RunScripts />, host);
    await tree.press(tree.rows()[1]!);
    expect(host.calls).toEqual([["actions.run", "test"]]);
    host.set({ actions: actions.map((a) => (a.name === "test" ? { ...a, running: true, terminalId: "t-test" } : a)) });
    host.emit(command({ command: "pnpm test", ago: 2000, terminalId: "t-test", key: "c-test" }));
    await tree.idle();
    expect(tree.find("Window").props.status).toBe("1 running");
    expect(JSON.stringify(tree.rows()[1])).toContain('"light":"working"');
    // Running: a click goes to its terminal.
    await tree.press(tree.rows()[1]!);
    expect(host.calls.at(-1)).toEqual(["windows.select", "t-test"]);
    host.set({ actions: actions.map((a) => (a.name === "test" ? { ...a, running: false, terminalId: "t-test", exitCode: 1 } : a)) });
    host.emit(command({ command: "pnpm test", ago: 2000, took: 3000, exitCode: 1, terminalId: "t-test", key: "c-test" }));
    await tree.idle();
    expect(tree.find("Window").props.status).toBe("1 failed");
    expect(JSON.stringify(tree.rows()[1])).toContain("exit 1");
    expect(tree.text()).toContain("4 actions · 1 failed");
  });

  it("knows a run it didn't start, and stops, restarts and opens it from its row", async () => {
    const dev = act({ name: "dev", kind: "dev", primary: true, running: true, terminalId: "t-dev", url: "http://localhost:5173/" });
    const host = createHost({ actions: [dev, actions[1]!], events: [command({ command: "pnpm dev", ago: 4 * 60_000, terminalId: "t-dev" })] });
    const tree = await render(<RunScripts />, host);
    expect(tree.find("Window").props.status).toBe("1 running");
    expect(tree.find("LinkButton", "localhost:5173")).toBeTruthy();
    expect(JSON.stringify(tree.rows()[0])).toContain("4m"); // running for as long as its command
    await tree.press(tree.find("IconButton", "Stop"));
    await tree.press(tree.find("IconButton", "Restart"));
    await tree.press(tree.find("LinkButton", "localhost:5173"));
    expect(host.calls).toEqual([
      ["actions.stop", "dev"],
      ["actions.run", "dev", { restart: true }],
      ["windows.open", "http://localhost:5173/"],
    ]);
  });

  it("copies an action's command", async () => {
    const host = createHost({ actions });
    const tree = await render(<RunScripts />, host);
    await tree.choose(tree.rows()[1]!, "Copy Command");
    expect(host.calls).toEqual([["clipboard.write", "pnpm test"]]);
  });

  it("says why a run couldn't start, and nothing when the person said no", async () => {
    const refused = createHost({ actions, deny: { "actions.run": 'act: ["actions.run"]' } });
    const tree = await render(<RunScripts />, refused);
    await tree.press(tree.rows()[0]!);
    await tree.idle();
    const sent = refused.calls.filter((c) => c[0] === "notify.send");
    expect(sent).toHaveLength(1);
    expect(sent[0]![1]).toMatchObject({ key: "run", title: "dev · couldn't" });

    const declined = createHost({ actions, approve: false });
    const again = await render(<RunScripts />, declined);
    await again.press(again.rows()[0]!);
    await again.idle();
    expect(declined.requests.some((r) => r[0] === "actions.run")).toBe(true);
    expect(declined.calls.some((c) => c[0] === "notify.send")).toBe(false);
  });

  it("has a filter past a dozen actions, with a way back from no matches", async () => {
    const many = Array.from({ length: FILTER_FROM + 3 }, (_, i) => act({ name: `task-${i}`, title: `make task-${i}` }));
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

  it("reads a run's state from the action, how long from its terminal's newest command", () => {
    expect(runState(act({ name: "x" }), [])).toBeNull();
    expect(runState(act({ name: "x", running: true, terminalId: "t" }), [event({ type: "command", at: 2000, terminalId: "t", until: null })])).toEqual({ kind: "running", since: 2000 });
    expect(runState(act({ name: "x", running: true, terminalId: "t" }), [])).toEqual({ kind: "running", since: null });
    expect(runState(act({ name: "x", terminalId: "t", exitCode: 130 }), [event({ type: "command", at: 2000, terminalId: "t", until: 5000 })])).toEqual({ kind: "stopped", took: 3000 });
    expect(runState(act({ name: "x", terminalId: "t", exitCode: 0 }), [event({ type: "command", at: 2000, terminalId: "t", until: 5000 }), event({ type: "command", at: 9000, terminalId: "other", until: null })])).toEqual({ kind: "done", took: 3000 });
    expect(shortUrl("http://localhost:5173/")).toBe("localhost:5173");
  });
});
