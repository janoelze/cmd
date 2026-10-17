// Quick Commands in the core (quick/): the file read, watched and written with its comments
// kept, and a run typed into the selected terminal, sent to the agent in it, or started in a
// new terminal, with what is missing or asks first refused.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickList } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { fakeFactory, type FakePty } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

let dir: string;
let core: Core;
let ptys: FakePty[];
const file = () => path.join(dir, "quick-commands.json");

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-quick-")));
  const f = fakeFactory();
  ptys = f.ptys;
  core = new Core({ socketPath: path.join(dir, "core.sock"), dbPath: null, settingsPath: path.join(dir, "settings.json"), stateDir: dir, terminals: f.factory, pollMs: 0 });
});
afterEach(async () => {
  await core.close();
  rmTemp(dir);
});

const h = () => core.handlers;
const list = () => h()["quick.list"]({}) as QuickList;

describe("the file", () => {
  it("starts with a header, keeps comments through saves and reads edits made by hand", async () => {
    const a = h()["quick.save"]({ command: { name: "Push Branch", body: "git push -u origin {{branch}}", submit: true, keys: [] } }) as { id: string };
    expect(a.id).toBe("push-branch");
    expect(fs.readFileSync(file(), "utf8")).toMatch(/^\/\/ cmd Quick Commands[\s\S]*\[\n {2}\{"id": "push-branch", "name": "Push Branch", "body": "git push -u origin \{\{branch\}\}"\}\n\]\n$/);
    h()["quick.save"]({ command: { name: "First", body: "ls" }, before: "push-branch" });
    h()["quick.save"]({ command: { id: "push-branch", name: "Push", body: "git push", target: "terminal" } });
    expect(list().commands.map((c) => [c.id, c.name])).toEqual([["first", "First"], ["push-branch", "Push"]]);
    h()["quick.move"]({ id: "first", before: null });
    expect(list().commands.map((c) => c.id)).toEqual(["push-branch", "first"]);

    // Edited by hand: a comment, and a line that isn't a command (left out, said so).
    core.start();
    await core.scheduler.idle();
    fs.writeFileSync(file(), `[\n  // mine\n  { "name": "Hand", "body": "echo hi" },\n  { "body": "no name" }\n]\n`);
    await vi.waitFor(() => expect(list().commands[0]?.id).toBe("hand"), { timeout: 3000 });
    const l = list();
    expect(l.commands.map((c) => c.id)).toEqual(["hand"]);
    expect(l.problems).toEqual(['command 2: needs a "name"']);
    h()["quick.remove"]({ id: "hand" });
    expect(fs.readFileSync(file(), "utf8")).toBe(`[\n  // mine\n  { "body": "no name" }\n]\n`);
  });

  it("keeps the last good commands when the file breaks, and won't write over it", async () => {
    h()["quick.save"]({ command: { name: "A", body: "a" } });
    core.start();
    await core.scheduler.idle();
    fs.writeFileSync(file(), "[ { oops ]");
    await vi.waitFor(() => expect(list().error).toBeTruthy(), { timeout: 3000 });
    const l = list();
    expect(l.commands.map((c) => c.id)).toEqual(["a"]);
    expect(l.error).toBeTruthy();
    expect(() => h()["quick.save"]({ command: { name: "B", body: "b" } })).toThrow(/can't be read/);
  });
});

describe("running one", () => {
  const save = (c: Record<string, unknown>) => h()["quick.save"]({ command: { name: "x", body: "", ...c } as never }) as { id: string };

  it("types into the selected terminal, quoted, with Return or without", async () => {
    const pane = core.panes.create({ cwd: dir });
    const pty = ptys.at(-1)!;
    const { id } = save({ name: "Grep", body: "grep -rn {{selection}} {{ask:where=.}}" });
    const r = await h()["quick.run"]({ id, context: { paneId: pane.id, selection: "it's here" } });
    expect(r).toEqual({ text: `grep -rn 'it'\\''s here' .`, paneId: pane.id });
    expect(pty.written.at(-1)).toBe(`grep -rn 'it'\\''s here' .\r`);
    const quiet = save({ name: "Quiet", body: "echo {{ask:w}}", submit: false });
    await h()["quick.run"]({ id: quiet.id, context: { paneId: pane.id }, values: { w: "a b" } });
    expect(pty.written.at(-1)).toBe(`echo 'a b'`);
  });

  it("sends prose to the agent in the selected terminal, unquoted", async () => {
    const agent = core.agents.spawn({ kind: "claude", cwd: dir });
    const pane = core.panes.get(agent.paneId!)!;
    const pty = ptys.at(-1)!;
    const { id } = save({ name: "Review", body: "Review {{file}} for missing tests" });
    const r = await h()["quick.run"]({ id, context: { paneId: pane.id, file: "/src/a b.ts" } });
    expect(r.text).toBe("Review /src/a b.ts for missing tests");
    expect(pty.written.slice(-2)).toEqual(["Review /src/a b.ts for missing tests", "\r"]);
  });

  it("starts a new terminal in the folder, with the values in its environment", async () => {
    const { id } = save({ name: "Logs", body: "tail -f {{ask:log=app.log}}", target: "terminal", cwd: "{{folder}}/logs" });
    fs.mkdirSync(path.join(dir, "logs"));
    const r = (await h()["quick.run"]({ id, context: { folder: dir } })) as { paneId: string };
    const pane = core.panes.get(r.paneId as never)!;
    expect(pane.cwd).toBe(path.join(dir, "logs"));
    expect(ptys.at(-1)!.opts.env?.CMD_QUICK_LOG).toBe("app.log");
  });

  it("refuses what is missing, names it, and runs a confirm one only when confirmed", async () => {
    const f = save({ name: "Cat", body: "cat {{file}}", target: "terminal" });
    await expect(async () => h()["quick.run"]({ id: f.id })).rejects.toThrow(`"Cat" needs {{file}}. Select a file first.`);
    expect((h()["quick.resolve"]({ id: f.id }) as { missing: string[] }).missing).toEqual(["file"]);
    const d = save({ name: "Deploy", body: "make deploy", target: "terminal", confirm: true });
    await expect(async () => h()["quick.run"]({ id: d.id })).rejects.toThrow(/asks before it runs \(make deploy\)/);
    expect(((await h()["quick.run"]({ id: "Deploy", confirmed: true })) as { text: string }).text).toBe("make deploy");
    await expect(async () => h()["quick.run"]({ id: "nope" })).rejects.toThrow(/no Quick Command "nope"/);
  });
});
