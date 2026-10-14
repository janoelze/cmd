// Magic makes widget packages (docs/56, "Magic on V3"): the prompt's examples are packages that
// pass check and their own tests (or builds that end without one); the agent writes only the
// package's own files; a build checks, tests and previews with the toolchain, asks for its
// permissions as a step (Allow writes the grant, Decline fails it with the reason in the agent's
// context), stops at the token ceiling; in the core the window becomes the package's widget, the
// Library lists it as made with Magic, and a hand edit never widens its grant.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppWindow, WidgetEntry } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { readPackage } from "../src/widgets/package.ts";
import { readGrants } from "../src/widgets/grants.ts";
import { buildPackage } from "../src/magic/package/build.ts";
import { listFiles, readMark, writable, writeFile } from "../src/magic/package/files.ts";
import { buildPackageSystem, examples, exampleFiles } from "../src/magic/package/prompt.ts";
import { scriptedBackend, type ScriptTurn } from "../src/magic/package/scripted.ts";
import { slugOf, wantsText } from "../src/magic/package/service.ts";
import { checkoutToolchain, packageJsonToolchain } from "../src/magic/package/toolchain.ts";
import { sandboxAvailable } from "../src/magic/sandbox.ts";
import { fakeFactory } from "./fake-pty.ts";
import { tmp, until } from "./fake-widget-runtime.ts";

const toolchain = checkoutToolchain()!;
// The core's builds sandbox the toolchain; inside another sandbox (an agent's) they can't.
if (!sandboxAvailable()) process.env.CMD_MAGIC_UNSANDBOXED = "1";
const LONG = 120_000;
const run = { sandbox: "off" as const, deny: [] };
const EXAMPLES = examples();
const example = (n: string) => EXAMPLES.find((d) => path.basename(d).endsWith(n))!;

/** write_file calls for an example's files, as the agent would make them (package.json renamed). */
function writes(dir: string, name?: string): ScriptTurn["calls"] {
  return exampleFiles(dir)
    .filter((f) => f !== "ending.json")
    .map((f) => {
      let content = fs.readFileSync(path.join(dir, f), "utf8");
      if (f === "package.json" && name) content = JSON.stringify({ ...JSON.parse(content), name }, null, 2);
      return { name: "write_file", input: { why: `Writing ${f}`, path: f, content } };
    });
}
const tool = (name: string) => ({ name, input: { why: name } });

describe("the prompt's examples", () => {
  it("are the nine requests, and the system prompt has the API reference and each of them", () => {
    expect(EXAMPLES.map((d) => path.basename(d))).toEqual(["1-weather", "2-vpn", "3-processes", "4-timer", "5-terminal", "6-ci", "7-repo", "8-news", "9-radio"]);
    const system = buildPackageSystem();
    expect(system).toContain("# The API: @cmd/widget-api");
    expect(system).toContain("#### `cmd.net`");
    expect(system).toContain("#### `ListRowContent`");
    for (const d of EXAMPLES) expect(system).toContain(fs.readFileSync(path.join(d, "request.md"), "utf8").trim().split("\n")[0]!);
    expect(system).toContain('No package: the build ends with terminal({"why":"Opening top sorted by CPU"');
  });

  for (const dir of EXAMPLES) {
    const name = path.basename(dir);
    if (fs.existsSync(path.join(dir, "ending.json"))) {
      it(`${name} ends with a terminal`, () => {
        const e = JSON.parse(fs.readFileSync(path.join(dir, "ending.json"), "utf8"));
        expect(e.tool).toBe("terminal");
        expect(e.input.command).toBeTruthy();
      });
      continue;
    }
    it(`${name} is a package that passes check and its own tests`, async () => {
      const r = readPackage(dir, { cmdVersion: null });
      expect(r.ok ? [] : r.errors).toEqual([]);
      const check = await toolchain.check(dir, run);
      expect(check.problems).toEqual([]);
      expect(check.types).toBe("checked");
      const test = await toolchain.test(dir, run);
      expect([...test.problems, ...test.failed.map((f) => `${f.name}: ${f.message}`)]).toEqual([]);
      expect(test.passed).toBeGreaterThan(0);
      const trees = await toolchain.trees(dir, run);
      expect(trees.problems).toEqual([]);
      if (r.ok && r.pkg.widgets[0]!.surface === "frame") expect(trees.skipped).toMatch(/frame/);
      else expect(trees.variants.length).toBeGreaterThan(0);
    }, LONG);
  }
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
  const base = (dir: string, turns: ScriptTurn[], extra: Partial<Parameters<typeof buildPackage>[0]> = {}) => ({ prompt: "weather in Lisbon", backend: scriptedBackend({ turns }), dir, name: path.basename(dir), cwd: os.homedir(), sandbox: "off" as const, toolchain, ...extra });

  it("builds a package the agent writes, with check, test and preview, and asks once for its permissions", async () => {
    const dir = path.join(tmp("cmd-magic-home-"), "weather");
    const asked: string[][] = [];
    let granted: string[] | null = null;
    const o = base(dir, [{ calls: [...writes(example("weather"), "weather")!, tool("check"), tool("test"), tool("preview")], answer: "Shows Lisbon's weather." }], {
      ask: async (pkg) => (asked.push(pkg.permissions.net), (granted = pkg.permissions.net), { allow: true }),
      granted: () => (granted ? { net: granted, run: [], read: [], workspace: [], events: [], act: [], ai: [] } : null),
    });
    const r = await buildPackage(o);
    expect(r.verdict.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(asked).toEqual([["geocoding-api.open-meteo.com", "api.open-meteo.com"]]);
    expect(r.verdict.tests).toEqual({ passed: 2, failed: 0 });
    const outputs = (o.backend as ReturnType<typeof scriptedBackend>).outputs;
    expect(outputs.find((x) => x.name === "check")!.output.output).toMatch(/allowed what package\.json asks for/);
    expect(outputs.find((x) => x.name === "preview")!.output.output).toMatch(/<Stat label="Lisbon, PT" value="22°"/);
    expect(r.promptHash).toMatch(/^[0-9a-f]{12}$/);
    const seen = (o.backend as ReturnType<typeof scriptedBackend>).seen[0]!;
    expect(seen.messages[0]!.content).toMatch(/Package folder: .*weather; its name: "weather"/);
    expect(seen.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["write_file", "check", "test", "preview", "terminal", "needs_program"]));
    expect(seen.tools.map((t) => t.name)).not.toContain("run_data");
  });

  it("fails when the person declines, with the reason in the agent's context", async () => {
    const dir = path.join(tmp("cmd-magic-home-"), "weather");
    const backend = scriptedBackend({ turns: [{ calls: [...writes(example("weather"), "weather")!, tool("check")] }] });
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
    const r = await buildPackage(base(dir, [{ calls: [...writes(example("timer"), "pomodoro")!, tool("check"), tool("test")] }], { toolchain: packageJsonToolchain() }));
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

  const timer = () => [{ calls: [...writes(example("timer"), "pomodoro-timer")!, tool("check"), tool("test")], answer: "A pomodoro." }];
  const weather = () => [{ calls: [...writes(example("weather"), "weather-lisbon")!, tool("check"), tool("test")], answer: "Lisbon's weather." }];

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
    const { core, stateDir, w, win, entry } = await setup(weather());
    core.handlers["magic.run"]({ id: w.id, prompt: "weather in Lisbon" });
    await until(() => (win()?.state.pkg as { asking?: boolean } | undefined)?.asking, "the build to ask", 60_000);
    const asking = entry("weather-lisbon");
    expect(asking?.ask).toEqual({ granted: null });
    expect(asking?.permissions?.net).toEqual(["geocoding-api.open-meteo.com", "api.open-meteo.com"]);
    expect(fs.existsSync(path.join(stateDir, "widget-packages", "weather-lisbon", "grants.json"))).toBe(false);
    core.handlers["widget.grant"]({ name: "weather-lisbon" });
    await until(() => win()?.kind === "pkg:weather-lisbon/weather", "the widget", 60_000);
    expect(readGrants(stateDir, "weather-lisbon")?.permissions.net).toEqual(["geocoding-api.open-meteo.com", "api.open-meteo.com"]);

    // A hand edit asking for more never widens the grant: the package waits for the person again.
    const pj = path.join(core.library.packages.home!, "weather-lisbon", "package.json");
    const json = JSON.parse(fs.readFileSync(pj, "utf8"));
    json.cmd.permissions.net.push("evil.example");
    fs.writeFileSync(pj, JSON.stringify(json));
    core.library.packages.scan();
    expect(readGrants(stateDir, "weather-lisbon")?.permissions.net).not.toContain("evil.example");
    expect(core.library.host.granted("weather-lisbon")?.permissions.net).not.toContain("evil.example");
  }, LONG);

  it("fails on Decline, saying why, and leaves no package behind", async () => {
    const { core, home, w, win, backend } = await setup(weather());
    core.handlers["magic.run"]({ id: w.id, prompt: "weather in Lisbon" });
    await until(() => (win()?.state.pkg as { asking?: boolean } | undefined)?.asking, "the build to ask", 60_000);
    core.handlers["widget.ask"]({ name: "weather-lisbon", decline: true });
    await until(() => win()?.state.phase === "error", "the build to fail", 60_000);
    expect(win()!.state.error).toMatch(/declined what package\.json asks for/);
    expect(win()!.kind).toBe("magic");
    expect(backend.outputs.find((x) => x.name === "check")!.output.output).toMatch(/declined/);
    expect(fs.existsSync(path.join(home, "weather-lisbon"))).toBe(false);
  }, LONG);
});

describe("names and words", () => {
  it("names a package from the request, and says what it wants", () => {
    expect(slugOf("how many agents are waiting in this workspace")).toBe("agents-waiting-workspace");
    expect(slugOf("the latest CI runs of this repo")).toBe("ci-runs-repo");
    expect(slugOf("!!!")).toBe("widget");
    expect(wantsText({ net: ["api.github.com"], run: [], read: [], workspace: ["read"], events: [], act: [], ai: [] })).toBe("Wants to reach api.github.com and see this workspace");
  });
});
