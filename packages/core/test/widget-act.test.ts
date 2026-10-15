// The widget API's acts (API 1.1, docs/56 phase 4; widgets/api/act.ts) on a Core with the fake
// widget runtime: a process's call asks through the tools' approvals (tool.acting with the
// widget's package and version, approvals.answer), Always keeps a yes for the package in this
// workspace (approvals.list, approvals.forget), typed text and a press from a paired device ask
// every time, the deny-list and risky actions are refused before any sheet, an act comes only
// right after a press and takes it, and nothing outside the widget's workspace or its own window
// can be named. A process built for 1.0 runs unchanged on this core.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { API, API_ACT_VERBS, API_VERBS, type ApiError, type AppWindow, type CoreEvent, type ToolActivity, type WireValue } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { fakeFactory, type FakePty } from "./fake-pty.ts";
import { FakeWidgetRuntime, tmp, until, writePackage, type FakePackage, type FakeProcess } from "./fake-widget-runtime.ts";

const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close();
});

const ACTS = { act: ["agents", "terminals", "actions", "windows"], workspace: ["read"] };

async function setup(o: { pkgs?: FakePackage[]; builtin?: boolean; minor?: number } = {}) {
  const home = tmp("cmd-widgets-home-");
  // Built in: the packages cmd ships (CMD_BUILTIN_WIDGETS), granted what they declare.
  const builtin = o.builtin ? tmp("cmd-widgets-builtin-") : null;
  for (const p of o.pkgs ?? [{ permissions: ACTS }]) writePackage(builtin ?? home, p);
  process.env.CMD_WIDGETS_HOME = home;
  if (builtin) process.env.CMD_BUILTIN_WIDGETS = builtin;
  const f = fakeFactory();
  const core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: f.factory, pollMs: 0, stateDir: tmp("cmd-state-") });
  delete process.env.CMD_WIDGETS_HOME;
  if (builtin) process.env.CMD_BUILTIN_WIDGETS = ""; // as vitest.setup.ts leaves it
  cores.push(core);
  const rt = new FakeWidgetRuntime(core.widgetTokens);
  core.library.host.configure({ runtime: rt, times: { pingMs: 1000, stallMs: 5000, stopAfterMs: 100, restartMs: 5, helloMs: 2000 } });
  // Each process draws a button (handler 1, onClick): a press counts only on a handler the tree has.
  rt.boot = (p) => void p.connect().hello(o.minor === undefined ? {} : { minor: o.minor }).send({ kind: "tree", rev: 1, nodes: [{ id: 1, type: "Button", props: { label: "Go", onClick: { $handler: 1 } }, children: [] }] });
  const acting: ToolActivity[] = [];
  const events: CoreEvent[] = [];
  core.serve({ access: "local", send: (line) => {
    const m = JSON.parse(line) as { method?: string; params?: CoreEvent };
    if (m.method !== "event" || !m.params) return;
    events.push(m.params);
    if (m.params.type === "tool.acting") acting.push(m.params.call);
  }, close: () => {} }).receive(JSON.stringify({ id: 1, method: "events.subscribe", params: {} }));
  core.start();
  await core.scheduler.idle();

  // The workspace: a repository with a test script and a risky deploy, a terminal in it; another workspace with its own.
  const repo = tmp("cmd-widget-act-");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { test: "vitest run", deploy: "wrangler deploy" } }));
  fs.mkdirSync(path.join(repo, "web"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const ws = core.workspaces.open(repo).workspace;
  const other = core.workspaces.open(tmp("cmd-widget-other-")).workspace;
  for (const p of o.pkgs ?? [{}]) if (!o.builtin) core.library.host.grant(p.name ?? "demo");
  const term = core.panes.create({ workspaceId: ws.id, cwd: repo });
  const elsewhere = core.panes.create({ workspaceId: other.id });
  const win = (await core.handlers["widget.add"]({ ref: `pkg:${o.pkgs?.[0]?.name ?? "demo"}/main`, workspaceId: ws.id })) as AppWindow;
  await until(() => core.library.host.status(win.id)?.state === "running", "the widget's process");
  /** The window's tree once the core has it (the whole tree with `rev`). */
  const drawn = (windowId: string, rev = 1) => until(() => events.some((e) => e.type === "widget.tree" && e.windowId === windowId && e.message.kind === "tree" && e.message.rev === rev), "the tree");
  await drawn(win.id);
  const proc = rt.last;
  let n = 100;

  /** The process calls a verb; the result. */
  const call = async (method: string, ...params: WireValue[]) => {
    const id = ++n;
    proc.send({ kind: "call", id, method: method as never, params });
    return proc.next("result", (m) => m.id === id, 5000);
  };
  const ok = async (method: string, ...params: WireValue[]) => {
    const r = await call(method, ...params);
    if (!r.ok) throw new Error(`${method} refused: ${r.error.message}`);
    return r.value;
  };
  const refused = async (method: string, ...params: WireValue[]): Promise<ApiError> => {
    const r = await call(method, ...params);
    if (r.ok) throw new Error(`${method} wasn't refused`);
    return r.error;
  };
  /** The person presses something in the widget (on a paired device with `remote`). */
  const press = (remote = false) => core.library.host.interact(win.id, 1, "onClick", undefined, remote);
  /** The ask waiting now, once it is shown. */
  const asked = async () => {
    await until(() => acting.some((a) => a.state === "waiting" && !answered.has(a.id)), "the ask");
    return acting.find((a) => a.state === "waiting" && !answered.has(a.id))!;
  };
  const answered = new Set<string>();
  const answer = async (allow: boolean, scope?: "once" | "session" | "always", reason?: string) => {
    const a = await asked();
    answered.add(a.id);
    await core.call("approvals.answer", { workspaceId: a.workspaceId, itemId: a.id, allow, ...(scope ? { scope } : {}), ...(reason ? { reason } : {}) });
    return a;
  };
  /** An act, pressed for and answered. */
  const act = async (method: string, params: WireValue[], allow = true, scope?: "once" | "session" | "always") => {
    press();
    const r = call(method, ...params);
    const a = await answer(allow, scope);
    return { ask: a, result: await r };
  };
  const ptyOf = (paneId: string) => f.ptys.find((p) => (p.opts as { env?: Record<string, string> }).env?.CMD_PANE_ID === paneId) as FakePty;
  return { core, rt, proc, ws, other, win, term, elsewhere, repo, acting, events, drawn, call, ok, refused, press, asked, answer, act, ptyOf, waits: () => acting.filter((a) => a.state === "waiting").length };
}

describe("acting widgets (API 1.1)", () => {
  it("asks with the widget's name, package and version; Always keeps it for the package here, listed and forgotten through approvals", async () => {
    const t = await setup();
    const first = await t.act("terminals.open", [{ cwd: "web", command: "pnpm test" }], true, "always");
    expect(first.ask).toMatchObject({ caller: "Demo", callerKind: "widget", callerWindowId: t.win.id, tool: "terminals.open", acts: true, approval: { permission: "show", exact: "pnpm test", scopes: ["once", "session", "always"], widget: { name: "demo", version: "1.0.0", title: "Demo" } } });
    expect(first.ask.approval!.title).toBe("Open a terminal in web with a command typed, not run");
    expect(first.result).toMatchObject({ ok: true, value: { id: expect.any(String) } });
    // A new terminal in web/, the command offered at its prompt by the shell integration, not run.
    const opened = (first.result as unknown as { value: { id: string } }).value.id;
    expect(t.core.panes.get(opened)).toMatchObject({ workspaceId: t.ws.id, cwd: path.join(t.repo, "web") });
    expect((t.ptyOf(opened).opts as { env: Record<string, string> }).env.CMD_RESTORE_COMMAND).toBe("pnpm test");
    expect(t.ptyOf(opened).written.join("")).not.toContain("pnpm test");

    expect(await t.core.call("approvals.list", { workspaceId: t.ws.id })).toEqual([expect.objectContaining({ key: "show:widget/demo", label: "Show things, for the widget demo" })]);
    // The next press runs without a sheet.
    const waits = t.waits();
    t.press();
    expect(await t.ok("terminals.open", {})).toMatchObject({ id: expect.any(String) });
    expect(t.waits()).toBe(waits);
    // Forgotten: it asks again.
    await t.core.call("approvals.forget", { workspaceId: t.ws.id, key: "show:widget/demo" });
    const again = await t.act("terminals.open", [{}], false);
    expect(again.result).toMatchObject({ ok: false, error: { code: "denied", message: "The person said no." } });
  });

  it("keeps a yes for one package only, and only in its workspace", async () => {
    const t = await setup({ pkgs: [{ permissions: ACTS }, { name: "other", permissions: ACTS }] });
    await t.act("terminals.open", [{}], true, "always");
    // The same kind of act from another package asks.
    const w2 = (await t.core.handlers["widget.add"]({ ref: "pkg:other/main", workspaceId: t.ws.id })) as AppWindow;
    await until(() => t.core.library.host.status(w2.id)?.state === "running", "the other widget");
    const p2 = t.rt.last as FakeProcess;
    await t.drawn(w2.id);
    t.core.library.host.interact(w2.id, 1, "onClick");
    p2.send({ kind: "call", id: 7, method: "terminals.open", params: [{}] });
    const ask = await t.asked();
    expect(ask.approval?.widget?.name).toBe("other");
    await t.answer(true);
    expect((await p2.next("result", (m) => m.id === 7)).ok).toBe(true);
    // The same package in another workspace asks too.
    const w3 = (await t.core.handlers["widget.add"]({ ref: "pkg:demo/main", workspaceId: t.other.id })) as AppWindow;
    await until(() => t.core.library.host.status(w3.id)?.state === "running", "the widget elsewhere");
    const p3 = t.rt.last as FakeProcess;
    await t.drawn(w3.id);
    t.core.library.host.interact(w3.id, 1, "onClick");
    p3.send({ kind: "call", id: 8, method: "terminals.open", params: [{}] });
    expect((await t.asked()).workspaceId).toBe(t.other.id);
  });

  it("asks for each act with its kind of act, and does it", async () => {
    const t = await setup();
    // agents.start: a Claude in a terminal of its own, in the folder asked.
    const start = await t.act("agents.start", [{ prompt: "write the tests", cwd: "web" }]);
    expect(start.ask.approval).toMatchObject({ permission: "agents", title: "Start Claude on a task in web", exact: "write the tests", scopes: ["once"] });
    const started = (start.result as unknown as { value: { id: string; terminalId: string } }).value;
    expect(t.core.agents.get(started.id)).toMatchObject({ kind: "claude", workspaceId: t.ws.id });
    expect(t.core.panes.get(started.terminalId)?.cwd).toBe(path.join(t.repo, "web"));

    // agents.send and agents.stop on an agent of this workspace.
    const agentPane = t.core.panes.create({ workspaceId: t.ws.id, cwd: t.repo });
    t.core.agents.ingestHook(agentPane.id, "claude", "UserPromptSubmit", { session_id: "s1", prompt: "fix it" });
    const agent = t.core.agents.list().find((a) => a.paneId === agentPane.id)!;
    const send = await t.act("agents.send", [agent.id, "and the docs"]);
    expect(send.ask.approval).toMatchObject({ permission: "type", scopes: ["once"], exact: "and the docs" });
    expect(send.result.ok).toBe(true);
    expect(send.ask.target).toBe(agentPane.id);
    const stop = await t.act("agents.stop", [agent.id]);
    expect(stop.ask.approval).toMatchObject({ permission: "stop" });
    expect(stop.result.ok).toBe(true);

    // terminals.type: exactly what is typed, Return only when asked.
    const typed = await t.act("terminals.type", [t.term.id, "git status", { submit: true }]);
    expect(typed.ask.approval).toMatchObject({ permission: "type", exact: "git status  ⏎", scopes: ["once"] });
    expect(t.ptyOf(t.term.id).written.join("")).toContain("git status\r");

    // actions.run: the action in a terminal of its own.
    const run = await t.act("actions.run", ["test"]);
    expect(run.ask.approval).toMatchObject({ permission: "run", title: "Run “test”" });
    expect(run.result).toMatchObject({ ok: true, value: { terminalId: expect.any(String), started: true } });
    const runIn = (run.result as unknown as { value: { terminalId: string } }).value.terminalId;
    // 1.2: Restart, one act on a running one (⌃C, then the command again in its terminal), and actions.stop.
    const restart = await t.act("actions.run", ["test", { restart: true }]);
    expect(restart.ask.approval).toMatchObject({ permission: "run", title: "Restart “test”" });
    expect(restart.ask.target).toBe(runIn);
    expect(restart.result).toMatchObject({ ok: true, value: { terminalId: runIn } });
    const stopped = await t.act("actions.stop", ["test"]);
    expect(stopped.ask.approval).toMatchObject({ permission: "stop", title: "Stop “test”", exact: expect.stringContaining("test") });
    expect(stopped.result).toMatchObject({ ok: true, value: null });
    expect(t.ptyOf(runIn).written.join("")).toContain("\x03");

    // windows.close: a window it didn't open is "stop"; one it opened is "show".
    const files = t.core.windows.open("files", {}, t.ws);
    const close = await t.act("windows.close", [files.id]);
    expect(close.ask.approval).toMatchObject({ permission: "stop", title: "Close the window “" + files.title + "”" });
    expect(t.core.windows.others().some((w) => w.id === files.id)).toBe(false);
    const mine = (await t.act("terminals.open", [{}])).result as unknown as { value: { id: string } };
    const tidy = await t.act("windows.close", [mine.value.id]);
    expect(tidy.ask.approval?.permission).toBe("show");

    // Every act verb has a confirm row (protocol widget-verbs.ts), and each was asked for above.
    const acts = API_VERBS.filter((v) => API[v].mode === "confirm");
    expect(acts.sort()).toEqual(["actions.run", "actions.stop", "agents.send", "agents.start", "agents.stop", "terminals.open", "terminals.type", "windows.close"]);
    expect(new Set(t.acting.filter((a) => a.state === "waiting").map((a) => a.tool))).toEqual(new Set(acts));
    expect(acts.every((v) => API[v].since === (v === "actions.stop" ? "1.2" : "1.1"))).toBe(true);
    expect([...API_ACT_VERBS].sort()).toEqual(acts);
  });

  it("marks the window acted on with the widget's name while the act runs, and logs it", async () => {
    const t = await setup();
    await t.act("terminals.type", [t.term.id, "ls"]);
    const running = t.acting.filter((a) => a.tool === "terminals.type" && a.state === "running");
    expect(running.at(-1)).toMatchObject({ caller: "Demo", callerKind: "widget", target: t.term.id, why: expect.stringContaining("Type in") });
    expect(t.acting.at(-1)).toMatchObject({ state: "done", target: t.term.id });
    const logged = t.core.data.query({ types: ["tool.call"] }).at(-1)!;
    expect(logged).toMatchObject({ workspaceId: t.ws.id, data: expect.objectContaining({ caller: "Demo", widget: "demo 1.0.0", tool: "terminals.type", state: "done", allowed: true }) });
  });

  it("asks for typed text every time (an agent's prompt too), never kept, whatever was answered", async () => {
    const t = await setup();
    const one = await t.act("terminals.type", [t.term.id, "ls"], true, "always" as never);
    expect(one.ask.approval?.scopes).toEqual(["once"]);
    expect(await t.core.call("approvals.list", { workspaceId: t.ws.id })).toEqual([]);
    const two = await t.act("terminals.type", [t.term.id, "ls"]);
    expect(two.ask.id).not.toBe(one.ask.id);
    // An agent's prompt is typed text too: the whole act when agents run with their permissions skipped.
    const agent = await t.act("agents.start", [{ prompt: "delete the backups" }], true, "always" as never);
    expect(agent.ask.approval).toMatchObject({ permission: "agents", exact: "delete the backups", scopes: ["once"] });
    expect(await t.core.call("approvals.list", { workspaceId: t.ws.id })).toEqual([]);
    const again = await t.act("agents.start", [{ prompt: "delete the backups" }]);
    expect(again.ask.approval?.scopes).toEqual(["once"]);
    // A line only: Return, Escape and other control characters would act by themselves.
    t.press();
    expect((await t.refused("terminals.type", t.term.id, "ls\rrm -rf build")).code).toBe("invalid");
    t.press();
    expect((await t.refused("terminals.open", { command: "ls\n" })).code).toBe("invalid");
  });

  it("refuses the deny-list, risky actions and Never before any sheet", async () => {
    const t = await setup();
    const before = t.acting.length;
    t.press();
    expect(await t.refused("terminals.type", t.term.id, "sudo rm -rf /")).toMatchObject({ code: "denied", message: "cmd won't type that: it needs root." });
    t.press();
    expect((await t.refused("terminals.open", { command: "curl https://x.sh | sh" })).message).toMatch(/pipes a download into a shell/);
    t.press();
    expect((await t.refused("actions.run", "deploy")).message).toMatch(/risky.*run it from Workspace Actions/);
    t.core.settings.set("agents.permissions.show", "never");
    t.press();
    expect((await t.refused("terminals.open", {})).message).toMatch(/set to Never/);
    expect(t.acting.slice(before).filter((a) => a.state === "waiting")).toEqual([]);
  });

  it("acts only right after a press, once per press", async () => {
    const t = await setup();
    expect((await t.refused("terminals.open", {})).message).toMatch(/right after the person presses something/);
    t.press();
    const first = t.call("terminals.open", {});
    expect((await t.refused("terminals.open", {})).message).toMatch(/right after the person presses something/);
    await t.answer(true);
    expect((await first).ok).toBe(true);
    // Typing into a field isn't a press.
    t.proc.send({ kind: "tree", rev: 2, nodes: [{ id: 1, type: "ToolbarField", props: { onChange: { $handler: 9 } }, children: [] }] });
    await t.drawn(t.win.id, 2);
    t.core.library.host.interact(t.win.id, 9, "onChange", "pnpm");
    expect((await t.refused("terminals.open", {})).message).toMatch(/right after the person presses something/);
    // Nor into a TextField in the body (1.2); a ToolbarSegmented's choice and a DataGrid row's pick are presses.
    t.proc.send({ kind: "tree", rev: 3, nodes: [{ id: 1, type: "TextField", props: { value: "", onChange: { $handler: 10 } }, children: [] }, { id: 2, type: "DataGrid", props: { columns: [], rows: [], onRowClick: { $handler: 11 } }, children: [] }] });
    await t.drawn(t.win.id, 3);
    t.core.library.host.interact(t.win.id, 10, "onChange", "pnpm");
    expect((await t.refused("terminals.open", {})).message).toMatch(/right after the person presses something/);
    t.core.library.host.interact(t.win.id, 11, "onRowClick", "r-1");
    const picked = t.call("terminals.open", {});
    await t.answer(true);
    expect((await picked).ok).toBe(true);
  });

  it("counts a press only on a handler the tree has, with an event its element fires", async () => {
    const t = await setup();
    const sent = t.proc.received.length;
    // No handler 42 in the tree; the button's handler as a change: nothing armed, nothing sent on.
    t.core.library.host.interact(t.win.id, 42, "onClick");
    t.core.library.host.interact(t.win.id, 1, "onChange", "x");
    t.core.library.host.interact(t.win.id, 1, "run");
    expect((await t.refused("terminals.open", {})).message).toMatch(/right after the person presses something/);
    expect(t.proc.received.slice(sent).filter((m) => m.kind === "interaction")).toEqual([]);
    // A menu entry's handler runs as "run".
    t.proc.send({ kind: "tree", rev: 2, nodes: [{ id: 1, type: "ListRow", props: { title: "a", menu: [{ label: "Open", run: { $handler: 5 } }] }, children: [] }] });
    await t.drawn(t.win.id, 2);
    t.core.library.host.interact(t.win.id, 5, "run");
    const r = t.call("terminals.open", {});
    await t.answer(true);
    expect((await r).ok).toBe(true);
  });

  it("names nothing outside its workspace, nor its own window", async () => {
    const t = await setup();
    t.press();
    expect((await t.refused("terminals.type", t.elsewhere.id, "ls")).message).toMatch(/No terminal .* in this widget's workspace/);
    t.press();
    expect((await t.refused("windows.close", t.win.id)).message).toBe("A widget can't act on its own window.");
    t.press();
    expect((await t.refused("windows.close", t.elsewhere.id)).message).toMatch(/No window/);
    t.press();
    expect((await t.refused("agents.start", { prompt: "x", cwd: "../.." })).message).toMatch(/outside the workspace's folder/);
    t.press();
    expect((await t.refused("terminals.open", { cwd: "/etc" })).message).toMatch(/outside the workspace's folder/);
  });

  it("needs the act grant, naming it", async () => {
    const t = await setup({ pkgs: [{ permissions: { act: ["terminals.open"], workspace: ["read"] } }] });
    t.press();
    expect(await t.refused("terminals.type", t.term.id, "ls")).toMatchObject({ code: "permission", permission: 'act: ["terminals"]' });
    t.press();
    expect(await t.refused("agents.start", { prompt: "x" })).toMatchObject({ code: "permission", permission: 'act: ["agents"]' });
    // "terminals.open" alone grants that verb.
    const r = await t.act("terminals.open", [{}]);
    expect(r.result.ok).toBe(true);
  });

  it("asks on the Mac for a press from a paired device, even when kept for always", async () => {
    const t = await setup();
    await t.act("terminals.open", [{}], true, "always");
    t.press(true);
    const r = t.call("terminals.open", {});
    const ask = await t.asked();
    expect(ask.approval?.scopes).toEqual(["once"]);
    await t.answer(true);
    expect((await r).ok).toBe(true);
    expect(API_ACT_VERBS.every((v) => API[v].mode === "confirm")).toBe(true);
  });

  it("tells the widget the person's reason, and says no to a waiting act when the widget stops", async () => {
    const t = await setup();
    t.press();
    const r = t.call("terminals.open", {});
    await t.answer(false, undefined, "not now");
    expect(await r).toMatchObject({ ok: false, error: { code: "denied", message: "The person said no: not now." } });
    t.press();
    void t.call("terminals.open", {});
    await t.asked();
    expect(await t.core.call("approvals.waiting", {})).toHaveLength(1);
    t.core.library.host.restart(t.win.id);
    await until(async () => (await t.core.call("approvals.waiting", {})).length === 0, "the ask to end");
    expect(t.acting.at(-1)).toMatchObject({ tool: "terminals.open", state: "denied" });
  });

  it("lets a built-in package follow the levels, as cmd's own callers do; typed text still asks", async () => {
    const t = await setup({ builtin: true, pkgs: [{ permissions: ACTS }] });
    expect(t.core.library.packages.forKind("pkg:demo/main")?.builtin).toBe(true);
    // "Show things" is Allow by default: a built-in package's terminals.open runs at once, marked.
    const waits = t.waits();
    t.press();
    expect(await t.ok("terminals.open", { command: "pnpm test" })).toMatchObject({ id: expect.any(String) });
    expect(t.waits()).toBe(waits);
    expect(t.acting.at(-1)).toMatchObject({ state: "done", caller: "Demo", target: expect.any(String) });
    // Typing is Ask, and typed text asks every time anyway.
    const typed = await t.act("terminals.type", [t.term.id, "ls"]);
    expect(typed.ask.approval?.scopes).toEqual(["once"]);
    // A person's package asks for the same act: it isn't built in.
    t.core.settings.set("agents.permissions.show", "ask");
    const asks = await t.act("terminals.open", [{}]);
    expect(asks.ask.approval?.permission).toBe("show");
  });

  it("serves a process built for 1.0 unchanged", async () => {
    const t = await setup({ pkgs: [{ permissions: { workspace: ["read"] } }] });
    // The fake process says hello with minor 0 (fake-widget-runtime.ts); its reads work and it is told what 1.2 serves.
    expect(t.proc.got("ready")[0]!.env).toMatchObject({ api: { major: 1, minor: 2 }, verbs: expect.arrayContaining(["agents.list", "agents.start", "run.exec"]) });
    expect(await t.ok("workspace.get")).toMatchObject({ id: t.ws.id });
    expect(await t.ok("state.set", "k", 1)).toBeNull();
  });

  it("serves a process built for 1.1 unchanged, and tells it the elements this cmd draws", async () => {
    const t = await setup({ minor: 1, pkgs: [{ permissions: { workspace: ["read"], act: ["terminals.open"] } }] });
    const env = t.proc.got("ready")[0]!.env;
    expect(env).toMatchObject({ api: { major: 1, minor: 2 }, verbs: expect.arrayContaining(["terminals.open", "run.exec"]) });
    expect(env.elements).toEqual(expect.arrayContaining(["Button", "ListRow", "DataGrid", "TimeBars", "StatusLine"]));
    // Its 1.1 tree (a Button) is drawn and pressed as before; its act asks as before.
    t.press();
    const opened = t.call("terminals.open", {});
    await t.answer(true);
    expect((await opened).ok).toBe(true);
  });
});
