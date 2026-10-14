// Asking, reloading and load failures of package widgets (docs/56, "Capabilities and grants" and
// "Hot reload"), with the fake runtime: a package waiting for a grant is asked once however many
// windows wait, a Decline stops asking until the person adds it again, a grant starts every
// waiting window; a burst of saves in a package's sources restarts its windows once, a
// package.json asking for more waits for the grant instead; a main that doesn't load stops
// with "didn't load" and the error, without a crash strike, until the next save; a package with
// thousands of files under node_modules costs a few watches.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppWindow, WidgetEntry, WidgetHostStatus } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { isSource, PackageReloader } from "../src/widgets/reload.ts";
import { loadError } from "../src/widgets/host/host.ts";
import { fakeFactory } from "./fake-pty.ts";
import { FakeWidgetRuntime, tmp, until, writePackage, type FakePackage } from "./fake-widget-runtime.ts";

const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close();
});

async function setup(pkgs: FakePackage[] = [{}], o: { link?: boolean } = {}) {
  const home = tmp("cmd-widgets-home-");
  const src = o.link ? tmp("cmd-widget-src-") : home;
  for (const p of pkgs) {
    const dir = writePackage(src, p);
    if (o.link) fs.symlinkSync(dir, path.join(home, path.basename(dir)));
  }
  process.env.CMD_WIDGETS_HOME = home;
  const core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, stateDir: tmp("cmd-state-") });
  delete process.env.CMD_WIDGETS_HOME;
  cores.push(core);
  const rt = new FakeWidgetRuntime(core.widgetTokens);
  core.library.host.configure({ runtime: rt, times: { pingMs: 20, stallMs: 5000, stopAfterMs: 100, restartMs: 5, helloMs: 2000 } });
  core.start();
  await core.scheduler.idle();
  const open = async (ref = "pkg:demo/main") => (await core.handlers["widget.add"]({ ref, workspaceId: core.workspaces.home().id })) as AppWindow;
  const status = (id: string) => core.library.host.status(id);
  const isStatus = (id: string, state: WidgetHostStatus["state"], reason?: string) => () => status(id)?.state === state && (reason === undefined || status(id)?.reason === reason);
  const entry = (name = "demo") => (core.handlers["widget.list"]({}) as WidgetEntry[]).find((e) => e.name === name);
  const dir = (name = "demo") => path.join(src, name);
  return { core, rt, open, status, isStatus, entry, dir, home };
}

describe("asking for a package's permissions", () => {
  it("asks once for a package whatever the number of windows waiting, and one grant starts them all", async () => {
    const { core, rt, open, isStatus, entry } = await setup([{ permissions: { net: ["api.github.com"] } }]);
    expect(entry()?.ask).toBeUndefined(); // no window waits, nothing asked
    const a = await open();
    const b = await open();
    await until(isStatus(a.id, "waiting-grant"), "the first window waiting");
    await until(isStatus(b.id, "waiting-grant"), "the second waiting");
    expect(entry()?.ask).toEqual({ granted: null });
    expect(entry()?.permissions?.net).toEqual(["api.github.com"]);
    expect(rt.procs).toHaveLength(0);
    core.handlers["widget.grant"]({ name: "demo" });
    await until(isStatus(a.id, "running"), "the first running");
    await until(isStatus(b.id, "running"), "the second running");
    expect(rt.procs).toHaveLength(2);
    expect(entry()?.ask).toBeUndefined();
  });

  it("stops asking after a Decline, the window still waiting, and asks again when the person adds it or asks", async () => {
    const { core, open, isStatus, entry } = await setup([{ permissions: { run: ["gh"] } }]);
    const w = await open();
    await until(isStatus(w.id, "waiting-grant"), "waiting");
    core.handlers["widget.ask"]({ name: "demo", decline: true });
    expect(entry()?.ask).toBeUndefined();
    expect(core.library.host.status(w.id)?.state).toBe("waiting-grant");
    core.handlers["widget.ask"]({ name: "demo" }); // Allow… in the window
    expect(entry()?.ask).toEqual({ granted: null });
    core.handlers["widget.ask"]({ name: "demo", decline: true });
    await open();
    expect(entry()?.ask).toEqual({ granted: null });
  });

  it("asks about a just linked package with no window, and not about one that asks for nothing", async () => {
    const { core, entry } = await setup([{ permissions: { net: ["example.com"] } }, { name: "plain" }]);
    core.handlers["widget.ask"]({ name: "demo" });
    core.handlers["widget.ask"]({ name: "plain" });
    expect(entry()?.ask).toEqual({ granted: null });
    expect(entry("plain")?.ask).toBeUndefined();
    core.handlers["widget.grant"]({ name: "demo" });
    expect(entry()?.ask).toBeUndefined();
  });

  it("asks again, with the old grant, when a new version asks for more; the same permissions don't", async () => {
    const { core, open, isStatus, entry, dir } = await setup([{ permissions: { net: ["a.example"] } }]);
    core.handlers["widget.grant"]({ name: "demo" });
    const w = await open();
    await until(isStatus(w.id, "running"), "running");
    writePackage(path.dirname(dir()), { permissions: { net: ["a.example"] }, config: [] }); // the same permissions
    core.library.packages.scan();
    expect(entry()?.ask).toBeUndefined();
    writePackage(path.dirname(dir()), { permissions: { net: ["a.example", "b.example"] } });
    core.library.packages.scan();
    await until(isStatus(w.id, "waiting-grant"), "waiting for the new grant");
    expect(entry()?.ask?.granted?.net).toEqual(["a.example"]);
  });
});

describe("a widget that doesn't load", () => {
  it("stops with “didn't load” and the error, no crash strike and no restart, and a reload starts it again", async () => {
    const { core, rt, open, isStatus, status } = await setup();
    rt.boot = (p) => {
      p.connect();
      p.send({ kind: "error", message: "The module's source code could not be parsed: Expected ';', got 'x' at file:///w/src/main.tsx:2:9", stack: "SyntaxError: The module's source code could not be parsed\n    at async file:///runtime/package-main.ts:95:9", componentStack: null });
      p.crash(1);
    };
    const w = await open();
    await until(isStatus(w.id, "stopped", "didn't load"), "Stopped · didn't load");
    expect(status(w.id)?.detail).toBe("The module's source code could not be parsed: Expected ';', got 'x' at file:///w/src/main.tsx:2:9 · /runtime/package-main.ts:95:9");
    expect(rt.procs).toHaveLength(1); // not started again: it would fail the same way
    rt.boot = (p) => p.connect().hello();
    core.library.host.reload("demo");
    await until(isStatus(w.id, "running"), "running after the fix");
    expect(rt.procs).toHaveLength(2);
  });

  it("counts an exit after hello as a crash, even after an error before it", async () => {
    const { rt, open, isStatus } = await setup();
    rt.boot = (p) => {
      p.connect();
      p.send({ kind: "error", message: "unhandled rejection in module scope", stack: null, componentStack: null });
      p.hello();
    };
    const w = await open();
    await until(isStatus(w.id, "running"), "running despite the early error");
    rt.boot = (p) => p.connect().hello();
    rt.last.crash(1);
    await until(() => rt.procs.length === 2, "restarted as after a crash");
    await until(isStatus(w.id, "running"), "running again");
  });

  it("says the error's first line and where, in the package's own words", () => {
    expect(loadError("boom", "Error: boom")).toBe("boom");
    expect(loadError("boom", null)).toBe("boom");
    const deno = "SyntaxError: Expression expected\n   |\n15 | }\n   | ~\n    at file:///p/demo/src/main.tsx:15:1";
    expect(loadError(deno, deno, "/p/demo")).toBe("SyntaxError: Expression expected · src/main.tsx:15:1");
  });
});

describe("hot reload", () => {
  it("watches the code, not node_modules, fixtures, tests or stories", () => {
    for (const p of ["main.tsx", "lib/rows.ts", "index.js"]) expect(isSource(p), p).toBe(true);
    for (const p of ["main.test.tsx", "main.story.tsx", "node_modules/x/index.js", "fixtures/busy.json", "test/a.ts", ".DS_Store", "lib/.main.tsx.swp"]) expect(isSource(p), p).toBe(false);
  });

  it("restarts every window of a linked package once for six files written within 100 ms", async () => {
    const { rt, open, isStatus, dir, core } = await setup([{}], { link: true });
    const a = await open();
    const b = await open();
    await until(isStatus(a.id, "running"), "a running");
    await until(isStatus(b.id, "running"), "b running");
    // The watch goes live a moment after it starts (FSEvents): save until one reload happens.
    const src = path.join(dir(), "src");
    for (let i = 0; rt.procs.length < 4; i++) {
      if (i === 10) throw new Error("no reload after 10 saves");
      fs.writeFileSync(path.join(src, "main.tsx"), `export default function Main() { return null; } // ${i}\n`);
      await until(() => rt.procs.length === 4, "a first reload", 1000).catch(() => {});
    }
    await until(() => !core.library.reloader.pending() && core.library.host.running() === 2, "the first reload done");
    const before = rt.procs.length;
    const t0 = Date.now();
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(src, `part${i}.ts`), `export const n = ${i};\n`);
    expect(Date.now() - t0).toBeLessThan(100);
    await until(() => rt.procs.length > before, "a reload after the burst");
    await until(() => !core.library.reloader.pending(), "no reload waiting");
    await until(isStatus(a.id, "running"), "a running again");
    expect(rt.procs.length - before).toBe(2); // one restart per window
    // A test or a story beside the code isn't a reload.
    fs.writeFileSync(path.join(src, "main.test.tsx"), "// test\n");
    fs.writeFileSync(path.join(src, "main.story.tsx"), "// story\n");
    expect(core.library.reloader.pending()).toBe(false);
  });

  it("a package.json that adds a host waits for the grant instead of restarting, then starts on Allow", async () => {
    const { core, rt, open, isStatus, dir, entry } = await setup([{ permissions: { net: ["a.example"] } }], { link: true });
    core.handlers["widget.grant"]({ name: "demo" });
    const w = await open();
    await until(isStatus(w.id, "running"), "running");
    const before = rt.procs.length;
    writePackage(path.dirname(dir()), { permissions: { net: ["a.example", "b.example"] } });
    fs.writeFileSync(path.join(dir(), "src", "main.tsx"), "export default function Main() { return null; } // new\n");
    core.library.host.reload("demo"); // what the burst's reload does
    expect(core.library.host.status(w.id)?.state).toBe("waiting-grant");
    expect(rt.alive()).toHaveLength(0);
    expect(rt.procs.length).toBe(before);
    expect(entry()?.ask?.granted?.net).toEqual(["a.example"]);
    core.handlers["widget.grant"]({ name: "demo" });
    await until(isStatus(w.id, "running"), "running after Allow");
    expect(rt.procs.length).toBe(before + 1);
  });

  it("costs a few watches for a package with 2000 files under node_modules", async () => {
    const root = tmp("cmd-widget-big-");
    const dir = writePackage(root, { name: "big" });
    for (let i = 0; i < 20; i++) {
      const d = path.join(dir, "node_modules", `dep${i}`, "lib");
      fs.mkdirSync(d, { recursive: true });
      for (let j = 0; j < 100; j++) fs.writeFileSync(path.join(d, `f${j}.js`), "module.exports = 1;\n");
    }
    fs.mkdirSync(path.join(dir, "dist"));
    const r = new PackageReloader({ onReload: () => {} });
    const t0 = performance.now();
    r.sync([{ dir, folder: "big", ok: true, pkg: { name: "big", dir } as never }]);
    const ms = performance.now() - t0;
    try {
      expect(r.watchers()).toBe(3); // the top, src/ and dist/
      expect(ms).toBeLessThan(1000);
      console.log(`watching a package with 2000 files under node_modules: ${r.watchers()} watches, ${ms.toFixed(1)} ms`);
    } finally {
      r.close();
    }
  });
});
