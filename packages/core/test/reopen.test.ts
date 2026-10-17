// Reopening closed windows (windows/closed.ts): same id, same workspace, a terminal
// as a new shell in its folder with its last screen and nothing run again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Core } from "../src/kernel/core.ts";
import { CLOSED_PER_WORKSPACE } from "../src/windows/index.ts";
import { fakeFactory } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";
import { until } from "../../../test/system.ts";

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-reopen-")));
afterAll(() => rmTemp(tmp));

function setup(name: string) {
  const f = fakeFactory();
  const home = path.join(tmp, name);
  fs.mkdirSync(path.join(home, "proj", "sub"), { recursive: true });
  const core = new Core({ socketPath: path.join(tmp, `${name}.sock`), dbPath: null, terminals: f.factory, pollMs: 0, home });
  return { core, ptys: f.ptys, proj: path.join(home, "proj") };
}

describe("reopening closed windows", () => {
  it("brings a terminal back under its id, in its folder, with its screen, running nothing", async () => {
    const { core, ptys, proj } = setup("terminal");
    const ws = (await core.call("workspace.open", { path: proj })).workspace;
    const pane = await core.call("pane.create", { workspaceId: ws.id });
    const pty = ptys.at(-1)!;
    pty.output("\x1b]7;file://localhost" + path.join(proj, "sub") + "\x07hello from before\r\n");
    await until("the folder from OSC 7", () => core.panes.get(pane.id)?.cwd === path.join(proj, "sub"));
    pty.process = "vim";
    await core.call("pane.kill", { paneId: pane.id });
    await until("the pane gone", () => !core.panes.get(pane.id));

    expect(await core.call("window.closed", { workspaceId: ws.id })).toMatchObject([{ id: pane.id, kind: "terminal", cwd: path.join(proj, "sub") }]);
    const w = await core.call("window.reopen", { workspaceId: ws.id });
    expect(w).toMatchObject({ id: pane.id, kind: "terminal", workspaceId: ws.id });
    const next = ptys.at(-1)!;
    expect(next).not.toBe(pty);
    expect(next.opts.cwd).toBe(path.join(proj, "sub"));
    expect(next.written.join("")).toBe(""); // nothing typed into the new shell
    const { text } = await core.call("pane.read", { paneId: pane.id, lines: 50 });
    expect(text).toContain("hello from before");
    expect(text).toContain("Reopened");
    expect(await core.call("window.closed", { workspaceId: ws.id })).toEqual([]);
    expect(await core.call("window.reopen", { workspaceId: ws.id })).toBeNull();
    await core.close();
  });

  it("brings other windows back as they were, newest first", async () => {
    const { core, proj } = setup("windows");
    const ws = (await core.call("workspace.open", { path: proj })).workspace;
    const files = await core.call("window.open", { kind: "files", input: { path: proj }, workspaceId: ws.id });
    const browser = await core.call("window.open", { kind: "browser", input: { url: "https://example.com/a" }, workspaceId: ws.id });
    await core.call("window.close", { id: files.id });
    await core.call("window.close", { id: browser.id });
    expect((await core.call("window.closed", { workspaceId: ws.id })).map((c) => c.id)).toEqual([browser.id, files.id]);

    expect(await core.call("window.reopen", { workspaceId: ws.id })).toMatchObject({ id: browser.id, kind: "browser", state: browser.state });
    expect(await core.call("window.reopen", { id: files.id })).toMatchObject({ id: files.id, kind: "files", workspaceId: ws.id });
    await core.close();
  });

  it("closes a browser window's inspector with it, and keeps no inspector to reopen", async () => {
    const { core, proj } = setup("inspector");
    const ws = (await core.call("workspace.open", { path: proj })).workspace;
    const browser = await core.call("window.open", { kind: "browser", input: { url: "https://example.com" }, workspaceId: ws.id });
    const inspector = await core.call("window.open", { kind: "inspector", input: { for: browser.id }, workspaceId: ws.id });
    const other = await core.call("window.open", { kind: "files", input: { path: proj }, workspaceId: ws.id });
    await core.call("window.close", { id: browser.id });
    const left = core.windows.list().map((w) => w.id);
    expect(left).toContain(other.id);
    expect(left).not.toContain(inspector.id);
    expect((await core.call("window.closed", { workspaceId: ws.id })).map((c) => c.id)).toEqual([browser.id]);
    await core.close();
  });

  it("keeps the newest per workspace, and nothing of a workspace closed as a whole", async () => {
    const { core, proj } = setup("limits");
    const ws = (await core.call("workspace.open", { path: proj })).workspace;
    for (let i = 0; i < CLOSED_PER_WORKSPACE + 3; i++) {
      const w = await core.call("window.open", { kind: "browser", input: { url: `https://example.com/${i}` }, workspaceId: ws.id });
      await core.call("window.close", { id: w.id });
    }
    expect(await core.call("window.closed", { workspaceId: ws.id })).toHaveLength(CLOSED_PER_WORKSPACE);

    const other = (await core.call("workspace.open", { path: path.join(proj, "sub") })).workspace;
    await core.call("window.open", { kind: "browser", input: {}, workspaceId: other.id });
    await core.call("pane.create", { workspaceId: other.id });
    await core.call("workspace.close", { id: other.id });
    await until("its terminal gone", () => !core.panes.list().some((p) => p.workspaceId === other.id));
    expect(await core.call("window.closed", { workspaceId: other.id })).toEqual([]);
    await core.close();
  });
});
