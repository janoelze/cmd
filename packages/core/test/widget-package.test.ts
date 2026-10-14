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
import { runWidgetTool } from "../src/magic/widget-tools.ts";
import { WidgetStore } from "../src/widgets/store.ts";
import type { VerifyContext } from "../src/widgets/verify.ts";
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
  cmd: { api: 1, widgets: [{ id: "ci", title: "CI", icon: "checkmark.seal", main: "src/ci.tsx", size: "m", config: [{ key: "token", title: "Token", type: "string", secret: true }] }], permissions: { net: ["api.github.com"], run: ["gh"], workspace: ["read"], events: ["agents"], act: ["actions.run"] }, ...c },
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
        permissions: { net: ["api.github.com"], run: ["gh"], read: [], workspace: ["read"], events: ["agents"], act: ["actions.run"] },
        widgets: [{ id: "ci", kind: "pkg:ci-runs/ci", title: "CI", icon: "checkmark.seal", main: "src/ci.tsx", size: "m", surface: "tree", config: [{ key: "token", title: "Token", type: "string", secret: true }] }],
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

  it("names the field of every other problem", () => {
    expect(errors(PKG({ name: "CI Runs" }))).toEqual([expect.stringMatching(/^name: /)]);
    expect(errors(PKG({}, { permissions: { net: ["https://x y"] } }))).toEqual([expect.stringMatching(/^cmd\.permissions\.net: /)]);
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
  });

  it("live per instance, outside the package, and round-trip", () => {
    const state = tmp("cmd-state-");
    expect(readGrants(state, "ci-runs")).toBeNull();
    writeGrants(state, "ci-runs", { version: "1.2.0", permissions: declared });
    expect(grantsPath(state, "ci-runs")).toBe(path.join(state, "widget-packages", "ci-runs", "grants.json"));
    expect(readGrants(state, "ci-runs")).toEqual({ version: "1.2.0", permissions: declared });
  });

  it("can't be written by Magic's tools", async () => {
    const state = tmp("cmd-state-");
    writeGrants(state, "ci-runs", { version: "1.2.0", permissions: noPermissions() });
    const file = grantsPath(state, "ci-runs");
    const before = fs.readFileSync(file, "utf8");
    const store = new WidgetStore(path.join(state, "widgets"));
    store.ensure("w1");
    const c = { store, id: "w1", deno: null, previewer: null, cwd: state } satisfies VerifyContext;
    const grant = JSON.stringify({ version: "1.2.0", permissions: { ...noPermissions(), net: ["*"] } });
    for (const p of [file, "../../widget-packages/ci-runs/grants.json", "../widget-packages/ci-runs/grants.json", "grants.json"]) {
      const r = await runWidgetTool("write_file", { why: "x", path: p, content: grant }, c, { dirty: false });
      expect(r?.isError, p).toBe(true);
      const e = await runWidgetTool("edit_file", { why: "x", path: p, old: "[]", new: '["*"]' }, c, { dirty: false });
      expect(e?.isError, p).toBe(true);
    }
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(store.dir("w1"), "grants.json"))).toBe(false);
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
