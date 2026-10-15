// Widget packages (docs/56): package.json validated and refused with the field named
// (widgets/package.ts), grants kept outside the package (widgets/grants.ts) and out of
// Magic's reach, and packages in $CMD_WIDGETS_HOME listed in the Widget Library as
// window types, live as the folder changes, never written to.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { noPermissions, type WidgetEntry, type WidgetPermissions } from "@cmd/protocol";
import { parsePackage, readPackage, enginesMin, compareVersions } from "../src/widgets/package.ts";
import { effective, grantsPath, needsGrant, readGrants, writeGrants } from "../src/widgets/grants.ts";
import { BUILTIN_WIDGETS, WidgetPackages } from "../src/widgets/packages.ts";
import type { WindowTypes } from "../src/windows/types.ts";
import { FakeWidgetRuntime, until, writePackage } from "./fake-widget-runtime.ts";
import { rmTemp } from "./tmp.ts";
import { SYSTEM_TIMEOUT } from "../../../test/system.ts";

const temps: string[] = [];
const tmp = (p = "cmd-pkg-") => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  temps.push(d);
  return d;
};
afterAll(() => temps.forEach(rmTemp));

const PKG = (o: Record<string, unknown> = {}, c: Record<string, unknown> = {}) => ({
  name: "ci-runs",
  version: "1.2.0",
  description: "The latest runs.",
  engines: { cmd: ">=0.30" },
  cmd: { api: 1, widgets: [{ id: "ci", title: "CI", icon: "checkmark.seal", main: "src/ci.tsx", size: "m", config: [{ key: "token", title: "Token", type: "string", secret: true, host: "api.github.com" }] }], ...c, permissions: { net: ["api.github.com"], run: ["gh"], workspace: ["read"], events: ["agents"], act: ["actions.run"], ...(c.permissions as object) } },
  ...o,
});

/** A package folder with src/ci.tsx (and package.json, unless `json` is null). */
function pkgDir(json: unknown = PKG(), root = tmp(), folder = "ci-runs"): string {
  const dir = path.join(root, folder);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "ci.tsx"), "export default function CI() { return null; }\n");
  if (json !== null) fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(json, null, 2));
  return dir;
}

const errors = (json: unknown, dir = pkgDir(null), cmdVersion: string | null = "0.30.0") => {
  const r = parsePackage(json, dir, { cmdVersion });
  return r.ok ? [] : r.errors;
};

describe("package.json", () => {
  it("reads a valid package", () => {
    const dir = pkgDir();
    const r = readPackage(dir, { cmdVersion: "0.30.0" });
    expect(r).toEqual({
      ok: true,
      pkg: {
        name: "ci-runs",
        version: "1.2.0",
        description: "The latest runs.",
        engines: ">=0.30",
        api: 1,
        dir,
        experimental: [],
        permissions: { net: ["api.github.com"], run: ["gh"], read: [], workspace: ["read"], events: ["agents"], act: ["actions.run"], ai: [], media: [] },
        widgets: [{ id: "ci", kind: "pkg:ci-runs/ci", title: "CI", icon: "checkmark.seal", main: "src/ci.tsx", size: "m", surface: "tree", config: [{ key: "token", title: "Token", type: "string", secret: true, host: "api.github.com" }] }],
      },
    });
  });

  it("refuses a missing cmd.api", () => {
    const c = PKG();
    delete (c.cmd as Record<string, unknown>).api;
    expect(errors(c)).toEqual([expect.stringMatching(/^cmd\.api: missing/)]);
  });

  it("refuses an API major this cmd doesn't run", () => {
    expect(errors(PKG({}, { api: 2 }))).toEqual([expect.stringMatching(/^cmd\.api: 2 isn't a widget API this cmd runs \(1\)/)]);
    expect(errors(PKG({}, { api: 0 }))).toEqual([expect.stringMatching(/^cmd\.api: 0 /)]);
  });

  it("refuses engines.cmd newer than the running cmd", () => {
    expect(errors(PKG({ engines: { cmd: ">=0.33" } }))).toEqual(["engines.cmd: needs cmd 0.33 or newer; this is 0.30.0"]);
    expect(errors(PKG({ engines: { cmd: "^0.29.1" } }))).toEqual([]);
    expect(errors(PKG({ engines: { cmd: "< 2 || > 4" } }))).toEqual([expect.stringMatching(/^engines\.cmd: /)]);
    // A cmd that can't tell its version doesn't refuse on it.
    expect(errors(PKG({ engines: { cmd: ">=9" } }), undefined, null)).toEqual([]);
    expect(enginesMin(">= 0.32")).toBe("0.32");
    expect(compareVersions("0.32", "0.32.0")).toBe(0);
    expect(compareVersions("0.4.0", "0.32.0")).toBeLessThan(0);
  });

  it("refuses a main outside the package, also through .. or a link", () => {
    const at = (main: string, dir?: string) => errors(PKG({}, { widgets: [{ id: "ci", title: "CI", main }] }), dir);
    expect(at("../ci.tsx")).toEqual([expect.stringMatching(/^cmd\.widgets\[0\]\.main: "\.\.\/ci\.tsx" is outside the package/)]);
    expect(at("src/../../x.tsx")).toEqual([expect.stringMatching(/^cmd\.widgets\[0\]\.main: .* is outside the package/)]);
    expect(at("/etc/passwd")).toEqual([expect.stringMatching(/^cmd\.widgets\[0\]\.main: /)]);
    expect(at("src/nope.tsx")).toEqual([expect.stringMatching(/^cmd\.widgets\[0\]\.main: "src\/nope\.tsx" doesn't exist/)]);
    const dir = pkgDir(null);
    const outside = path.join(tmp(), "evil.tsx");
    fs.writeFileSync(outside, "export default 1;\n");
    fs.symlinkSync(outside, path.join(dir, "src", "linked.tsx"));
    expect(at("src/linked.tsx", dir)).toEqual([expect.stringMatching(/^cmd\.widgets\[0\]\.main: "src\/linked\.tsx" links outside the package/)]);
    // A linked folder inside the package is fine: it's the package's.
    fs.symlinkSync(path.join(dir, "src"), path.join(dir, "lib"));
    expect(at("lib/ci.tsx", dir)).toEqual([]);
  });

  it("refuses a shell or interpreter in run (ESCAPES, shared with Magic's manifest)", () => {
    for (const p of ["bash", "/bin/zsh", "node", "python3", "osascript", "env"]) expect(errors(PKG({}, { permissions: { run: ["gh", p] } }))).toEqual([expect.stringMatching(new RegExp(`^cmd\\.permissions\\.run: "${p.replaceAll("/", "\\/")}" would let the widget run anything`))]);
    expect(errors(PKG({}, { permissions: { run: ["gh --x"] } }))).toEqual([expect.stringMatching(/^cmd\.permissions\.run: "gh --x" isn't a program name/)]);
  });

  it("refuses reading the whole home folder, or more", () => {
    const home = os.homedir();
    for (const r of ["~", "~/", home, "/", path.dirname(home)]) expect(errors(PKG({}, { permissions: { read: [r] } })), r).toEqual([expect.stringMatching(/^cmd\.permissions\.read: .* (whole home folder|more than your home folder)/)]);
    expect(errors(PKG({}, { permissions: { read: ["~/.ssh"] } }))).toEqual([expect.stringMatching(/^cmd\.permissions\.read: "~\/\.ssh" is private/)]);
    expect(errors(PKG({}, { permissions: { read: ["notes"] } }))).toEqual([expect.stringMatching(/^cmd\.permissions\.read: "notes" should be a full path/)]);
    expect(errors(PKG({}, { permissions: { read: ["~/Notes"] } }))).toEqual([]);
  });

  it("refuses a version that isn't semver", () => {
    expect(errors(PKG({ version: "1.2" }))).toEqual(['version: "1.2" isn\'t a version like "1.0.0"']);
    expect(errors(PKG({ version: undefined }))).toEqual([expect.stringMatching(/^version: missing/)]);
    expect(errors(PKG({ version: "1.0.0-beta.1+abc" }))).toEqual([]);
  });

  it("refuses two widgets with one id", () => {
    const w = { id: "ci", title: "CI", main: "src/ci.tsx" };
    expect(errors(PKG({}, { widgets: [w, { ...w }] }))).toEqual(['cmd.widgets[1].id: "ci" is used twice; each widget needs its own id']);
  });

  describe("secrets name the host they're sent to", () => {
    /** Problems with the widget's config `fields` (net: api.github.com). */
    const cfg = (...fields: Record<string, unknown>[]) => errors(PKG({}, { widgets: [{ id: "ci", title: "CI", main: "src/ci.tsx", config: [{ key: "repo", title: "Repo", type: "string" }, ...fields] }] }));
    const tok = (o: Record<string, unknown> = {}) => ({ key: "token", title: "Token", type: "string", secret: true, ...o });

    it("reads a bound secret, with its header and scheme", () => {
      const r = parsePackage(PKG({}, { widgets: [{ id: "ci", title: "CI", main: "src/ci.tsx", config: [tok({ host: "api.github.com", header: "X-Api-Key", scheme: "" })] }] }), pkgDir(null), { cmdVersion: null });
      expect(r.ok && r.pkg.widgets[0]!.config).toEqual([{ key: "token", title: "Token", type: "string", secret: true, host: "api.github.com", header: "X-Api-Key", scheme: "" }]);
      expect(cfg(tok({ host: "api.github.com", scheme: "token" }))).toEqual([]);
    });
    it("refuses a secret without a host", () => expect(cfg(tok())).toEqual([expect.stringMatching(/^cmd\.widgets\[0\]\.config\[1\]\.host: missing/)]));
    it("refuses a host not in cmd.permissions.net", () => expect(cfg(tok({ host: "evil.example" }))).toEqual(['cmd.widgets[0].config[1].host: "evil.example" isn\'t in cmd.permissions.net; add it there too']));
    it("refuses a * host", () => {
      expect(errors(PKG({}, { permissions: { net: ["*"] }, widgets: [{ id: "ci", title: "CI", main: "src/ci.tsx", config: [tok({ host: "*" })] }] }))).toEqual([expect.stringMatching(/^cmd\.widgets\[0\]\.config\[0\]\.host: "\*" would send the secret anywhere/)]);
    });
    it("refuses a header that isn't a header name", () => expect(cfg(tok({ host: "api.github.com", header: "Bad Header:" }))).toEqual([expect.stringMatching(/^cmd\.widgets\[0\]\.config\[1\]\.header: /)]));
    it("refuses host, header or scheme on a field that isn't secret", () => {
      for (const k of ["host", "header", "scheme"]) expect(cfg({ key: "repo2", title: "Repo", type: "string", [k]: k === "host" ? "api.github.com" : "X" }), k).toEqual([expect.stringMatching(new RegExp(`^cmd\\.widgets\\[0\\]\\.config\\[1\\]\\.${k}: only a secret field`))]);
    });
  });

  it("asks for cmd's AI only as complete", () => {
    expect(errors(PKG({}, { permissions: { net: ["api.github.com"], ai: ["complete"] } }))).toEqual([]);
    expect(errors(PKG({}, { permissions: { net: ["api.github.com"], ai: ["complete", "chat"] } }))).toEqual(['cmd.permissions.ai: "chat" isn\'t something widgets may ask of cmd\'s AI (complete)']);
    expect(errors(PKG({}, { permissions: { media: ["read", "control", "volume"] } }))).toEqual(['cmd.permissions.media: "volume" should be "read" (see what\'s playing) or "control" (play, pause, skip)']);
  });

  it("names the field of every other problem", () => {
    expect(errors(PKG({ name: "CI Runs" }))).toEqual([expect.stringMatching(/^name: /)]);
    expect(errors(PKG({}, { permissions: { net: ["api.github.com", "https://x y"] } }))).toEqual([expect.stringMatching(/^cmd\.permissions\.net: /)]);
    expect(errors(PKG({}, { permissions: { env: ["TOKEN"] } }))).toEqual([expect.stringMatching(/^cmd\.permissions\.env: isn't a permission.*secret/)]);
    expect(errors(PKG({}, { permissions: { events: ["transcripts", "nope"] } }))).toEqual([expect.stringMatching(/^cmd\.permissions\.events: "nope"/)]);
    expect(errors(PKG({}, { permissions: { workspace: ["write"] } }))).toEqual([expect.stringMatching(/^cmd\.permissions\.workspace: /)]);
    expect(errors(PKG({}, { permissions: { act: ["files.write"] } }))).toEqual([expect.stringMatching(/^cmd\.permissions\.act: /)]);
    expect(errors(PKG({}, { widgets: [{ id: "ci", title: "CI", main: "src/ci.tsx", size: "xl", surface: "html", icon: "Bad Icon" }] }))).toEqual([expect.stringMatching(/^cmd\.widgets\[0\]\.icon: /), expect.stringMatching(/^cmd\.widgets\[0\]\.surface: /), expect.stringMatching(/^cmd\.widgets\[0\]\.size: /)]);
    expect(errors(PKG({}, { widgets: [] }))).toEqual([expect.stringMatching(/^cmd\.widgets: /)]);
    expect(errors(PKG({ cmd: undefined }))).toEqual([expect.stringMatching(/^cmd: missing/)]);
    expect(errors(PKG({}, { experimental: ["pages"], widgets: [{ id: "viz", title: "Viz", main: "src/ci.tsx", surface: "frame" }] }))).toEqual([]);
  });
});

describe("grants", () => {
  const perms = (o: Partial<WidgetPermissions>): WidgetPermissions => ({ ...noPermissions(), ...o });
  const declared = perms({ net: ["api.github.com", "example.com"], run: ["gh"], act: ["actions.run"] });

  it("are declared ∩ granted", () => {
    expect(effective(declared, perms({ net: ["api.github.com", "other.org"], run: ["gh", "git"] }))).toEqual(perms({ net: ["api.github.com"], run: ["gh"] }));
    expect(effective(declared, null)).toEqual(noPermissions());
  });

  it("need asking when the package declares more, not the same or less", () => {
    expect(needsGrant(declared, perms({ net: ["api.github.com"], run: ["gh"], act: ["actions.run"] }))).toBe(true);
    expect(needsGrant(declared, perms({ net: ["api.github.com", "example.com"], run: ["gh"] }))).toBe(true); // any act
    expect(needsGrant(declared, declared)).toBe(false);
    expect(needsGrant(perms({ net: ["api.github.com"] }), declared)).toBe(false);
    expect(needsGrant(noPermissions(), null)).toBe(false);
    expect(needsGrant(declared, null)).toBe(true);
    expect(needsGrant({ ...declared, ai: ["complete"] }, declared)).toBe(true); // cmd's AI, newly asked for
  });

  it("live per instance, outside the package, and round-trip", () => {
    const state = tmp("cmd-state-");
    expect(readGrants(state, "ci-runs")).toBeNull();
    writeGrants(state, "ci-runs", { version: "1.2.0", permissions: declared });
    expect(grantsPath(state, "ci-runs")).toBe(path.join(state, "widget-packages", "ci-runs", "grants.json"));
    expect(readGrants(state, "ci-runs")).toEqual({ version: "1.2.0", permissions: declared });
  });

});

describe("packages in the Widget Library", () => {
  const until = async (cond: () => boolean, what: string, ms = SYSTEM_TIMEOUT) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  /** Every file and folder under `dir` with its mtime, links not followed. */
  const snapshot = (dir: string): Record<string, number> => {
    const out: Record<string, number> = {};
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        out[path.relative(dir, p)] = fs.lstatSync(p).mtimeMs;
        if (e.isDirectory()) walk(p);
      }
    };
    out["."] = fs.statSync(dir).mtimeMs;
    walk(dir);
    return out;
  };

  async function setup() {
    const home = tmp("cmd-widgets-home-");
    pkgDir(PKG(), home);
    process.env.CMD_WIDGETS_HOME = home;
    const { Core } = await import("../src/kernel/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, stateDir: tmp("cmd-state-") });
    delete process.env.CMD_WIDGETS_HOME;
    const events: { type: string; entries?: WidgetEntry[] }[] = [];
    core.serve({ access: "local", send: (line) => {
      const m = JSON.parse(line) as { method?: string; params?: { type: string } };
      if (m.method === "event") events.push(m.params as never);
    }, close: () => {} }).receive(JSON.stringify({ id: 1, method: "events.subscribe", params: {} }));
    core.start();
    await core.scheduler.idle();
    const list = () => (core.handlers["widget.list"]({}) as unknown as WidgetEntry[]).filter((e) => e.source === "package");
    /** The next widget.library event that `test` accepts, after `act`. */
    const library = async (act: () => void, test: (entries: WidgetEntry[]) => boolean, what: string) => {
      events.length = 0;
      const t0 = Date.now();
      act();
      await until(() => events.some((e) => e.type === "widget.library" && test(e.entries!.filter((x) => x.source === "package"))), what);
      return Date.now() - t0;
    };
    return { core, home, list, library };
  }

  it("lists $CMD_WIDGETS_HOME's packages as window types, and follows the folder within a second", async () => {
    const { core, home, list, library } = await setup();
    expect(list()).toEqual([expect.objectContaining({ ref: "pkg:ci-runs/ci", source: "package", kind: "pkg:ci-runs/ci", name: "ci-runs", version: "1.2.0", api: 1, title: "CI", icon: "checkmark.seal", description: "The latest runs.", windows: [] })]);
    expect((core.handlers["window.types"]({}) as unknown as { kind: string; role: string }[]).find((t) => t.kind === "pkg:ci-runs/ci")).toMatchObject({ role: "widget", title: "CI" });
    // Not among the built-ins.
    expect((core.handlers["widget.list"]({}) as unknown as WidgetEntry[]).filter((e) => e.source === "builtin").some((e) => e.kind.startsWith("pkg:"))).toBe(false);

    // Added by hand: a copy, then its package.json.
    const added = await library(
      () => pkgDir(PKG({ name: "weather", version: "0.1.0" }, { widgets: [{ id: "now", title: "Weather", main: "src/ci.tsx" }, { id: "week", title: "Week", main: "src/ci.tsx" }] }), home, "weather"),
      (e) => e.some((x) => x.ref === "pkg:weather/week"),
      "the added package",
    );
    expect(added).toBeLessThan(1000);
    expect(list().map((e) => e.kind)).toEqual(["pkg:ci-runs/ci", "pkg:weather/now", "pkg:weather/week"]);

    // Changed by hand: a new version and title.
    const changed = await library(() => fs.writeFileSync(path.join(home, "weather", "package.json"), JSON.stringify(PKG({ name: "weather", version: "0.2.0" }, { widgets: [{ id: "now", title: "Weather Now", main: "src/ci.tsx" }] }))), (e) => e.some((x) => x.version === "0.2.0"), "the changed package");
    expect(changed).toBeLessThan(1000);
    expect(list().filter((e) => e.name === "weather")).toEqual([expect.objectContaining({ kind: "pkg:weather/now", title: "Weather Now", version: "0.2.0" })]);
    expect(core.windowTypes.get("pkg:weather/week")).toBeUndefined();

    // Broken: listed with what's wrong, and can't be added.
    await library(() => fs.writeFileSync(path.join(home, "weather", "package.json"), JSON.stringify(PKG({ name: "weather" }, { api: 9 }))), (e) => e.some((x) => !!x.problem), "the broken package");
    expect(list().find((e) => e.name === "weather")).toMatchObject({ ref: "pkg:weather", problem: expect.stringMatching(/^cmd\.api: 9/) });
    expect(() => core.handlers["widget.add"]({ ref: "pkg:weather" })).toThrow(/weather can't be added: cmd\.api/);

    // Removed by hand.
    const removed = await library(() => fs.rmSync(path.join(home, "weather"), { recursive: true }), (e) => !e.some((x) => x.name === "weather"), "the removed package");
    expect(removed).toBeLessThan(1000);
    expect(list().map((e) => e.kind)).toEqual(["pkg:ci-runs/ci"]);

    // Linked: a link to a folder elsewhere counts, and its edits too.
    const elsewhere = pkgDir(PKG({ name: "linked" }), tmp("cmd-src-"), "my-widget");
    await library(() => fs.symlinkSync(elsewhere, path.join(home, "linked")), (e) => e.some((x) => x.name === "linked"), "the linked package");
    await library(() => fs.writeFileSync(path.join(elsewhere, "package.json"), JSON.stringify(PKG({ name: "linked", version: "3.0.0" }))), (e) => e.some((x) => x.name === "linked" && x.version === "3.0.0"), "the linked package's edit");
    await core.close();
    expect(core.windowTypes.get("pkg:ci-runs/ci")).toBeUndefined();
  });

  it("opens, updates and closes a package's window without writing into the package", async () => {
    const { core, home } = await setup();
    const before = snapshot(home);
    const w = core.handlers["widget.add"]({ ref: "pkg:ci-runs/ci" }) as unknown as { id: string; kind: string; title: string; state: Record<string, unknown> };
    expect(w).toMatchObject({ kind: "pkg:ci-runs/ci", title: "CI", state: { package: "ci-runs", widget: "ci" } });
    expect((core.handlers["widget.list"]({}) as unknown as WidgetEntry[]).find((e) => e.ref === "pkg:ci-runs/ci")!.windows).toEqual([w.id]);
    core.handlers["window.update"]({ id: w.id, state: { refreshedAt: Date.now() } });
    core.handlers["window.close"]({ id: w.id });
    expect(snapshot(home)).toEqual(before);
    await core.close();
  });
});

// The built-in root (widgets/packages.ts): packages that ship with cmd, beside the person's.
describe("built-in packages", () => {
  it("are read from the repo's packages/widgets by default", () => {
    expect(BUILTIN_WIDGETS).toBe(path.resolve(import.meta.dirname, "../../widgets"));
    expect(readPackage(path.join(BUILTIN_WIDGETS, "agents"), { cmdVersion: null })).toMatchObject({ ok: true, pkg: { name: "agents", widgets: [{ kind: "pkg:agents/activity", title: "Agents" }], permissions: { workspace: ["read", "all"] } } });
  });

  it("are listed beside the person's, marked built-in; the person's package of the same name wins", () => {
    const home = tmp("cmd-widgets-home-");
    const builtin = tmp("cmd-widgets-builtin-");
    pkgDir(PKG({ name: "agents", version: "1.0.0" }), builtin, "agents");
    pkgDir(PKG({ name: "clock", version: "2.0.0" }), builtin, "clock");
    pkgDir(PKG({ name: "clock", version: "9.0.0" }), home, "clock");
    fs.mkdirSync(path.join(builtin, "not-a-package")); // no package.json: skipped, not listed as broken
    const registered: string[] = [];
    const types = { get: () => undefined, register: (t: { kind: string }) => void registered.push(t.kind), unregister: () => {} } as unknown as WindowTypes;
    const packages = new WidgetPackages({ home, builtin, types: () => types, onChange: () => {} });
    packages.scan();
    const list = packages.list();
    packages.dispose();
    expect(list.map((e) => [e.folder, !!e.builtin, e.ok && e.pkg.version, e.ok && !!e.pkg.builtin])).toEqual([
      ["agents", true, "1.0.0", true],
      ["clock", false, "9.0.0", false],
    ]);
    expect(registered.sort()).toEqual(["pkg:agents/ci", "pkg:clock/ci"]);
  });

  it("are in the Library as built-in and run with what they declare, no grants file", async () => {
    const home = tmp("cmd-widgets-home-");
    const builtin = tmp("cmd-widgets-builtin-");
    writePackage(builtin, { name: "shipped", permissions: { workspace: ["read", "all"] } });
    writePackage(home, { name: "mine", permissions: { workspace: ["read"] } });
    process.env.CMD_WIDGETS_HOME = home;
    process.env.CMD_BUILTIN_WIDGETS = builtin;
    const { Core } = await import("../src/kernel/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const stateDir = tmp("cmd-state-");
    const core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, stateDir });
    delete process.env.CMD_WIDGETS_HOME;
    process.env.CMD_BUILTIN_WIDGETS = ""; // as vitest.setup.ts leaves it
    const rt = new FakeWidgetRuntime(core.widgetTokens);
    core.library.host.configure({ runtime: rt, times: { pingMs: 20, stallMs: 150, stopAfterMs: 100, restartMs: 5, helloMs: 2000 } });
    core.start();
    await core.scheduler.idle();
    const entries = (core.handlers["widget.list"]({}) as unknown as WidgetEntry[]).filter((e) => e.source === "package");
    expect(entries.map((e) => [e.name, !!e.builtin])).toEqual([
      ["mine", false],
      ["shipped", true],
    ]);
    const ws = core.workspaces.home().id;
    const shipped = (await core.handlers["widget.add"]({ ref: "pkg:shipped/main", workspaceId: ws })) as unknown as { id: string };
    const mine = (await core.handlers["widget.add"]({ ref: "pkg:mine/main", workspaceId: ws })) as unknown as { id: string };
    await until(() => core.library.host.status(shipped.id)?.state === "running", "the built-in running");
    expect(rt.procs.map((p) => [p.spec.name, p.spec.permissions.workspace])).toEqual([["shipped", ["read", "all"]]]);
    expect(core.library.host.status(mine.id)?.state).toBe("waiting-grant"); // the person's still asks
    expect(fs.existsSync(grantsPath(stateDir, "shipped"))).toBe(false);
    // Never the grants sheet: no ask for it, also after widget.ask (cmd widget link, the window's Allow…).
    core.handlers["widget.ask"]({ name: "shipped" });
    expect(core.library.host.asking("shipped")).toBeNull();
    const listed = (core.handlers["widget.list"]({}) as unknown as WidgetEntry[]).filter((e) => e.source === "package");
    expect(listed.find((e) => e.name === "shipped")?.ask).toBeUndefined();
    expect(listed.find((e) => e.name === "mine")?.ask).toBeDefined();
    await core.close();
  });
});
