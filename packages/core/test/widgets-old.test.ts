// Widgets made before packages are dropped, not lost (docs/56, "Old widgets are dropped, not
// lost"): the first start moves $CMD_HOME/widgets to widgets-old and closes the Magic windows
// that showed one; a second start does nothing; the packages folder is never moved.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppWindow } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { dropOldWidgets } from "../src/widgets/old.ts";
import { fakeFactory } from "./fake-pty.ts";
import { tmp } from "./fake-widget-runtime.ts";

const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close();
  delete process.env.CMD_WIDGETS_HOME;
});

function core(stateDir: string, home = tmp("cmd-old-home-")): Core {
  process.env.CMD_WIDGETS_HOME = home;
  const c = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, stateDir, magicPreviewer: null });
  c.library.host.configure({ runtime: null });
  cores.push(c);
  return c;
}

/** A Magic window as cmd:2 left it (a widget id and its page), or a request not yet made. */
function magicWindow(c: Core, state: Record<string, unknown>): AppWindow {
  const w = c.windows.open("magic", {}, c.workspaces.home());
  return c.windows.update(w.id, { state });
}

async function started(c: Core): Promise<void> {
  c.start();
  await c.scheduler.idle();
}

describe("old widgets", () => {
  it("are moved to widgets-old and their windows closed, once", async () => {
    const stateDir = tmp("cmd-old-state-");
    fs.mkdirSync(path.join(stateDir, "widgets", "0b6c-weather"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "widgets", "0b6c-weather", "manifest.json"), '{ "cmd": 2 }');
    const c = core(stateDir);
    const old = magicWindow(c, { phase: "ready", prompt: "weather", widgetId: "0b6c-weather", html: "<div></div>" });
    const v1 = magicWindow(c, { phase: "ready", prompt: "ip", source: { type: "command", command: "curl ifconfig.me" } });
    const draft = magicWindow(c, { phase: "empty", prompt: "" });
    const command = magicWindow(c, { phase: "ready", prompt: "top", kind: "terminal", command: "top -o cpu" });
    await started(c);

    expect(fs.existsSync(path.join(stateDir, "widgets"))).toBe(false);
    expect(fs.readFileSync(path.join(stateDir, "widgets-old", "0b6c-weather", "manifest.json"), "utf8")).toBe('{ "cmd": 2 }');
    const ids = c.windows.others().map((w) => w.id);
    expect(ids).not.toContain(old.id);
    expect(ids).not.toContain(v1.id);
    expect(ids).toEqual(expect.arrayContaining([draft.id, command.id]));
    // Nothing to reopen them with.
    expect(c.closed.get(old.id)).toBeUndefined();

    // The next start: a widgets folder made since stays where it is, widgets-old as it was.
    await cores.splice(cores.indexOf(c), 1)[0]!.close();
    fs.mkdirSync(path.join(stateDir, "widgets"));
    const again = core(stateDir);
    expect(dropOldWidgets(stateDir, again)).toEqual({ moved: false, closed: 0 });
    await started(again);
    expect(fs.existsSync(path.join(stateDir, "widgets"))).toBe(true);
    expect(fs.readdirSync(path.join(stateDir, "widgets-old"))).toEqual(["0b6c-weather"]);
  });

  it("never moves the packages folder, even when it is the instance's widgets folder", async () => {
    const stateDir = tmp("cmd-old-state-");
    const home = path.join(stateDir, "widgets");
    fs.mkdirSync(path.join(home, "clock"), { recursive: true });
    const c = core(stateDir, home);
    await started(c);
    expect(fs.existsSync(path.join(home, "clock"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "widgets-old"))).toBe(false);
  });
});
