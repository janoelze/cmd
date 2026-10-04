// Magic v2 (docs/14-magic-v2.md): widget folders, their manifest, revisions,
// running data.ts in Deno against its schema, the build loop's own check, and
// Magic windows in the core (refresh, health, config, revisions, hand edits).

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWidget,
  checkTypes,
  findDeno,
  parseManifest,
  configValues,
  runData,
  sandboxAvailable,
  viewScript,
  verifyWidget,
  WidgetStore,
  type Backend,
  type Previewer,
  type VerifyContext,
} from "../src/magic/index.ts";
import type { BackendRun } from "../src/magic/backends.ts";

const DENO = findDeno();
const sandbox = sandboxAvailable() ? ("required" as const) : ("off" as const);
const tmp = (p = "cmd-widgets-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const denoEnv = () => ({ deno: DENO!, denoDir: path.join(os.tmpdir(), "cmd-test-deno"), sandbox });

const MANIFEST = (o: Record<string, unknown> = {}) => JSON.stringify({ cmd: 2, kind: "widget", title: "Count", size: "s", refresh: 5, permissions: { net: [], run: [], env: [], read: [] }, config: [{ key: "start", title: "Start", type: "number", default: 0 }], ...o });
const DATA = (n = 3) => `import { s, type Infer } from "cmd";
export const schema = s.object({ n: s.number(), label: s.string().optional() });
export type Data = Infer<typeof schema>;
export default async function data(config: { start?: number }): Promise<Data> {
  console.log("noise on stdout");
  return { n: (config.start ?? 0) + ${n} };
}
`;
const VIEW_HTML = `<div id="n">–</div>`;
const VIEW_TS = `import type { Data } from "./data.ts";
const el = document.getElementById("n")!;
cmd.onData<Data>((d) => { el.textContent = String(d.n); });
`;

/** Renders nothing; reports a script error for pages containing BROKEN. */
const fakePreviewer: Previewer = {
  name: "fake",
  async render(requests) {
    return requests.map((r) => ({ errors: r.page.includes("BROKEN") ? ["ReferenceError: BROKEN is not defined"] : [], text: 10, nodes: 5, drawn: false, scrollW: r.width, scrollH: r.height, png: r.shot ? "iVBORw0KGgo=" : undefined }));
  },
};

describe("manifest", () => {
  it("parses a widget and fills in defaults", () => {
    const r = parseManifest({ title: "VPN", refresh: 0.5, permissions: { net: ["https://api.x.com/v1"], run: ["ifconfig"] }, config: [{ key: "city", type: "string", default: "Lisbon" }, { key: "token", secret: true }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest).toMatchObject({ kind: "widget", size: "m", refresh: 2, permissions: { net: ["api.x.com"], run: ["ifconfig"], env: [], read: [] } });
    expect(configValues(r.manifest, { city: "" })).toEqual({ city: "Lisbon" });
    expect(configValues(r.manifest, { city: "Porto", token: "x" })).toEqual({ city: "Porto" });
  });

  it("refuses shells, bad hosts and terminals without a command", () => {
    const bad = (v: unknown) => {
      const r = parseManifest(v);
      return r.ok ? [] : r.errors;
    };
    expect(bad({ title: "x", permissions: { run: ["sh"] } })[0]).toMatch(/run anything/);
    expect(bad({ title: "x", permissions: { run: ["/usr/bin/python3"] } })[0]).toMatch(/run anything/);
    expect(bad({ title: "x", permissions: { net: ["a b"] } })[0]).toMatch(/not a host/);
    expect(bad({ title: "x", kind: "terminal" })[0]).toMatch(/command/);
    expect(bad({ kind: "widget" })[0]).toMatch(/title/);
    expect(bad({ title: "x", media: ["http://radio.example"] })[0]).toMatch(/https origin/);
  });
});

describe("view script", () => {
  it("strips types and allows only type imports", () => {
    const js = viewScript(VIEW_TS);
    expect(typeof js).toBe("string");
    expect(js).not.toContain("import");
    expect(js).toContain("cmd.onData");
    expect(viewScript(`import { x } from "./data.ts";\nx();`)).toMatchObject({ errors: [expect.stringMatching(/only import types/)] });
  });
});

describe("widget store", () => {
  it("keeps only widget files, composes the view and keeps revisions", () => {
    const store = new WidgetStore(tmp());
    store.ensure("w1");
    expect(() => store.write("w1", "../escape.ts", "x")).toThrow(/a widget has only/);
    expect(() => store.write("w1", "notes.txt", "x")).toThrow();
    store.write("w1", "manifest.json", MANIFEST());
    store.write("w1", "view.html", VIEW_HTML);
    store.write("w1", "view.ts", VIEW_TS + `const s = "</script>";\n`);
    store.write("w1", "fixtures/empty.json", '{"n": 0}');
    const c = store.compose("w1");
    expect(c.ok).toBe(true);
    expect(c.html).toMatch(/^<div id="n">–<\/div>\n<script>/);
    expect(c.html).not.toContain('"</script>"');
    expect(store.fixtures("w1")).toEqual([{ name: "empty", data: { n: 0 } }]);

    const r1 = store.snapshot("w1", { prompt: "a counter", ok: true }, Buffer.from("png"));
    expect(r1).toMatchObject({ n: 1, prompt: "a counter", shot: true });
    expect(store.changedSinceLatest("w1")).toBe(false);
    store.write("w1", "view.html", "<b id=n></b>");
    store.remove("w1", "fixtures/empty.json");
    expect(store.changedSinceLatest("w1")).toBe(true);
    store.snapshot("w1", { prompt: "bold", ok: true });
    store.checkout("w1", 1);
    expect(store.read("w1", "view.html")).toBe(VIEW_HTML);
    expect(store.read("w1", "fixtures/empty.json")).toBe('{"n": 0}');
    expect(store.revisions("w1").map((r) => r.prompt)).toEqual(["a counter", "bold"]);
  });
});

describe.skipIf(!DENO)("data.ts in Deno", () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/limited") {
        res.writeHead(429, { "retry-after": "120" });
        res.end("slow down");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ temp: 21.5 }));
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  const widget = (files: Record<string, string>) => {
    const store = new WidgetStore(tmp());
    store.ensure("w");
    for (const [f, t] of Object.entries(files)) store.write("w", f, t);
    const m = store.manifest("w");
    if (!m.ok) throw new Error(m.errors.join("; "));
    return { dir: store.dir("w"), m: m.manifest, store };
  };

  it("runs data.ts with its config and validates the result", async () => {
    const { dir, m } = widget({ "manifest.json": MANIFEST(), "data.ts": DATA() });
    const r = await runData(dir, m, { ...denoEnv(), cwd: os.tmpdir(), config: { start: 10 } });
    expect(r).toMatchObject({ ok: true, data: { n: 13 } });
    expect(r.stderr).toContain("noise on stdout");
  });

  it("reports data of the wrong shape with the paths that are wrong", async () => {
    const { dir, m } = widget({ "manifest.json": MANIFEST(), "data.ts": DATA().replace("return { n: (config.start ?? 0) + 3 };", 'return { n: "3", label: 4 } as never;') });
    const r = await runData(dir, m, { ...denoEnv(), cwd: os.tmpdir(), config: {} });
    expect(r.ok).toBe(false);
    expect(r.issues?.map((i) => i.path)).toEqual(["n", "label"]);
    expect(r.error).toMatch(/doesn't match the schema/);
  });

  it("refuses what the manifest doesn't permit, and passes on how long a server asks to wait", async () => {
    const fetching = (url: string) => `import { s, fetchJson } from "cmd";\nexport const schema = s.object({ temp: s.number() });\nexport default async () => fetchJson<{ temp: number }>(${JSON.stringify(url)});\n`;
    const denied = widget({ "manifest.json": MANIFEST(), "data.ts": fetching(`http://127.0.0.1:${port}/ok`) });
    const r1 = await runData(denied.dir, denied.m, { ...denoEnv(), cwd: os.tmpdir(), config: {} });
    expect(r1).toMatchObject({ ok: false, permission: true });

    const host = `127.0.0.1:${port}`;
    const ok = widget({ "manifest.json": MANIFEST({ permissions: { net: [host] } }), "data.ts": fetching(`http://${host}/ok`) });
    expect(await runData(ok.dir, ok.m, { ...denoEnv(), cwd: os.tmpdir(), config: {} })).toMatchObject({ ok: true, data: { temp: 21.5 } });

    const limited = widget({ "manifest.json": MANIFEST({ permissions: { net: [host] } }), "data.ts": fetching(`http://${host}/limited`) });
    expect(await runData(limited.dir, limited.m, { ...denoEnv(), cwd: os.tmpdir(), config: {} })).toMatchObject({ ok: false, status: 429, retryAfter: 120 });
  });

  it("type-checks the view against the data's schema", async () => {
    const { dir } = widget({ "manifest.json": MANIFEST(), "data.ts": DATA(), "view.html": VIEW_HTML, "view.ts": VIEW_TS.replace("d.n", "d.count") });
    const r = await checkTypes(dir, denoEnv());
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/Property 'count' does not exist/);
    fs.writeFileSync(path.join(dir, "view.ts"), VIEW_TS);
    expect(await checkTypes(dir, denoEnv())).toEqual({ ok: true, errors: [] });
  });

  it("verifies a whole widget: types, a data run kept as a fixture, renders", async () => {
    const { store } = widget({ "manifest.json": MANIFEST(), "data.ts": DATA(), "view.html": VIEW_HTML, "view.ts": VIEW_TS, "fixtures/big.json": '{"n": 1e9}' });
    const ctx: VerifyContext = { store, id: "w", deno: denoEnv(), previewer: fakePreviewer, cwd: os.tmpdir() };
    const v = await verifyWidget(ctx);
    expect(v).toMatchObject({ ok: true, usable: true, data: { n: 3 } });
    expect(JSON.parse(store.read("w", "fixtures/live.json")!)).toEqual({ n: 3 });
    store.write("w", "view.ts", VIEW_TS + "BROKEN;\n");
    const v2 = await verifyWidget(ctx);
    expect(v2.ok).toBe(false);
    expect(v2.usable).toBe(false);
    expect(v2.problems.some((p) => /script error/.test(p))).toBe(true);
  });
});

/** A backend that plays a script: tool calls, then a closing sentence, per turn. */
function scripted(turns: { calls?: { name: string; input: Record<string, unknown> }[]; answer?: string }[]): Backend & { seen: BackendRun[] } {
  const seen: BackendRun[] = [];
  let i = 0;
  return {
    name: "fake",
    model: "fake-1",
    seen,
    async run(r) {
      seen.push(r);
      const t = turns[Math.min(i++, turns.length - 1)]!;
      for (const c of t.calls ?? []) {
        r.onTurn();
        await r.exec(c.name, { why: c.name, ...c.input });
      }
      r.onTurn();
      r.onText(t.answer ?? "Done.");
      return { text: t.answer ?? "Done.", model: "fake-1", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } };
    },
  };
}

const write = (p: string, content: string) => ({ name: "write_file", input: { path: p, content } });
const WIDGET_CALLS = (data = DATA()) => [write("manifest.json", MANIFEST()), write("data.ts", data), write("view.html", VIEW_HTML), write("view.ts", VIEW_TS), { name: "check", input: {} }, { name: "run_data", input: {} }, { name: "preview", input: {} }];

describe.skipIf(!DENO)("buildWidget", () => {
  const ctx = (): VerifyContext => ({ store: new WidgetStore(tmp()), id: "w", deno: denoEnv(), previewer: fakePreviewer, cwd: os.tmpdir() });

  it("builds a widget with the tools and accepts it once cmd's own check passes", async () => {
    const c = ctx();
    const backend = scripted([{ calls: WIDGET_CALLS(), answer: "Shows a count." }]);
    const titles: string[] = [];
    const r = await buildWidget({ prompt: "count things", backend, widget: c, sandbox, noFast: true, onEvent: (e) => e.type === "title" && titles.push(e.title) });
    expect(r).toMatchObject({ route: "agent", ok: true, summary: "Shows a count.", repairs: [] });
    expect(titles).toEqual(["Count"]);
    expect(r.trace.map((s) => s.tool)).toEqual(["write_file", "write_file", "write_file", "write_file", "check", "run_data", "preview"]);
    expect(r.trace.find((s) => s.tool === "run_data")!.output).toContain('"n": 3');
    expect(backend.seen[0]!.system).toContain("# Examples");
    expect(backend.seen[0]!.messages[0]!.content).toMatch(/^Request: count things[\s\S]*Widget folder: /);
    expect(backend.seen[0]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["write_file", "edit_file", "check", "run_data", "preview", "fetch"]));
  });

  it("sends what its check finds back to the agent until it is fixed", async () => {
    const c = ctx();
    const backend = scripted([
      { calls: [...WIDGET_CALLS().slice(0, 3), write("view.ts", VIEW_TS.replace("d.n", "d.count"))], answer: "Done." },
      { calls: [{ name: "edit_file", input: { path: "view.ts", old: "d.count", new: "d.n" } }], answer: "Fixed the field name." },
    ]);
    const r = await buildWidget({ prompt: "count things", backend, widget: c, sandbox, noFast: true });
    expect(r.repairs).toHaveLength(1);
    expect(r.repairs[0]).toMatch(/Property 'count' does not exist/);
    expect(r.ok).toBe(true);
    expect(backend.seen[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("makes pasted JSON a JSON view and an obvious command a terminal, without a model", async () => {
    const backend = scripted([{ answer: "never" }]);
    const j = await buildWidget({ prompt: '{"a": [1, 2]}', backend, widget: ctx(), sandbox });
    expect(j).toMatchObject({ route: "json", ok: true });
    expect(j.verdict.data).toEqual({ a: [1, 2] });
    if (process.platform !== "win32") {
      const t = await buildWidget({ prompt: "ls -la", backend, widget: ctx(), sandbox });
      expect(t.verdict.manifest).toMatchObject({ kind: "terminal", command: "ls -la" });
    }
    expect(backend.seen).toHaveLength(0);
  });
});

describe.skipIf(!DENO)("Magic windows in the core", () => {
  beforeAll(() => void (process.env.CMD_MAGIC_UNSANDBOXED = "1"));
  afterAll(() => void delete process.env.CMD_MAGIC_UNSANDBOXED);

  let dump: (() => unknown) | null = null;
  const until = async (cond: () => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out" + (dump ? ": " + JSON.stringify(dump()).slice(0, 1500) : ""));
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  async function setup(backend: Backend) {
    const { Core } = await import("../src/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const core = new Core({ socketPath: "", dbPath: null, terminals: fakeFactory().factory, pollMs: 0, magicBackend: () => backend, magicPreviewer: fakePreviewer, magicDeno: DENO });
    const events: { type: string; id?: string; data?: unknown; error?: string }[] = [];
    core.serve({ access: "local", send: (line) => {
      const m = JSON.parse(line) as { method?: string; params?: { type: string } };
      if (m.method === "event") events.push(m.params as never);
    }, close: () => {} }).receive(JSON.stringify({ id: 1, method: "events.subscribe", params: {} }));
    const w = core.handlers["window.open"]({ kind: "magic", input: {} }) as unknown as { id: string };
    const state = () => core.windows.others().find((x) => x.id === w.id)!.state as Record<string, unknown>;
    const title = () => core.windows.others().find((x) => x.id === w.id)!.title;
    dump = () => ({ ...state(), html: undefined, steps: (state().steps as { tool: string; isError?: boolean; output?: string }[] | undefined)?.map((s) => [s.tool, s.isError, s.output?.slice(0, 200)]) });
    return { core, id: w.id, state, title, events };
  }

  it("builds a window's widget, keeps a revision, and refreshes its data", async () => {
    const { core, id, state, title, events } = await setup(scripted([{ calls: WIDGET_CALLS(), answer: "Shows a count." }]));
    core.handlers["magic.run"]({ id, prompt: "count to three" });
    expect(state().phase).toBe("working");
    await until(() => state().phase === "ready");
    expect(title()).toBe("Count");
    expect(state()).toMatchObject({ kind: "widget", widgetId: id, revision: 1, hasData: true, refresh: 5, lastData: { data: { n: 3 } }, summary: "Shows a count.", health: { ok: true } });
    expect(String(state().html)).toContain("cmd.onData");
    const info = core.handlers["magic.widget"]({ id }) as unknown as { revisions: { n: number; prompt: string }[]; files: string[] };
    expect(info.revisions).toEqual([expect.objectContaining({ n: 1, prompt: "count to three", ok: true })]);
    expect(info.files).toEqual(expect.arrayContaining(["manifest.json", "data.ts", "view.html", "view.ts", "fixtures/live.json"]));

    // Config reaches data.ts.
    core.handlers["magic.config"]({ id, values: { start: 100 } });
    await until(() => events.some((e) => e.type === "magic.data" && e.id === id && (e.data as { n?: number })?.n === 103));
    // cmd.state is kept in the window.
    core.handlers["magic.state"]({ id, key: "tab", value: "b" });
    expect(state().kv).toEqual({ tab: "b" });
    core.handlers["magic.state"]({ id, key: "tab", value: null });
    expect(state().kv).toEqual({});
    await core.close();
  });

  it("brings back an earlier revision, and notices hand edits", async () => {
    const backend = scripted([{ calls: WIDGET_CALLS(), answer: "v1" }, { calls: [write("data.ts", DATA(7)), { name: "run_data", input: {} }], answer: "v2" }]);
    const { core, id, state } = await setup(backend);
    core.handlers["magic.run"]({ id, prompt: "count" });
    await until(() => state().phase === "ready");
    core.handlers["magic.run"]({ id, prompt: "count to seven" });
    await until(() => state().phase === "ready" && state().revision === 2);
    expect(state().lastData).toMatchObject({ data: { n: 7 } });
    expect(backend.seen[1]!.messages[0]!.content).toContain("--- data.ts ---");
    expect(state().history).toEqual(["count", "count to seven"]);

    core.handlers["magic.restore"]({ id, revision: 1 });
    expect(state().revision).toBe(3);
    const info = core.handlers["magic.widget"]({ id }) as unknown as { dir: string; revisions: { prompt: string }[] };
    expect(info.revisions.at(-1)!.prompt).toMatch(/^Back to version 1/);
    expect(fs.readFileSync(path.join(info.dir, "data.ts"), "utf8")).toBe(DATA(3));

    fs.writeFileSync(path.join(info.dir, "view.html"), '<div id="n" class="k-big">–</div>');
    await until(() => state().revision === 4, 5000);
    expect(String(state().html)).toContain("k-big");
    expect((core.handlers["magic.widget"]({ id }) as unknown as { revisions: { prompt: string }[] }).revisions.at(-1)!.prompt).toBe("Edited by hand");
    await core.close();
  });

  it("keeps the widget that worked when a change fails", async () => {
    const backend = scripted([{ calls: WIDGET_CALLS(), answer: "v1" }, { calls: [write("view.ts", "BROKEN;")], answer: "oops" }]);
    const { core, id, state } = await setup(backend);
    core.handlers["magic.run"]({ id, prompt: "count" });
    await until(() => state().phase === "ready");
    const html = state().html;
    core.handlers["magic.run"]({ id, prompt: "break it" });
    await until(() => state().phase === "ready" && !!state().error);
    expect(state()).toMatchObject({ revision: 1, html });
    const info = core.handlers["magic.widget"]({ id }) as unknown as { dir: string; revisions: unknown[] };
    expect(info.revisions).toHaveLength(1);
    expect(fs.readFileSync(path.join(info.dir, "view.ts"), "utf8")).toBe(VIEW_TS);
    await core.close();
  });

  it("shows why data fails and keeps the last good data", async () => {
    const failing = DATA().replace('console.log("noise on stdout");', 'if ((config.start ?? 0) > 0) throw new Error("the service is down");');
    const { core, id, state, events } = await setup(scripted([{ calls: WIDGET_CALLS(failing), answer: "ok" }]));
    core.handlers["magic.run"]({ id, prompt: "count" });
    await until(() => state().phase === "ready");
    core.handlers["magic.config"]({ id, values: { start: 1 } });
    await until(() => (state().health as { ok?: boolean } | undefined)?.ok === false);
    expect(state().health).toMatchObject({ ok: false, failures: 1, error: expect.stringContaining("the service is down") });
    expect(state().lastData).toMatchObject({ data: { n: 3 } });
    expect(events.some((e) => e.type === "magic.data" && e.error?.includes("the service is down"))).toBe(true);
    core.handlers["magic.config"]({ id, values: { start: null } });
    await until(() => (state().health as { ok?: boolean }).ok === true);
    await core.close();
  });

  it("asks for a widget's media origins and remembers the answer", async () => {
    const media = [write("manifest.json", MANIFEST({ media: ["https://a.example", "https://b.example"] })), write("view.html", "<audio id=au></audio><p>Radio</p>"), { name: "check", input: {} }];
    const { core, id, state } = await setup(scripted([{ calls: media, answer: "a radio" }]));
    core.handlers["magic.run"]({ id, prompt: "a dnb radio" });
    await until(() => state().phase === "ready");
    expect(state()).toMatchObject({ media: ["https://a.example", "https://b.example"], hasData: false });
    core.handlers["magic.media"]({ id, allow: false });
    expect(state().mediaDenied).toEqual(["https://a.example", "https://b.example"]);
    core.handlers["magic.media"]({ id, allow: true });
    expect(state()).toMatchObject({ mediaAllowed: ["https://a.example", "https://b.example"], mediaDenied: [] });
    await core.close();
  });

  it("keeps the person's interval across changes, and reports empty requests", async () => {
    const backend = scripted([{ calls: WIDGET_CALLS(), answer: "v1" }, { calls: [write("view.html", '<div id="n" class="k-big"></div>')], answer: "v2" }]);
    const { core, id, state } = await setup(backend);
    expect(() => core.handlers["magic.run"]({ id, prompt: "  " })).toThrow(/empty/);
    core.handlers["magic.run"]({ id, prompt: "count" });
    await until(() => state().phase === "ready");
    core.handlers["magic.setRefresh"]({ id, seconds: 300 });
    expect(state()).toMatchObject({ refresh: 300, refreshByUser: true });
    core.handlers["magic.setRefresh"]({ id, seconds: 0.5 });
    expect(state().refresh).toBe(2);
    expect(() => core.handlers["magic.setRefresh"]({ id, seconds: -1 })).toThrow();
    core.handlers["magic.setRefresh"]({ id, seconds: 60 });
    core.handlers["magic.run"]({ id, prompt: "bigger" });
    await until(() => state().phase === "ready" && state().revision === 2);
    expect(state()).toMatchObject({ refresh: 60, refreshByUser: true });
    await core.close();
  });
});
