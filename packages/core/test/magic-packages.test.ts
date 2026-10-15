// Magic makes widget packages (docs/56, "Magic on V3"): the prompt lists cmd's built-in packages
// and the agent reads them through `builtin` (with exploring off too), only what they ship and
// never out of their folder; the scripted builds here write built-ins' files; the agent writes only the
// package's own files; a build checks, tests and previews with the toolchain, asks for its
// permissions as a step (Allow writes the grant, Decline fails it with the reason in the agent's
// context), stops at the token ceiling; in the core the window becomes the package's widget, the
// Library lists it as made with Magic, and a hand edit never widens its grant.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PREVIEW_SIZES, type AppWindow, type WidgetPermissions, type MagicPreviewRequest, type WidgetEntry } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { readGrants } from "../src/widgets/grants.ts";
import { buildPackage, stepDetail } from "../src/magic/package/build.ts";
import { listFiles, readMark, writable, writeFile } from "../src/magic/package/files.ts";
import { buildPackageSystem } from "../src/magic/package/prompt.ts";
import { builtinRefs, readBuiltin } from "../src/magic/package/builtins.ts";
import { BUILTIN_WIDGETS } from "../src/widgets/packages.ts";
import { scriptedBackend, type ScriptTurn } from "../src/magic/package/scripted.ts";
import { slugOf, wantsText } from "../src/magic/package/service.ts";
import { checkoutToolchain, packageJsonToolchain, type Toolchain } from "../src/magic/package/toolchain.ts";
import type { Previewer } from "../src/magic/previewer.ts";
import { sandboxAvailable } from "../src/lib/sandbox.ts";
import { fakeFactory } from "./fake-pty.ts";
import { tmp, until } from "./fake-widget-runtime.ts";

const toolchain = checkoutToolchain()!;
// The core's builds sandbox the toolchain; inside another sandbox (an agent's) they can't.
if (!sandboxAvailable()) process.env.CMD_MAGIC_UNSANDBOXED = "1";
const LONG = 120_000;
/** A built-in package's folder (packages/widgets), whose files the scripted agent writes. */
const builtin = (n: string) => path.join(BUILTIN_WIDGETS, n);

/** A package's files an agent may write (relative), package.json first. */
function packageFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...packageFiles(dir, r));
    else if (writable(r).ok) out.push(r);
  }
  return out.sort((a, b) => Number(b === "package.json") - Number(a === "package.json") || a.localeCompare(b));
}

/** write_file calls for a package's files, as the agent would make them (package.json renamed). */
function writes(dir: string, name?: string): ScriptTurn["calls"] {
  return packageFiles(dir).map((f) => {
    let content = fs.readFileSync(path.join(dir, f), "utf8");
    if (f === "package.json" && name) content = JSON.stringify({ ...JSON.parse(content), name }, null, 2);
    return { name: "write_file", input: { why: `Writing ${f}`, path: f, content } };
  });
}
const tool = (name: string) => ({ name, input: { why: name } });

describe("the built-in packages as references", () => {
  const refs = builtinRefs(BUILTIN_WIDGETS);

  it("are listed in the system prompt with id and description, and no source code", () => {
    expect(refs.map((r) => r.id)).toEqual(expect.arrayContaining(["agents", "journal", "timer"]));
    const system = buildPackageSystem(undefined, BUILTIN_WIDGETS);
    expect(system).toContain("# The API: @cmd/widget-api");
    expect(system).toContain("#### `cmd.net`");
    expect(system).toContain("#### `ListRowContent`");
    expect(system).toContain("# Built-in widgets");
    for (const r of refs) {
      expect(system).toContain(`- \`${r.id}\`: ${r.description}`);
      for (const w of r.widgets) expect(system).toContain(w.title);
      const main = fs.readFileSync(path.join(BUILTIN_WIDGETS, r.id, "src", `${r.widgets[0]!.id}.tsx`), "utf8");
      const code = main.split("\n").map((l) => l.trim()).filter((l) => l.length >= 50);
      expect(code.length).toBeGreaterThan(10);
      expect(code.filter((l) => system.includes(l)), r.id).toEqual([]);
    }
    expect(system).not.toContain("<example>");
    expect(buildPackageSystem(undefined, null)).toContain("no built-in packages");
  });

  it("are listed as they are on disk: a package added to the folder is in the prompt", () => {
    const root = tmp("cmd-builtins-");
    fs.mkdirSync(path.join(root, "clock"));
    fs.writeFileSync(path.join(root, "clock", "package.json"), JSON.stringify({ name: "clock", description: "The time in a few cities.", cmd: { api: 1, widgets: [{ id: "clock", title: "World Clock" }] } }));
    fs.mkdirSync(path.join(root, "not-a-package"));
    fs.writeFileSync(path.join(root, ".DS_Store"), "");
    expect(builtinRefs(root)).toEqual([{ id: "clock", description: "The time in a few cities.", widgets: [{ id: "clock", title: "World Clock", description: "" }] }]);
    expect(buildPackageSystem(undefined, root)).toContain("- `clock`: The time in a few cities. (World Clock)");
  });

  it("open as their files, package.json and README; a file as its text", () => {
    const listed = readBuiltin("timer", undefined, BUILTIN_WIDGETS);
    expect(listed).toMatch(/^timer's files: LICENSE, README\.md, package\.json, src\/timer\.tsx/);
    expect(listed).toContain('--- package.json ---\n{');
    expect(listed).toContain("--- README.md ---");
    expect(readBuiltin("timer", "src/timer.tsx", BUILTIN_WIDGETS)).toBe(fs.readFileSync(builtin("timer") + "/src/timer.tsx", "utf8"));
    expect(readBuiltin("timer", "./src/timer.tsx", BUILTIN_WIDGETS)).toContain("export default");
  });

  it("refuse an unknown id, a path out of the folder, and what the package doesn't ship", () => {
    const no = (id: string, file?: string) => () => readBuiltin(id, file, BUILTIN_WIDGETS);
    expect(no("weather")).toThrow(/no built-in package "weather" \(there are: .*timer/);
    for (const id of ["../widgets/timer", "..", "/etc", "timer/..", ".bin", "Timer"]) expect(no(id), id).toThrow(/no built-in package/);
    for (const f of ["../agents/src/activity.tsx", "../../core/package.json", "/etc/passwd", path.join(builtin("timer"), "src/timer.tsx"), "src/../../agents/package.json"]) expect(no("timer", f), f).toThrow(/doesn't ship/);
    for (const f of ["src/timer.test.tsx", "src/timer.story.tsx", "tsconfig.json", "node_modules/react/package.json", ".cmd-preview/x"]) expect(no("timer", f), f).toThrow(/doesn't ship/);
    expect(() => readBuiltin("timer", undefined, null)).toThrow(/no built-in package/);
  });

  it("never read tests, node_modules, dot-folders or a link out of the package, even when files lists them", () => {
    const root = tmp("cmd-builtins-");
    const outside = tmp("cmd-builtins-outside-");
    fs.writeFileSync(path.join(outside, "secret.ts"), "secret");
    const dir = path.join(root, "x");
    fs.mkdirSync(path.join(dir, "src", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(dir, "src", ".cache"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", files: ["src"], cmd: { api: 1, widgets: [{ id: "x", title: "X", main: "src/x.tsx" }] } }));
    fs.writeFileSync(path.join(dir, "src", "x.tsx"), "export default 1;");
    fs.writeFileSync(path.join(dir, "src", "x.test.tsx"), "test");
    fs.writeFileSync(path.join(dir, "src", "node_modules", "m.ts"), "m");
    fs.writeFileSync(path.join(dir, "src", ".cache", "c.ts"), "c");
    fs.symlinkSync(path.join(outside, "secret.ts"), path.join(dir, "src", "link.ts"));
    expect(readBuiltin("x", undefined, root)).toMatch(/^x's files: package\.json, src\/link\.ts, src\/x\.tsx\n/);
    for (const f of ["src/x.test.tsx", "src/node_modules/m.ts", "src/.cache/c.ts"]) expect(() => readBuiltin("x", f, root), f).toThrow(/doesn't ship/);
    expect(() => readBuiltin("x", "src/link.ts", root)).toThrow(/isn't a file inside x/);
  });

  it("are read through the agent's builtin tool, with exploring off", async () => {
    const dir = path.join(tmp("cmd-magic-home-"), "t");
    const backend = scriptedBackend({
      turns: [
        {
          calls: [
            { name: "builtin", input: { why: "Reading the Countdown widget", id: "timer" } },
            { name: "builtin", input: { why: "Reading its source", id: "timer", file: "src/timer.tsx" } },
            { name: "builtin", input: { why: "x", id: "nope" } },
            { name: "builtin", input: { why: "x", id: "timer", file: "../agents/package.json" } },
          ],
        },
      ],
    });
    const steps: string[] = [];
    await buildPackage({ prompt: "a pomodoro timer", backend, dir, name: "t", cwd: os.homedir(), sandbox: "off", toolchain, explore: false, maxRepairs: 0, builtins: BUILTIN_WIDGETS, onEvent: (e) => e.type === "step-start" && steps.push(stepDetail(e.tool, e.input)) });
    const names = backend.seen[0]!.tools.map((t) => t.name);
    expect(names).toContain("builtin");
    expect(names).not.toContain("read");
    expect(backend.seen[0]!.messages[0]!.content).toMatch(/Looking around this Mac is off/);
    const out = backend.outputs.map((o) => [o.name, o.output.isError, o.output.output.split("\n")[0]]);
    expect(out.slice(0, 4)).toEqual([
      ["builtin", false, expect.stringMatching(/^timer's files: /)],
      ["builtin", false, expect.any(String)],
      ["builtin", true, expect.stringMatching(/^no built-in package "nope"/)],
      ["builtin", true, expect.stringMatching(/doesn't ship \.\.\/agents\/package\.json/)],
    ]);
    expect(backend.outputs[1]!.output.output).toBe(fs.readFileSync(path.join(builtin("timer"), "src/timer.tsx"), "utf8"));
    expect(steps.slice(0, 2)).toEqual(["timer", "timer/src/timer.tsx"]);
  });
});

describe("a package's files", () => {
  it("are package.json, README.md, view.html, src/** and fixtures/*.json, nothing else", () => {
    for (const ok of ["package.json", "README.md", "view.html", "src/ci.tsx", "src/lib/parse.ts", "fixtures/busy.json", "./src/x.test.tsx"]) expect(writable(ok).ok, ok).toBe(true);
    for (const no of ["grants.json", "../grants.json", "/etc/passwd", "src/../../x.ts", "node_modules/react/index.js", "src/node_modules/x.ts", ".env", "fixtures/a/b.json", "tsconfig.json", "src/x.sh", "deno.json"]) expect(writable(no).ok, no).toBe(false);
  });

  it("never leave the folder through a link, and keep cmd's mark in package.json", () => {
    const dir = tmp("cmd-magic-files-");
    const outside = tmp("cmd-magic-outside-");
    fs.symlinkSync(outside, path.join(dir, "src"));
    expect(() => writeFile(dir, "src/x.tsx", "x")).toThrow(/out of the package/);
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.rmSync(path.join(dir, "src"));
    const mark = { request: "ci status", madeAt: "2026-10-14T10:00:00.000Z", revisions: 2 };
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", cmd: { api: 1, magic: mark } }));
    writeFile(dir, "package.json", JSON.stringify({ name: "x", cmd: { api: 1, widgets: [], magic: { request: "forged", madeAt: "1999", revisions: 99 } } }));
    expect(readMark(dir)).toEqual(mark);
  });
});

describe("buildPackage", () => {
  const base = (dir: string, turns: ScriptTurn[], extra: Partial<Parameters<typeof buildPackage>[0]> = {}) => ({ prompt: "what I did this week", backend: scriptedBackend({ turns }), dir, name: path.basename(dir), cwd: os.homedir(), sandbox: "off" as const, toolchain, ...extra });

  it("builds a package the agent writes, with check, test and preview, and asks once for its permissions", async () => {
    const dir = path.join(tmp("cmd-magic-home-"), "work-log");
    const asked: WidgetPermissions[] = [];
    let granted: WidgetPermissions | null = null;
    const o = base(dir, [{ calls: [...writes(builtin("journal"), "work-log")!, tool("check"), tool("test"), tool("preview")], answer: "Shows this week's work." }], {
      ask: async (pkg) => (asked.push(pkg.permissions), (granted = pkg.permissions), { allow: true }),
      granted: () => granted,
    });
    const r = await buildPackage(o);
    expect(r.verdict.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(asked.map((p) => [p.workspace, p.events])).toEqual([[["read"], ["agents"]]]);
    expect(r.verdict.tests).toMatchObject({ failed: 0 });
    expect(r.verdict.tests!.passed).toBeGreaterThan(2);
    const outputs = (o.backend as ReturnType<typeof scriptedBackend>).outputs;
    expect(outputs.find((x) => x.name === "check")!.output.output).toMatch(/allowed what package\.json asks for/);
    expect(outputs.find((x) => x.name === "preview")!.output.output).toMatch(/--- journal · Empty ---/);
    expect(r.promptHash).toMatch(/^[0-9a-f]{12}$/);
    const seen = (o.backend as ReturnType<typeof scriptedBackend>).seen[0]!;
    expect(seen.messages[0]!.content).toMatch(/Package folder: .*work-log; its name: "work-log"/);
    expect(seen.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["write_file", "check", "test", "preview", "terminal", "needs_program", "builtin"]));
    expect(seen.tools.map((t) => t.name)).not.toContain("run_data");
  });

  it("checks, tests and draws once per state of the files: cmd's verify reuses what the agent ran, and draws through drawTrees", async () => {
    const dir = path.join(tmp("cmd-magic-home-"), "work-log");
    const runs = { check: 0, test: 0, trees: 0 };
    const counting: Toolchain = {
      name: "counting",
      check: (d, o) => (runs.check++, toolchain.check(d, o)),
      test: (d, o) => (runs.test++, toolchain.test(d, o)),
      trees: (d, o) => (runs.trees++, toolchain.trees(d, o)),
    };
    const batches: MagicPreviewRequest[][] = [];
    // The first draw overflows: the judge says so.
    const previewer: Previewer = { name: "fake", render: async (rs) => (batches.push(rs), rs.map((r, i) => ({ errors: [], text: 40, nodes: 20, drawn: false, scrollW: i === 0 ? 2000 : r.width, scrollH: r.height, png: "AA==" }))) };
    const readme = { name: "write_file", input: { why: "README", path: "README.md", content: "# Work Log\n" } };
    const r = await buildPackage(base(dir, [{ calls: [...writes(builtin("journal"), "work-log")!, tool("check"), tool("test"), tool("preview"), readme, tool("check")], answer: "Done." }], { toolchain: counting, previewer: async () => previewer }));
    // check ran on the last files and verify reused it; test and trees ran again on the README's change, once each.
    expect(runs).toEqual({ check: 2, test: 2, trees: 2 });
    expect(batches).toHaveLength(2);
    expect(batches[0]!.slice(0, 2).map((x) => [x.width, x.height, x.tree.theme])).toEqual([[...PREVIEW_SIZES.narrow, "dark"], [...PREVIEW_SIZES.wide, "light"]]);
    expect(r.verdict.warnings).toContain(`Week, narrow (${PREVIEW_SIZES.narrow.join("×")}), dark: content is 2000px wide in a ${PREVIEW_SIZES.narrow[0]}px window`);
    expect(r.verdict.shot).toBe("AA==");
  });

  it("fails when the person declines, with the reason in the agent's context", async () => {
    const dir = path.join(tmp("cmd-magic-home-"), "work-log");
    const backend = scriptedBackend({ turns: [{ calls: [...writes(builtin("journal"), "work-log")!, tool("check")] }] });
    const r = await buildPackage({ ...base(dir, []), backend, ask: async () => ({ allow: false }), granted: () => null });
    expect(r.ok).toBe(false);
    expect(r.verdict.usable).toBe(false);
    expect(r.verdict.problems[0]).toMatch(/declined what package\.json asks for/);
    expect(backend.outputs.find((x) => x.name === "check")!.output.output).toMatch(/The person declined what package\.json asks for\. Ask for less/);
    expect(backend.seen[1]!.messages.at(-1)!.content).toMatch(/declined/);
  });

  it("refuses to write outside the package, grants.json least of all", async () => {
    const dir = path.join(tmp("cmd-magic-home-"), "x");
    const backend = scriptedBackend({ turns: [{ calls: [{ name: "write_file", input: { why: "x", path: "../grants.json", content: "{}" } }, { name: "write_file", input: { why: "x", path: "grants.json", content: "{}" } }] }] });
    await buildPackage({ ...base(dir, []), backend, maxRepairs: 0 });
    expect(backend.outputs.map((o) => o.output.isError)).toEqual([true, true]);
    expect(fs.existsSync(path.join(path.dirname(dir), "grants.json")) || fs.existsSync(path.join(dir, "grants.json"))).toBe(false);
  });

  it("ends with a terminal, or with the program a request needs", async () => {
    const t = await buildPackage(base(path.join(tmp("cmd-magic-home-"), "t"), [{ calls: [{ name: "terminal", input: { why: "top", command: "top -o cpu", title: "Top processes" } }] }]));
    expect(t.ending).toEqual({ kind: "terminal", command: "top -o cpu", title: "Top processes" });
    expect(t.ok).toBe(true);
    const n = await buildPackage(base(path.join(tmp("cmd-magic-home-"), "n"), [{ calls: [{ name: "needs_program", input: { why: "battery", programs: ["pmset"], reason: "The battery's charge comes from pmset." } }] }]));
    expect(n.ending).toMatchObject({ kind: "needs-program", programs: ["pmset"] });
    expect(n.ok).toBe(false);
    expect(n.verdict.problems).toEqual(["The battery's charge comes from pmset."]);
  });

  it("checks package.json alone in a cmd without the toolchain, and says the rest was skipped", async () => {
    const dir = path.join(tmp("cmd-magic-home-"), "pomodoro");
    const r = await buildPackage(base(dir, [{ calls: [...writes(builtin("timer"), "pomodoro")!, tool("check"), tool("test")] }], { toolchain: packageJsonToolchain() }));
    expect(r.ok).toBe(true);
    expect(r.verdict.warnings.join("\n")).toMatch(/tests not run: this cmd has no TypeScript and Vitest/);
    const outputs = (r.trace as { tool: string; output: string }[]).map((t) => `${t.tool}: ${t.output}`);
    expect(outputs).toContainEqual(expect.stringMatching(/^check: OK: package\.json is valid \(types not checked/));
  });

  it("stops at the token ceiling, with a backend that never stops", async () => {
    const dir = path.join(tmp("cmd-magic-home-"), "x");
    const t0 = Date.now();
    const r = await buildPackage({ ...base(dir, []), backend: scriptedBackend({ forever: true, usage: 10_000 }), maxTokens: 50_000 });
    expect(r.ok).toBe(false);
    expect(r.stopped).toBe("It stopped at 50,000 tokens, the limit for one build (Settings → Magic Widgets).");
    expect(r.verdict.problems[0]).toBe(r.stopped);
    expect(r.trace.length).toBeLessThanOrEqual(7);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("Magic makes packages in the core", () => {
  const cores: Core[] = [];
  afterEach(async () => {
    for (const c of cores.splice(0)) await c.close();
  });

  async function setup(turns: ScriptTurn[]) {
    const home = tmp("cmd-widgets-home-");
    const stateDir = tmp("cmd-state-");
    process.env.CMD_WIDGETS_HOME = home;
    const backend = scriptedBackend({ turns });
    const core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, stateDir, magicBackend: () => backend, magicPreviewer: null });
    delete process.env.CMD_WIDGETS_HOME;
    cores.push(core);
    core.library.host.configure({ runtime: null });
    core.start();
    await core.scheduler.idle();
    const w = (await core.handlers["window.open"]({ kind: "magic", workspaceId: core.workspaces.home().id })) as AppWindow;
    const win = () => core.windows.others().find((x) => x.id === w.id);
    const entry = (name: string) => (core.handlers["widget.list"]({}) as WidgetEntry[]).find((e) => e.name === name);
    return { core, home, stateDir, backend, w, win, entry };
  }

  const timer = () => [{ calls: [...writes(builtin("timer"), "pomodoro-timer")!, tool("check"), tool("test")], answer: "A pomodoro." }];
  const workLog = () => [{ calls: [...writes(builtin("journal"), "work-log")!, tool("check"), tool("test")], answer: "This week's work." }];

  it("makes a package in the packages folder, and the window becomes its widget, listed as made with Magic", async () => {
    const { core, home, stateDir, w, win, entry } = await setup(timer());
    core.handlers["magic.run"]({ id: w.id, prompt: "pomodoro timer" });
    await until(() => win()?.kind === "pkg:pomodoro-timer/timer", "the window to become the package's widget", 60_000);
    expect(win()!.state).toMatchObject({ package: "pomodoro-timer", widget: "timer" });
    const dir = path.join(home, "pomodoro-timer");
    expect(listFiles(dir)).toEqual(expect.arrayContaining(["package.json", "src/timer.tsx", "src/timer.test.tsx", "src/timer.story.tsx"]));
    expect(readMark(dir)).toMatchObject({ request: "pomodoro timer", revisions: 1 });
    expect(fs.existsSync(path.join(stateDir, "widget-packages", "pomodoro-timer", "revisions", "0001", "files", "src", "timer.tsx"))).toBe(true);
    expect(entry("pomodoro-timer")).toMatchObject({ source: "package", magic: { request: "pomodoro timer" }, request: "pomodoro timer" });
  }, LONG);

  it("pauses on the permissions step until Allow, then the grant file exists", async () => {
    const { core, stateDir, w, win, entry } = await setup(workLog());
    core.handlers["magic.run"]({ id: w.id, prompt: "work log" });
    await until(() => (win()?.state.pkg as { asking?: boolean } | undefined)?.asking, "the build to ask", 60_000);
    const asking = entry("work-log");
    expect(asking?.ask).toEqual({ granted: null });
    expect(asking?.permissions).toMatchObject({ workspace: ["read"], events: ["agents"] });
    expect(fs.existsSync(path.join(stateDir, "widget-packages", "work-log", "grants.json"))).toBe(false);
    core.handlers["widget.grant"]({ name: "work-log" });
    await until(() => win()?.kind === "pkg:work-log/journal", "the widget", 60_000);
    expect(readGrants(stateDir, "work-log")?.permissions).toMatchObject({ workspace: ["read"], events: ["agents"], net: [] });

    // A hand edit asking for more never widens the grant: the package waits for the person again.
    const pj = path.join(core.library.packages.home!, "work-log", "package.json");
    const json = JSON.parse(fs.readFileSync(pj, "utf8"));
    json.cmd.permissions.net = ["evil.example"];
    fs.writeFileSync(pj, JSON.stringify(json));
    core.library.packages.scan();
    expect(readGrants(stateDir, "work-log")?.permissions.net).not.toContain("evil.example");
    expect(core.library.host.granted("work-log")?.permissions.net).not.toContain("evil.example");
  }, LONG);

  it("fails on Decline, saying why, and leaves no package behind", async () => {
    const { core, home, w, win, backend } = await setup(workLog());
    core.handlers["magic.run"]({ id: w.id, prompt: "work log" });
    await until(() => (win()?.state.pkg as { asking?: boolean } | undefined)?.asking, "the build to ask", 60_000);
    core.handlers["widget.ask"]({ name: "work-log", decline: true });
    await until(() => win()?.state.phase === "error", "the build to fail", 60_000);
    expect(win()!.state.error).toMatch(/declined what package\.json asks for/);
    expect(win()!.kind).toBe("magic");
    expect(backend.outputs.find((x) => x.name === "check")!.output.output).toMatch(/declined/);
    expect(fs.existsSync(path.join(home, "work-log"))).toBe(false);
  }, LONG);
});

describe("names and words", () => {
  it("names a package from the request, and says what it wants", () => {
    expect(slugOf("how many agents are waiting in this workspace")).toBe("agents-waiting-workspace");
    expect(slugOf("the latest CI runs of this repo")).toBe("ci-runs-repo");
    expect(slugOf("!!!")).toBe("widget");
    expect(wantsText({ net: ["api.github.com"], run: [], read: [], workspace: ["read"], events: [], act: [], ai: [], media: [] })).toBe("Wants to reach api.github.com and see this workspace");
  });
});
