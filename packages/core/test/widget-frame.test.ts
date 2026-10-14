// Frame widgets in the core (docs/56, "The frame surface"; widgets/host/frame.ts): a frame
// widget's process runs as a tree widget's does (it fills the title bar); widget.frameSource
// gives its window the package folder and its grant's hosts, nothing before the grant;
// widget.frame serves only state.set and windows.open, through the API's access table: a link
// opens only with `pressed` (the app's gesture rule) and only http(s); anything else is refused.

import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { AppWindow } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { fakeFactory } from "./fake-pty.ts";
import { FakeWidgetRuntime, tmp, until, writePackage, type FakePackage } from "./fake-widget-runtime.ts";

const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close();
});

async function setup(pkgs: FakePackage[]) {
  const home = tmp("cmd-widgets-home-");
  for (const p of pkgs) writePackage(home, p);
  process.env.CMD_WIDGETS_HOME = home;
  const core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, stateDir: tmp("cmd-state-") });
  delete process.env.CMD_WIDGETS_HOME;
  cores.push(core);
  const rt = new FakeWidgetRuntime(core.widgetTokens);
  core.library.host.configure({ runtime: rt, times: { pingMs: 20, stallMs: 1000, stopAfterMs: 100, restartMs: 5, helloMs: 2000 } });
  core.start();
  await core.scheduler.idle();
  const open = async (ref = "pkg:radio/main") => (await core.handlers["widget.add"]({ ref, workspaceId: core.workspaces.home().id })) as AppWindow;
  return { core, rt, home, open };
}

describe("frame widgets", () => {
  it("run their process, and their window gets the package folder and the grant's hosts once granted", async () => {
    const { core, rt, home, open } = await setup([{ name: "radio", surface: "frame", permissions: { net: ["stream.example.com"] } }]);
    expect((await core.handlers["widget.list"]({})).find((e) => e.kind === "pkg:radio/main")?.surface).toBe("frame");
    const w = await open();
    expect(core.library.host.status(w.id)?.state).toBe("waiting-grant");
    expect(await core.handlers["widget.frameSource"]({ windowId: w.id })).toBeNull(); // nothing before the grant
    core.library.host.grant("radio");
    await until(() => core.library.host.status(w.id)?.state === "running", "the frame widget's process");
    expect(rt.procs).toHaveLength(1);
    expect(await core.handlers["widget.frameSource"]({ windowId: w.id })).toEqual({ dir: fs.realpathSync(`${home}/radio`), media: ["stream.example.com"] });
  });

  it("serves state.set into the window's state, and nothing for a tree widget's window", async () => {
    const { core, open } = await setup([{ name: "radio", surface: "frame" }, { name: "tree" }]);
    const w = await open();
    await core.handlers["widget.frame"]({ windowId: w.id, verb: "state.set", params: ["volume", 0.4] });
    expect(core.windows.others().find((x) => x.id === w.id)?.state.kv).toEqual({ volume: 0.4 });
    const t = await open("pkg:tree/main");
    expect(await core.handlers["widget.frameSource"]({ windowId: t.id })).toBeNull();
    await expect(core.handlers["widget.frame"]({ windowId: t.id, verb: "state.set", params: ["x", 1] })).rejects.toThrow(/not a frame widget/);
  });

  it("opens a link only after a press, and only http(s); any other verb is refused", async () => {
    const { core, open } = await setup([{ name: "radio", surface: "frame", permissions: { workspace: ["read"] } }]);
    core.library.host.grant("radio");
    const w = await open();
    const count = () => core.windows.others().length;
    const before = count();
    await expect(core.handlers["widget.frame"]({ windowId: w.id, verb: "windows.open", params: ["https://example.com/"] })).rejects.toThrow(/right after the person presses/);
    expect(count()).toBe(before);
    await expect(core.handlers["widget.frame"]({ windowId: w.id, verb: "windows.open", params: ["/etc/passwd"], pressed: true })).rejects.toThrow(/http\(s\) links only/);
    await expect(core.handlers["widget.frame"]({ windowId: w.id, verb: "workspace.get" as "state.set", params: [] })).rejects.toThrow(/can't call workspace.get/);
    const r = (await core.handlers["widget.frame"]({ windowId: w.id, verb: "windows.open", params: ["https://example.com/"], pressed: true })) as { id: string };
    expect(count()).toBe(before + 1);
    expect(core.windows.others().find((x) => x.id === r.id)?.kind).toBe("browser");
  });
});
