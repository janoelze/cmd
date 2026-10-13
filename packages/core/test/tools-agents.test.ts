// The tools called by an agent in a pane (docs/54, phase 3): on a real core with fake terminals,
// through tools.list and tools.call as `cmd mcp` calls them. Who calls (the pane, proven by its
// token, else found from process ancestry and read-only), every tool run as an agent caller, a
// call that must ask waiting for the person's answer in cmd (approvals.waiting, approvals.answer),
// the board's mark, what the agent started reporting back, and the switch.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreEvent, Pane, ToolActivity, Workspace } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { AGENT_TOOLS, INSTRUCTIONS } from "../src/tools/runner.ts";
import { fakeFactory, type FakePty } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

describe("the tools for agents in panes", () => {
  let dir: string;
  let core: Core;
  let ptys: FakePty[];
  let ws: Workspace;
  let acting: ToolActivity[];
  let pane: Pane;
  let token: string;

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-tools-")));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run", deploy: "wrangler deploy" } }));
    fs.writeFileSync(path.join(dir, "README.md"), "# Thing\n");
    const f = fakeFactory();
    ptys = f.ptys;
    core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: f.factory, pollMs: 0 });
    ws = (core.handlers["workspace.open"]({ path: dir }) as { workspace: Workspace }).workspace;
    acting = [];
    core.serve({
      access: "local",
      send: (line) => {
        const m = JSON.parse(line) as { method?: string; params?: CoreEvent };
        if (m.method !== "event" || !m.params) return;
        const e = m.params;
        if (e.type === "tool.acting") acting.push(e.call);
        // The app's side of workspace.arrange and browser.read/act.
        if (e.type === "workspace.arrangeRequest") void core.call("workspace.arranged", { reqId: e.reqId });
        if (e.type === "browser.request") void core.call("browser.reply", { reqId: e.reqId, result: { url: "https://thing.dev/", title: "Thing", text: "# Thing" } });
        if (e.type === "browser.actRequest") void core.call("browser.acted", { reqId: e.reqId, result: { url: "https://thing.dev/", title: "Thing", element: "<input type=text> Search" } });
      },
      close: () => {},
    }).receive(JSON.stringify({ id: 1, method: "events.subscribe", params: {} }));
    await core.call("settings.set", { key: "agents.integration", value: true });
    // Claude in a terminal of the workspace.
    const w = await core.call("window.open", { kind: "terminal", input: { cwd: dir }, workspaceId: ws.id });
    pane = core.panes.get(w!.id)!;
    token = ptys.at(-1)!.opts.env.CMD_PANE_TOKEN!;
    core.agents.ingestHook(pane.id, "claude", "SessionStart", { cwd: dir });
  });

  afterEach(() => {
    core.close();
    rmTemp(dir);
  });

  const call = (name: string, input: Record<string, unknown> = {}, who: { paneId?: string; token?: string; pids?: number[] } = { paneId: pane.id, token }) =>
    core.call("tools.call", { ...who, name, input: { why: `doing ${name}`, ...input } });
  const refOf = (text: string) => /(w\d+)/.exec(text)![1]!;
  /** The agent a call started, once it is there (its child), told it is working. */
  const started = async (prompt: string, not: string[] = []) => {
    const a = await vi.waitFor(() => {
      const found = core.agents.list().find((x) => x.parentId && !not.includes(x.id));
      if (!found?.paneId) throw new Error("not yet");
      return found;
    });
    core.agents.ingestHook(a.paneId!, "claude", "UserPromptSubmit", { cwd: dir, prompt });
    return a;
  };

  it("lists the tools for a pane with its token; only the reading ones without it; none outside cmd or when off", async () => {
    const all = await core.call("tools.list", { paneId: pane.id, token });
    expect(all.paneId).toBe(pane.id);
    expect(all.tools.map((t) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.spec.name));
    expect(all.tools.map((t) => t.name)).not.toContain("edit"); // agents edit files themselves
    expect(all.instructions).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS.length).toBeLessThan(500);
    expect(all.tools.find((t) => t.name === "look")).toMatchObject({ acts: false, readOnly: true, destructive: false });
    expect(all.tools.find((t) => t.name === "type")).toMatchObject({ acts: true, readOnly: false, destructive: true });

    const reads = await core.call("tools.list", { paneId: pane.id, token: "forged" });
    expect(reads.tools.every((t) => !t.acts)).toBe(true);
    expect(await call("open", { kind: "terminal" }, { paneId: pane.id, token: "forged" })).toMatchObject({ isError: true, output: expect.stringContaining("only the tools that read") });

    // The env didn't reach the server: its ancestry finds the pane (read-only without the token).
    const found = await core.call("tools.list", { pids: [99999999, ptys[0]!.pid] });
    expect(found.paneId).toBe(pane.id);
    expect(found.tools.every((t) => !t.acts)).toBe(true);
    expect((await core.call("tools.list", { pids: [99999999, ptys[0]!.pid], token })).tools.some((t) => t.acts)).toBe(true);

    expect(await core.call("tools.list", {})).toEqual({ paneId: null, tools: [], instructions: "" });
    await core.call("settings.set", { key: "agents.integration", value: false });
    expect((await core.call("tools.list", { paneId: pane.id, token })).tools).toEqual([]);
    expect(await call("look")).toMatchObject({ isError: true, output: expect.stringContaining("Agent integration is off") });
  });

  it("runs every tool as the agent in its pane", async () => {
    const ran = new Set<string>();
    const ok = async (name: string, input: Record<string, unknown> = {}) => {
      const r = await call(name, input);
      expect(r.isError, `${name}: ${r.output}`).toBe(false);
      ran.add(name);
      return r.output;
    };
    const board = await ok("look");
    expect(board).toMatch(/w1 terminal \(you\)/); // its own pane
    expect(await ok("read", { path: "README.md" })).toContain("# Thing");
    expect(await ok("run", { list: true })).toContain("test: npm run test");
    const term = refOf(await ok("open", { kind: "terminal" }));
    expect(await ok("read", { ref: term })).toContain("<window");
    // Opening a URL asks; allowed in cmd.
    const opening = call("open", { kind: "url", target: "https://thing.dev/" });
    await vi.waitFor(async () => expect(await core.call("approvals.waiting", {})).toHaveLength(1));
    const [asked] = await core.call("approvals.waiting", {});
    expect(asked).toMatchObject({ caller: "Claude", callerWindowId: pane.id, tool: "open", approval: { title: "Open thing.dev", offer: "opening pages on thing.dev" } });
    await core.call("approvals.answer", { workspaceId: ws.id, itemId: asked!.id, allow: true });
    const browser = refOf((await opening).output);
    ran.add("open");
    expect(await ok("read", { ref: browser })).toContain("# Thing");
    await ok("focus", { ref: term });
    await ok("arrange", { do: "dock", ref: browser, side: "right" });
    await ok("search", { in: "files", query: "Thing" });
    await ok("events", {});
    ptys[1]!.output("ready\r\n");
    expect(await ok("wait", { refs: [term], until: "text", text: "ready", seconds: 1 })).toContain("printed it");
    // Typing into another terminal and acting on a page ask first; acts go one at a time.
    const typing = call("type", { ref: term, text: "ls" });
    const page = call("page", { ref: browser, do: "fill", css: "#q", value: "cats" });
    for (const tool of ["type", "page"]) {
      const [a] = await vi.waitFor(async () => {
        const w = await core.call("approvals.waiting", {});
        if (w[0]?.tool !== tool) throw new Error(`waiting for ${tool}`);
        return w;
      });
      await core.call("approvals.answer", { workspaceId: ws.id, itemId: a!.id, allow: true });
    }
    expect((await typing).isError).toBe(false);
    expect((await page).isError).toBe(false);
    ran.add("type").add("page");
    expect(ptys[1]!.written.join("")).toContain("ls\r");
    // Starting an agent: its child, in a terminal of its own.
    const starting = call("agent", { do: "start", prompt: "fix the bug" });
    const child = await started("fix the bug");
    expect((await starting).output).toMatch(/^Started claude in w\d+/);
    ran.add("agent");
    expect(child.parentId).toBe(core.panes.get(pane.id)!.agentId);
    await ok("close", { refs: [term] });
    expect(ran).toEqual(new Set(AGENT_TOOLS.map((t) => t.spec.name)));
    // Every call is in the log, with who made it.
    const calls = core.data.query({ types: ["tool.call"], by: "time", order: "asc", limit: 100 });
    expect(calls.length).toBeGreaterThan(15);
    expect(calls[0]).toMatchObject({ paneId: pane.id, agentId: core.panes.get(pane.id)!.agentId, data: { caller: "Claude", tool: "look", state: "done" } });
  });

  it("waits for the person in cmd, marks the window acted on, and takes no for an answer", async () => {
    expect((await call("look")).output).toMatch(/w1 terminal \(you\)/);
    const term = refOf((await call("open", { kind: "terminal" })).output);
    const target = core.windows.list().find((w) => w.kind === "terminal" && w.id !== pane.id)!.id;
    const typing = call("type", { ref: term, text: "rm -rf build", why: "Cleaning the build" });
    await vi.waitFor(() => expect(acting.some((a) => a.state === "waiting")).toBe(true));
    const waiting = acting.find((a) => a.state === "waiting")!;
    expect(waiting).toMatchObject({ caller: "Claude", target, why: "Cleaning the build", approval: { title: expect.stringContaining("Type in"), exact: "rm -rf build  ⏎" } });
    // The agent's own prompt said yes long ago: cmd still waits.
    await new Promise((r) => setTimeout(r, 20));
    expect(ptys[1]!.written.join("")).not.toContain("rm -rf");
    await core.call("approvals.answer", { workspaceId: ws.id, itemId: waiting.id, allow: false, reason: "not that one" });
    expect(await typing).toEqual({ isError: true, output: expect.stringContaining("The person said no: not that one") });
    expect(acting.at(-1)).toMatchObject({ id: waiting.id, state: "denied" });
    // Refused outright, and a method the access table closes.
    expect(await call("type", { ref: term, text: "sudo reboot" })).toMatchObject({ isError: true, output: expect.stringContaining("refused: it needs root") });
    expect(await call("type", { ref: "w1", text: "hi" })).toMatchObject({ isError: true, output: expect.stringContaining("your own window") });
  });

  it("reports back what the agent started: with its next call, in its next prompt, or by waiting", async () => {
    const starting = call("agent", { do: "start", prompt: "write the docs" });
    const child = await started("write the docs");
    await starting;
    const waiting = call("wait", { until: "reports", seconds: 5 });
    core.agents.ingestHook(child.paneId!, "claude", "Stop", { cwd: dir, last_assistant_message: "Docs written." });
    expect((await waiting).output).toMatch(/^- w\d+: claude.*: done/);
    // Taken once: the next call and the next prompt carry nothing more.
    expect((await call("look")).output).not.toContain("<reports>");
    const again = call("agent", { do: "start", prompt: "and the tests" });
    const second = await started("and the tests", [child.id]);
    await again;
    core.agents.ingestHook(second.paneId!, "claude", "Stop", { cwd: dir, last_assistant_message: "Tests pass." });
    const { context } = await core.call("hook.ingest", { paneId: pane.id, agent: "claude", event: "UserPromptSubmit", payload: { cwd: dir, prompt: "how did it go?" } });
    expect(context).toMatch(/<reports>\n- w\d+: claude.*: done/);
  });
});
