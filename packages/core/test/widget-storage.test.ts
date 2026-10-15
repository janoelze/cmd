// Widget storage, API 1.3 (docs/56, "Storage"; widgets/storage.ts, api/storage.ts): a package's
// values in three scopes. The package scope is shared by every window of the package and no
// other package; the workspace scope by its windows in one workspace; the window scope is
// `cmd.state`'s data (a window's kv from before 1.3 included). Scope ids come from the core,
// never from a call. Quotas refuse with the documented words. Uninstalling a package deletes
// its package and workspace data, an update keeps it, deleting a workspace deletes that
// workspace's. A migration runs once across windows starting together, before any of them
// reads; one that throws changes nothing. A frame uses storage as its process does, and
// `useStorage` in two windows (the real runtime, one module instance each) sees the other's set.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiMethods, AppWindow, WidgetFrameResult, WireValue, WorkspaceId } from "@cmd/protocol";
import type { Connection } from "../src/kernel/connection.ts";
import { Core } from "../src/kernel/core.ts";
import { ApiRefusal } from "../src/widgets/api/access.ts";
import { STORAGE_ERRORS } from "../src/widgets/api/storage.ts";
import { storageOwner } from "../src/widgets/library.ts";
import { fakeFactory } from "./fake-pty.ts";
import { FakeWidgetRuntime, tmp, until, writePackage, type FakePackage, type FakeProcess } from "./fake-widget-runtime.ts";

const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close();
});

async function setup(pkgs: FakePackage[] = [{ name: "notes" }, { name: "other" }]) {
  const home = tmp("cmd-widgets-home-");
  for (const p of pkgs) writePackage(home, p);
  process.env.CMD_WIDGETS_HOME = home;
  const core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, stateDir: tmp("cmd-state-") });
  delete process.env.CMD_WIDGETS_HOME;
  cores.push(core);
  const rt = new FakeWidgetRuntime(core.widgetTokens);
  core.library.host.configure({ runtime: rt, times: { pingMs: 20, stallMs: 2000, stopAfterMs: 100, restartMs: 5, helloMs: 2000 } });
  core.start();
  await core.scheduler.idle();
  const ws = (name: string) => core.workspaces.open(tmp(`cmd-ws-${name}-`)).workspace;
  const open = async (name = "notes", workspaceId: WorkspaceId = core.workspaces.home().id) => {
    const w = (await core.handlers["widget.add"]({ ref: `pkg:${name}/main`, workspaceId })) as AppWindow;
    await until(() => core.library.host.api(w.id), `${name}'s API`);
    return w.id;
  };
  /** A verb as the window's process (or frame) calls it. */
  const call = async <V extends keyof ApiMethods>(windowId: string, verb: V, ...params: ApiMethods[V]["params"]): Promise<ApiMethods[V]["result"]> =>
    (await core.library.host.api(windowId)!.call(verb, params as WireValue[])) as ApiMethods[V]["result"];
  /** The refusal of a call. */
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof ApiRefusal) return e.error;
      throw e;
    }
    throw new Error("the call wasn't refused");
  };
  return { core, rt, home, ws, open, call, refusal };
}

/** The process of a window. */
const procOf = (rt: FakeWidgetRuntime, core: Core, windowId: string): FakeProcess => {
  const w = core.windows.others().find((x) => x.id === windowId)!;
  const ps = rt.procs.filter((p) => !p.exited && `pkg:${p.spec.name}/${p.spec.widget}` === w.kind);
  // A window's process is the one whose token belongs to it.
  return ps.find((p) => core.widgetTokens.check(p.spec.token)?.widgetId === windowId)!;
};

describe("scopes", () => {
  it("shares the package scope between windows of a package, and only with them", async () => {
    const { open, call } = await setup();
    const [a, b, other] = [await open(), await open(), await open("other")];
    await call(a, "storage.set", "package", "notes", ["buy milk"]);
    expect(await call(b, "storage.get", "package", "notes")).toEqual(["buy milk"]);
    expect(await call(b, "storage.keys", "package")).toEqual(["notes"]);
    expect(await call(other, "storage.get", "package", "notes")).toBeNull();
    expect(await call(other, "storage.keys", "package")).toEqual([]);
    await call(other, "storage.set", "package", "notes", "mine");
    expect(await call(a, "storage.get", "package", "notes")).toEqual(["buy milk"]);
    await call(b, "storage.delete", "package", "notes");
    expect(await call(a, "storage.keys", "package")).toEqual([]);
    expect(await call(other, "storage.get", "package", "notes")).toBe("mine");
  });

  it("keeps the workspace scope per workspace", async () => {
    const { open, call, ws } = await setup();
    const [w1, w2] = [ws("one"), ws("two")];
    const [a1, b1, a2] = [await open("notes", w1.id), await open("notes", w1.id), await open("notes", w2.id)];
    await call(a1, "storage.set", "workspace", "todo", "ship it");
    expect(await call(b1, "storage.get", "workspace", "todo")).toBe("ship it");
    expect(await call(a2, "storage.get", "workspace", "todo")).toBeNull();
    await call(a2, "storage.set", "workspace", "todo", "review");
    expect(await call(a1, "storage.get", "workspace", "todo")).toBe("ship it");
    expect(await call(a2, "storage.history", "workspace", "runs", 3)).toEqual([3]);
    expect(await call(a1, "storage.history", "workspace", "runs")).toEqual([]);
  });

  it("is cmd.state in the window scope, and reads a window's kv from before 1.3", async () => {
    const { core, open, call } = await setup();
    const a = await open();
    // What a 1.2 widget left in its window.
    core.windows.update(a, { state: { kv: { filter: "busy" }, series: { cpu: [1, 2] } } });
    expect(await call(a, "storage.get", "window", "filter")).toBe("busy");
    expect(await call(a, "storage.history", "window", "cpu")).toEqual([1, 2]);
    await call(a, "storage.set", "window", "tab", "all");
    expect(await call(a, "state.get", "tab")).toBe("all");
    await call(a, "state.set", "sort", "name");
    expect(await call(a, "storage.keys", "window")).toEqual(["filter", "sort", "tab"]);
    expect(await call(a, "state.history", "cpu", 3)).toEqual([1, 2, 3]);
    expect(await call(a, "storage.history", "window", "cpu")).toEqual([1, 2, 3]);
    await call(a, "storage.delete", "window", "filter");
    expect(await call(a, "state.get", "filter")).toBeNull();
    expect(core.windows.others().find((w) => w.id === a)!.state.kv).toEqual({ tab: "all", sort: "name" });
    // Another window of the package has its own.
    expect(await call(await open(), "storage.keys", "window")).toEqual([]);
  });

  it("takes scope ids from the core: a call can't name another window, workspace or package", async () => {
    const { core, open, call, refusal, ws } = await setup();
    const elsewhere = ws("elsewhere");
    const [a, b, other] = [await open(), await open("notes", elsewhere.id), await open("other")];
    await call(b, "storage.set", "workspace", "k", "b's");
    await call(b, "storage.set", "window", "k", "b's window");
    await call(other, "storage.set", "package", "k", "other's");
    // Extra arguments naming an id, a package or a window are not read.
    const as = (verb: string, ...params: WireValue[]) => core.library.host.api(a)!.call(verb, params);
    expect(await as("storage.get", "workspace", "k", elsewhere.id)).toBeNull();
    expect(await as("storage.get", "window", "k", b)).toBeNull();
    expect(await as("storage.get", "package", "k", "other")).toBeNull();
    // A scope is a name, never an id or an object.
    for (const scope of [elsewhere.id, b, "other", { scope: "workspace", id: elsewhere.id }, null])
      expect((await refusal(as("storage.get", scope as WireValue, "k"))).code, JSON.stringify(scope)).toBe("invalid");
    // A live subscription's query names a scope and a key only.
    const pushed: WireValue[] = [];
    const off = core.library.host.api(a)!.subscribe("storage", { scope: "workspace", key: "k", id: elsewhere.id, owner: "other" }, (d) => pushed.push(d));
    await until(() => pushed.length, "the first push");
    expect(pushed).toEqual([null]);
    off();
    // A linked package (cmd widget link, cmd widget dev) keeps its own, apart from an installed one of its name.
    const real = tmp("cmd-dev-copy-");
    const link = path.join(tmp("cmd-links-"), "notes");
    fs.symlinkSync(real, link);
    expect([storageOwner({ name: "notes", dir: link }), storageOwner({ name: "notes", dir: real })]).toEqual(["link:notes", "notes"]);
  });
});

describe("quotas", () => {
  it("refuse with the documented words", async () => {
    const { open, call, refusal, ws } = await setup();
    const a = await open();
    const mb = "x".repeat(1024 * 1024);
    expect(await refusal(call(a, "storage.set", "package", "big", mb))).toEqual({ code: "failed", message: STORAGE_ERRORS.value });
    expect((await refusal(call(a, "storage.set", "package", "k".repeat(201), 1))).code).toBe("invalid");
    expect((await refusal(call(a, "storage.set", "package", "", 1))).code).toBe("invalid");
    // A window: 256 KB, as cmd.state always was.
    await call(a, "storage.set", "window", "a", "x".repeat(200 * 1024));
    expect(await refusal(call(a, "storage.set", "window", "b", "x".repeat(60 * 1024)))).toEqual({ code: "failed", message: STORAGE_ERRORS.window });
    expect(await refusal(call(a, "state.set", "b", "x".repeat(60 * 1024)))).toEqual({ code: "failed", message: STORAGE_ERRORS.window });
    // The package: 10 MB; a workspace: 10 MB of its own.
    const almost = "x".repeat(1024 * 1024 - 100);
    for (let i = 0; i < 10; i++) await call(a, "storage.set", "package", `p${i}`, almost);
    expect(await refusal(call(a, "storage.set", "package", "p10", almost))).toEqual({ code: "failed", message: STORAGE_ERRORS.package });
    await call(a, "storage.set", "package", "p9", "small"); // replacing a value counts the new one only
    await call(a, "storage.set", "package", "p10", "fits now");
    const w = await open("notes", ws("full").id);
    for (let i = 0; i < 10; i++) await call(w, "storage.set", "workspace", `w${i}`, almost);
    expect(await refusal(call(w, "storage.set", "workspace", "w10", almost))).toEqual({ code: "failed", message: STORAGE_ERRORS.workspace });
    await call(a, "storage.set", "workspace", "w0", almost); // another workspace has its own 10 MB
  });
});

describe("lifecycle", () => {
  it("keeps data across an update; an uninstall deletes the package's and its workspaces' data", async () => {
    const { core, rt, home, open, call, ws } = await setup();
    core.library.storagePurgeMs = 50;
    // A package gone and back restarts its windows twice in a row: a process whose token went before it connected is refused, as the socket would.
    rt.boot = (p) => {
      if (core.widgetTokens.check(p.spec.token)) p.connect().hello();
    };
    const w1 = ws("one");
    const a = await open("notes", w1.id);
    await call(a, "storage.set", "package", "k", 1);
    await call(a, "storage.set", "workspace", "k", 2);
    // An update: a new version of the package (and a Restore, gone a moment and back).
    const pkg = path.join(home, "notes", "package.json");
    const json = JSON.parse(fs.readFileSync(pkg, "utf8"));
    fs.writeFileSync(pkg, JSON.stringify({ ...json, version: "1.1.0" }));
    core.library.packages.scan();
    const away = path.join(tmp("cmd-away-"), "notes");
    fs.renameSync(path.join(home, "notes"), away);
    core.library.packages.scan();
    fs.renameSync(away, path.join(home, "notes"));
    core.library.packages.scan();
    await new Promise((r) => setTimeout(r, 120));
    const b = await open("notes", w1.id);
    expect([await call(b, "storage.get", "package", "k"), await call(b, "storage.get", "workspace", "k")]).toEqual([1, 2]);
    // Uninstalled: gone from the packages folder, and staying gone.
    fs.rmSync(path.join(home, "notes"), { recursive: true });
    core.library.packages.scan();
    await until(() => !core.library.storage.owners().includes("notes"), "the purge");
    expect(core.library.storage.keys({ owner: "notes", scope: "package", id: "" })).toEqual([]);
    expect(core.library.storage.keys({ owner: "notes", scope: "workspace", id: w1.id })).toEqual([]);
  });

  it("deletes a workspace's data with the workspace", async () => {
    const { core, open, call, ws } = await setup();
    const [w1, w2] = [ws("one"), ws("two")];
    await call(await open("notes", w1.id), "storage.set", "workspace", "k", 1);
    await call(await open("notes", w2.id), "storage.set", "workspace", "k", 2);
    await core.handlers["workspace.close"]({ id: w1.id });
    expect(core.library.storage.workspaces().sort()).toEqual([w1.id, w2.id].sort()); // closed is not deleted
    await core.handlers["workspace.forget"]({ id: w1.id });
    expect(core.library.storage.workspaces()).toEqual([w2.id]);
  });
});

describe("migrations", () => {
  /** Opens two windows of "mig" that start together, holding their hellos until both run; returns their processes. */
  async function twoWindows(s: Awaited<ReturnType<typeof setup>>) {
    const [a, b] = [await s.open("mig"), await s.open("mig")];
    await until(() => procOf(s.rt, s.core, a) && procOf(s.rt, s.core, b), "both processes");
    return [a, b] as const;
  }
  /** A save of package.json also reloads the package's windows (hot reload, a moment later): past that. */
  const settled = () => new Promise((r) => setTimeout(r, 500));
  const bump = (home: string, version: number) => {
    const pkg = path.join(home, "mig", "package.json");
    const json = JSON.parse(fs.readFileSync(pkg, "utf8"));
    fs.writeFileSync(pkg, JSON.stringify({ ...json, cmd: { ...json.cmd, storage: { version } } }));
  };

  it("runs once across windows starting together, before any of them reads; one that throws changes nothing", async () => {
    const s = await setup([{ name: "mig" }]);
    const { core, rt, home, call } = s;
    const [a, b] = await twoWindows(s);
    await until(() => procOf(rt, core, a).got("ready").length && procOf(rt, core, b).got("ready").length, "ready");
    expect(procOf(rt, core, a).got("ready")[0]!.migrate).toBeUndefined();
    await call(a, "storage.set", "package", "notes", "one, two");
    await call(a, "storage.set", "window", "draft", "x");

    // Version 2: both windows start again at once; one migrates, the other waits for it.
    bump(home, 2);
    core.library.packages.scan();
    await settled();
    await until(() => core.library.storage.locked("mig"), "a migration");
    const first = core.library.storage.locked("mig")!;
    const second = first === a ? b : a;
    expect(procOf(rt, core, first).got("ready")[0]!.migrate).toEqual({ from: 1, to: 2 });
    expect(procOf(rt, core, second).got("ready")).toEqual([]);
    // The other window's frame waits too, and reads what the migration wrote.
    const waiting = call(second, "storage.get", "package", "notes");
    let read: WireValue | undefined;
    void waiting.then((v) => (read = v));
    // The migration, as the process runs it: through the window's API.
    const p = procOf(rt, core, first);
    const prior = (await call(first, "storage.get", "package", "notes")) as string;
    await call(first, "storage.set", "package", "notes", prior.split(", "));
    await call(first, "storage.set", "window", "draft", null);
    await new Promise((r) => setTimeout(r, 30));
    expect(read).toBeUndefined();
    expect(core.library.storage.get({ owner: "mig", scope: "package", id: "" }, "kv", "notes")).toBe("one, two"); // staged, not kept yet
    p.send({ kind: "migrated", ok: true });
    await until(() => procOf(rt, core, second).got("ready").length, "the other window's ready");
    expect(procOf(rt, core, second).got("ready")[0]!.migrate).toBeUndefined();
    expect(await waiting).toEqual(["one", "two"]);
    expect(core.library.storage.version("mig")).toBe(2);
    expect(await call(first, "storage.keys", "window")).toEqual([]);

    // Version 3, whose migration throws: nothing it wrote is kept, the version stays, the window says why.
    bump(home, 3);
    core.library.packages.scan();
    await settled();
    await until(() => core.library.storage.locked("mig"), "the next migration");
    const failing = core.library.storage.locked("mig")!;
    expect(procOf(rt, core, failing).got("ready")[0]!.migrate).toEqual({ from: 2, to: 3 });
    const other = failing === a ? b : a;
    await call(failing, "storage.set", "package", "notes", "broken");
    procOf(rt, core, failing).send({ kind: "migrated", ok: false, message: "notes isn't a list" });
    await until(() => core.library.host.status(failing)?.state === "stopped", "the failed window stopped");
    expect(core.library.host.status(failing)).toMatchObject({ reason: "couldn't update its stored data", detail: "notes isn't a list Its stored data is as it was." });
    expect(core.library.storage.version("mig")).toBe(2);
    expect(core.library.storage.get({ owner: "mig", scope: "package", id: "" }, "kv", "notes")).toEqual(["one", "two"]);
    // The other window was waiting: now it runs the migration itself.
    await until(() => procOf(rt, core, other)?.got("ready").some((r) => r.migrate?.to === 3), "the other window's turn");
    procOf(rt, core, other).send({ kind: "migrated", ok: true });
    await until(() => core.library.storage.version("mig") === 3, "version 3");
  });

  it("drops a migration whose process stops before it ends", async () => {
    const s = await setup([{ name: "mig", storage: { version: 2 } }]);
    const { core, rt, call } = s;
    const a = await s.open("mig");
    await until(() => procOf(rt, core, a)?.got("ready").length, "ready");
    expect(procOf(rt, core, a).got("ready")[0]!.migrate).toEqual({ from: 1, to: 2 });
    await call(a, "storage.set", "package", "k", "half");
    const crashed = procOf(rt, core, a);
    crashed.crash();
    // It starts again (a crash restarts it) and runs the migration again, from what was kept: nothing.
    await until(() => procOf(rt, core, a) && procOf(rt, core, a) !== crashed && procOf(rt, core, a).got("ready").length, "the restart's ready");
    expect(procOf(rt, core, a).got("ready")[0]!.migrate).toEqual({ from: 1, to: 2 });
    expect(await call(a, "storage.get", "package", "k")).toBeNull();
    expect(core.library.storage.version("mig")).toBe(1);
    expect(core.library.storage.keys({ owner: "mig", scope: "package", id: "" })).toEqual([]);
  });
});

describe("frames and live updates", () => {
  it("serves storage to a frame as to its process, and pushes a set to every window's subscription", async () => {
    const { core, open, call } = await setup([{ name: "pad", surface: "frame" }]);
    const [a, b] = [await open("pad"), await open("pad")];
    const conn = { access: "local", send: () => {}, close: () => {} } as unknown as Connection;
    const frame = (windowId: string, verb: string, params: unknown[]) => core.handlers["widget.frame"]({ windowId, frame: "f1", verb, params, pressed: false }, { conn }) as Promise<WidgetFrameResult>;
    expect(await frame(a, "storage.set", ["package", "text", "hello"])).toEqual({ ok: true, value: null });
    expect(await frame(b, "storage.get", ["package", "text"])).toEqual({ ok: true, value: "hello" });
    expect(await frame(b, "storage.keys", ["package"])).toEqual({ ok: true, value: ["text"] });
    const pushed: WireValue[] = [];
    const off = core.library.host.api(b)!.subscribe("storage", { scope: "package", key: "text" }, (d) => pushed.push(d));
    await until(() => pushed.length === 1, "the first push");
    await call(a, "storage.set", "package", "text", "hello again");
    await until(() => pushed.length === 2, "the push after a set");
    expect(pushed).toEqual(["hello", "hello again"]);
    off();
  });

  it("useStorage in two windows sees the other's set", async () => {
    const { core, rt, open } = await setup([{ name: "live" }]);
    // Each window's process runs the real runtime over its fake process; each its own module instance, as each is its own process.
    const sets: ((v: number | ((p: number) => number)) => void)[] = [];
    const seen: number[][] = [[], []];
    rt.boot = (p) => {
      const i = rt.procs.indexOf(p);
      p.connect();
      void (async () => {
        vi.resetModules();
        const runtime = await import("@cmd/widget-api/runtime");
        const api = await import("@cmd/widget-api");
        const listeners = new Set<(m: never) => void>();
        p.onMessage = (m) => listeners.forEach((fn) => fn(m as never));
        const Widget = () => {
          const [n, set] = api.useStorage<number>("package", "count", 0);
          sets[i] = set;
          seen[i]!.push(n);
          return null;
        };
        await runtime.run({ send: (m) => p.send(m), listen: (fn) => (listeners.add(fn), () => listeners.delete(fn)) }, Widget, { package: "live", version: "1.0.0", widget: "main" });
      })();
    };
    await open("live");
    await open("live");
    await until(() => sets[0] && sets[1] && seen[1]!.length, "both widgets rendered");
    sets[0]!(5);
    await until(() => seen[1]!.includes(5), "window 2 sees window 1's set");
    sets[1]!(7);
    await until(() => seen[0]!.includes(7), "window 1 sees window 2's set");
    expect(core.library.storage.get({ owner: "live", scope: "package", id: "" }, "kv", "count")).toBe(7);
  });
});
