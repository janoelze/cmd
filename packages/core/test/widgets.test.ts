// The Widget Library and the versions of packages made with Magic (docs/16, docs/56 phase 2b):
// built-in widgets and packages listed and added; a package Magic made keeps a version per
// build, Restore brings one back (its files, then the window reloads once, through the package
// watcher), a hand edit becomes a version named "Edited by hand" once per burst, and a linked
// package, whose folder is the person's own, is never written by Restore; a folder that isn't a
// package is logged once, and not while a build writes it.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppWindow, CoreEvent, MagicPackageInfo, WidgetEntry } from "@cmd/protocol";
import { initLog } from "@cmd/protocol/node";
import { Core } from "../src/kernel/core.ts";
import { WidgetPackages } from "../src/widgets/packages.ts";
import { PackageRevisions, listFiles } from "../src/widgets/revisions.ts";
import { WindowTypes } from "../src/windows/types.ts";
import { fakeFactory } from "./fake-pty.ts";
import { FakeWidgetRuntime, tmp, until, writePackage } from "./fake-widget-runtime.ts";

const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close();
  delete process.env.CMD_WIDGETS_HOME;
});

function core(o: { home?: string; stateDir?: string } = {}): Core {
  process.env.CMD_WIDGETS_HOME = o.home ?? tmp("cmd-widgets-home-");
  const c = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, stateDir: o.stateDir ?? tmp("cmd-state-"), magicPreviewer: null });
  delete process.env.CMD_WIDGETS_HOME;
  cores.push(c);
  return c;
}

describe("the Widget Library", () => {
  it("lists built-in widgets first, adds one (about a folder too), and refuses what isn't a widget", async () => {
    const c = core();
    c.library.host.configure({ runtime: null });
    c.start();
    await c.scheduler.idle();
    const all = () => c.handlers["widget.list"]({}) as WidgetEntry[];
    const types = c.handlers["window.types"]({}) as unknown as { kind: string; role: string }[];
    expect(types.find((t) => t.kind === "magic")!.role).toBe("widget");
    expect(all().map((e) => e.source)).not.toContain("yours");
    expect(all().slice(0, 3)).toEqual([
      expect.objectContaining({ ref: "type:agents", source: "builtin", title: "Agent Activity", windows: [] }),
      expect.objectContaining({ ref: "type:diff", source: "builtin", title: "Live Diff", windows: [] }),
      expect.objectContaining({ ref: "type:actions", source: "builtin", title: "Workspace Actions", windows: [] }),
    ]);
    const activity = c.handlers["widget.add"]({ ref: "type:agents" }) as AppWindow;
    expect(activity).toMatchObject({ kind: "agents", state: { scope: "workspace" } });
    const repo = tmp("cmd-diff-");
    expect(c.handlers["widget.add"]({ ref: "type:diff", cwd: repo })).toMatchObject({ kind: "diff", state: { path: repo } });
    expect(all()[0]!.windows).toEqual([activity.id]);
    expect(() => c.handlers["widget.add"]({ ref: "type:browser" })).toThrow(/not a widget/);
    expect(() => c.handlers["widget.add"]({ ref: "magic:0b6c" })).toThrow(/not a widget/);
    expect(() => c.handlers["widget.delete"]({ ref: "type:agents" })).toThrow(/isn't a widget made with Magic/);
  });

  it("offers developer widgets only with their setting on, and says so when it changes", async () => {
    const c = core();
    c.start();
    await c.scheduler.idle();
    const events: CoreEvent[] = [];
    c.serve({ access: "local", send: (line) => {
      const m = JSON.parse(line) as { method?: string; params?: CoreEvent };
      if (m.method === "event") events.push(m.params!);
    }, close: () => {} }).receive(JSON.stringify({ id: 1, method: "events.subscribe", params: {} }));
    const refs = () => (c.handlers["widget.list"]({}) as WidgetEntry[]).map((e) => e.ref);
    expect(refs()).not.toContain("type:events");
    await c.handlers["settings.set"]({ key: "widgets.developer", value: true });
    expect(refs()).toContain("type:events");
    await until(() => events.some((e) => e.type === "widget.library" && e.entries.some((x) => x.ref === "type:events")), "the library event");
  });
});

/** The demo package as Magic would have left it: cmd's mark in package.json, version 1 kept. */
function magicPackage(home: string, stateDir: string, o: { link?: boolean } = {}) {
  const src = o.link ? tmp("cmd-widget-src-") : home;
  const dir = writePackage(src);
  // Version 1 without cmd's mark, as 2a's builds kept it (the mark was written after).
  const revs = new PackageRevisions(stateDir, "demo");
  revs.snapshot(dir, { prompt: "a demo", ok: true }, Buffer.from("png"));
  const json = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  json.cmd.magic = { request: "a demo", madeAt: new Date().toISOString(), revisions: 1 };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(json, null, 2) + "\n");
  if (o.link) fs.symlinkSync(dir, path.join(home, "demo"));
  return { dir, revs };
}

async function setup(o: { link?: boolean } = {}) {
  const home = tmp("cmd-widgets-home-");
  const stateDir = tmp("cmd-state-");
  const { dir, revs } = magicPackage(home, stateDir, o);
  const c = core({ home, stateDir });
  const rt = new FakeWidgetRuntime(c.widgetTokens);
  c.library.host.configure({ runtime: rt, times: { pingMs: 20, stallMs: 5000, stopAfterMs: 100, restartMs: 5, helloMs: 2000 } });
  c.start();
  await c.scheduler.idle();
  const w = (await c.handlers["widget.add"]({ ref: "pkg:demo/main", workspaceId: c.workspaces.home().id })) as AppWindow;
  const running = () => c.library.host.status(w.id)?.state === "running";
  await until(running, "the widget running");
  const info = () => c.handlers["magic.package"]({ windowId: w.id }) as MagicPackageInfo;
  /** Saves settled: no reload waiting for its burst, the window running again. */
  const settled = () => until(() => !c.library.reloader.pending() && running(), "the reload to settle", 5000);
  return { c, rt, w, dir, revs, info, settled, main: path.join(dir, "src", "main.tsx") };
}

describe("versions of a package made with Magic", () => {
  it("restores a version: its files come back, it is kept as a new version, and the window restarts once", async () => {
    const { c, rt, w, dir, revs, info, settled, main } = await setup();
    const v1 = fs.readFileSync(main, "utf8");
    // A second build: its files, then its version (as magic/package/service.ts keeps it).
    fs.writeFileSync(main, "export default function Main() { return 'blue'; }\n");
    revs.snapshot(dir, { prompt: "make it blue", ok: true });
    await settled();
    expect(info().revisions.map((r) => r.prompt)).toEqual(["a demo", "make it blue"]);
    const before = rt.procs.length;

    c.handlers["magic.restorePackage"]({ windowId: w.id, revision: 1 });
    expect(fs.readFileSync(main, "utf8")).toBe(v1);
    await until(() => rt.procs.length > before, "the window to restart");
    await settled();
    expect(rt.procs.length).toBe(before + 1);
    const i = info();
    expect(i.revisions.map((r) => r.prompt)).toEqual(["a demo", "make it blue", "Back to version 1: a demo"]);
    expect(i.revisions.at(-1)!.shot).toBeTruthy(); // version 1's screenshot comes with it
    expect(i).toMatchObject({ name: "demo", edited: false, building: false });
    expect(i.link).toBeUndefined();
    // Still made with Magic, though version 1's package.json had no mark.
    expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).cmd.magic).toMatchObject({ request: "a demo", revisions: 3 });
    expect((c.handlers["widget.list"]({}) as WidgetEntry[]).find((e) => e.name === "demo")?.magic).toBeTruthy();
    expect(() => c.handlers["magic.restorePackage"]({ windowId: w.id, revision: 9 })).toThrow(/no version 9/);
  });

  it("keeps a hand edit as a version named Edited by hand, once per burst", async () => {
    const { c, rt, w, dir, info, settled, main } = await setup();
    // An editor saving three files at once.
    fs.writeFileSync(main, "export default function Main() { return 'by hand'; }\n");
    fs.writeFileSync(path.join(dir, "src", "util.ts"), "export const x = 1;\n");
    fs.writeFileSync(path.join(dir, "README.md"), "# Demo\n");
    await until(() => info().revisions.some((r) => r.prompt === "Edited by hand"), "the hand edit's version", 5000);
    await settled();
    const hand = info().revisions.filter((r) => r.prompt === "Edited by hand");
    expect(hand).toHaveLength(1);
    expect(hand[0]).toMatchObject({ hand: true });
    expect(info().edited).toBe(false);
    // Restoring isn't an edit by hand.
    const before = rt.procs.length;
    c.handlers["magic.restorePackage"]({ windowId: w.id, revision: 1 });
    await until(() => rt.procs.length > before, "the restore's reload");
    await settled();
    expect(info().revisions.map((r) => r.prompt)).toEqual(["a demo", "Edited by hand", "Back to version 1: a demo"]);
  });

  it("never writes into a linked package's folder: Restore is refused, and the edit view knows why", async () => {
    const { c, w, dir, revs, info, main } = await setup({ link: true });
    fs.writeFileSync(main, "export default function Main() { return 'mine'; }\n");
    revs.snapshot(dir, { prompt: "make it mine", ok: true });
    expect(info().link).toBe(fs.realpathSync(dir));
    expect(() => c.handlers["magic.restorePackage"]({ windowId: w.id, revision: 1 })).toThrow(/linked from .*your own folder/);
    expect(fs.readFileSync(main, "utf8")).toContain("mine");
    expect(() => c.handlers["widget.delete"]({ ref: "pkg:demo/main" })).toThrow(/isn't a widget made with Magic/);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("counts the package's own files only: no node_modules, links or dot-folders (`cmd widget preview`'s .cmd-preview)", () => {
    const dir = tmp("files");
    for (const f of ["package.json", "src/w.tsx", "node_modules/x/index.js", ".cmd-preview/Busy-wide-dark.png", ".git/HEAD"]) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), "");
    }
    expect(listFiles(dir)).toEqual(["package.json", "src/w.tsx"]);
  });

  it("has no versions for a package Magic didn't make", async () => {
    const home = tmp("cmd-widgets-home-");
    writePackage(home, { name: "plain" });
    const c = core({ home });
    c.library.host.configure({ runtime: null });
    c.start();
    await c.scheduler.idle();
    const w = (await c.handlers["widget.add"]({ ref: "pkg:plain/main", workspaceId: c.workspaces.home().id })) as AppWindow;
    expect(c.handlers["magic.package"]({ windowId: w.id })).toBeNull();
    expect(() => c.handlers["magic.restorePackage"]({ windowId: w.id, revision: 1 })).toThrow(/made with Magic/);
  });
});

describe("a folder that isn't a package", () => {
  it("is logged once, not on every scan, and not while a build writes it", () => {
    process.env.CMD_LOG_DIR = tmp("cmd-log-");
    const log = initLog("widgets-test");
    const home = tmp("cmd-widgets-home-");
    const quiet = new Set<string>(["building"]);
    const pkgs = new WidgetPackages({ home, types: () => new WindowTypes(), onChange: () => {}, quiet });
    fs.mkdirSync(path.join(home, "half-written"));
    fs.mkdirSync(path.join(home, "building"));
    const lines = () => log.tail.filter((l) => l.includes("can't be used"));
    pkgs.scan();
    fs.writeFileSync(path.join(home, "building", "notes.txt"), "x"); // a change: the folders are read again
    pkgs.scan();
    pkgs.scan();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("widget package half-written can't be used: package.json: not found in this folder");
    // The build is over and the folder still isn't a package: now it says so, once.
    quiet.delete("building");
    pkgs.scan();
    pkgs.scan();
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toContain("widget package building can't be used");
    pkgs.dispose();
  });
});

describe("the split (docs/56, \"The split\")", () => {
  it("widgets/ imports nothing from magic/", () => {
    const root = path.resolve(import.meta.dirname, "../src/widgets");
    const files = (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    const offenders = files.filter((f) => /from "(\.\.\/)+magic\//.test(fs.readFileSync(path.join(root, f), "utf8")) || /import\("(\.\.\/)+magic\//.test(fs.readFileSync(path.join(root, f), "utf8")));
    expect(files.length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
