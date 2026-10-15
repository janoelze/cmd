// scripts/stage-widgets.mjs: a built-in widget package ships what its package.json's `files` lists
// (a frame widget's root view.html too), plus package.json, README and LICENSE, never node_modules
// or a dot-folder, and staging fails loudly on a listed file that isn't there or a main left out.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs script, no types
import { stageWidgetPackage, widgetShipFiles } from "../scripts/stage-widgets.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-stage-widgets-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A fixture built-in: a frame widget with view.html and a vendored script at its root. */
function fixture(name: string, files: unknown, extra: Record<string, string> = {}): string {
  const pkg = path.join(dir, name);
  const write = (rel: string, text: string) => (fs.mkdirSync(path.dirname(path.join(pkg, rel)), { recursive: true }), fs.writeFileSync(path.join(pkg, rel), text));
  write("package.json", JSON.stringify({ name, version: "1.0.0", files, cmd: { api: 1, widgets: [{ id: "main", title: "Viz", main: "src/main.tsx", surface: "frame" }] } }));
  write("README.md", "# Viz\n");
  write("LICENSE", "AGPL\n");
  write("view.html", "<canvas></canvas>");
  write("vendor/lib.js", "//");
  write("src/main.tsx", "export default () => null;");
  write("src/main.test.tsx", "//");
  write("src/.cache/x", "");
  write("vendor/node_modules/dep/index.js", "");
  write(".cmd-preview/shot.png", "");
  for (const [rel, text] of Object.entries(extra)) write(rel, text);
  return pkg;
}

describe("stage-widgets", () => {
  it("ships a frame built-in's root view.html and what `files` lists, never node_modules or dot-folders", () => {
    const pkg = fixture("viz", ["src/main.tsx", "view.html", "vendor", "README.md", "LICENSE"]);
    expect(widgetShipFiles(pkg)).toEqual(["LICENSE", "README.md", "package.json", "src/main.tsx", "vendor/lib.js", "view.html"]);
    const to = path.join(dir, "out", "viz");
    stageWidgetPackage(pkg, to);
    expect(fs.readFileSync(path.join(to, "view.html"), "utf8")).toBe("<canvas></canvas>");
    expect(fs.existsSync(path.join(to, "src/main.test.tsx"))).toBe(false);
    expect(fs.existsSync(path.join(to, ".cmd-preview"))).toBe(false);
    expect(fs.existsSync(path.join(to, "vendor/node_modules"))).toBe(false);
  });

  it("a folder in `files` skips its dot-entries", () => {
    const pkg = fixture("viz-src", ["src", "view.html"]);
    expect(widgetShipFiles(pkg)).toEqual(["LICENSE", "README.md", "package.json", "src/main.test.tsx", "src/main.tsx", "view.html"]);
  });

  it("fails loudly on a listed file that isn't there, on no `files`, on a glob or `..`", () => {
    expect(() => widgetShipFiles(fixture("missing", ["src/main.tsx", "view.html", "meter.html"]))).toThrow(/packages\/widgets\/missing: "files" lists meter.html, which isn't there/);
    expect(() => widgetShipFiles(fixture("nofiles", undefined))).toThrow(/lists no "files"/);
    expect(() => widgetShipFiles(fixture("glob", ["src/*.tsx", "view.html"]))).toThrow(/no glob/);
    expect(() => widgetShipFiles(fixture("up", ["../x", "view.html"]))).toThrow(/no glob, "\.\."/);
    expect(() => widgetShipFiles(fixture("dot", [".cmd-preview", "src/main.tsx", "view.html"]))).toThrow(/dot-file/);
  });

  it("fails when `files` leaves out a widget's main or a frame widget's view.html", () => {
    expect(() => widgetShipFiles(fixture("nomain", ["view.html"]))).toThrow(/main src\/main.tsx isn't in "files"/);
    expect(() => widgetShipFiles(fixture("noview", ["src/main.tsx"]))).toThrow(/draws in a frame, but view.html isn't in "files"/);
  });

  it("fails on a shipped script's relative import that `files` doesn't list, or that isn't there", () => {
    const main = 'import { fmt } from "./format.ts";\nimport type { T } from "./types.ts";\nexport default () => fmt(1);\n';
    const pkg = fixture("helper", ["src/main.tsx", "view.html"], { "src/main.tsx": main, "src/format.ts": 'export * from "./units";\nexport const fmt = String;' });
    expect(() => widgetShipFiles(pkg)).toThrow(/packages\/widgets\/helper: src\/main.tsx imports \.\/format.ts \(src\/format.ts\), which isn't in "files"/);
    const listed = fixture("helper2", ["src/main.tsx", "src/format.ts", "view.html"], { "src/main.tsx": main, "src/format.ts": 'export * from "./units";\nexport const fmt = String;' });
    expect(() => widgetShipFiles(listed)).toThrow(/src\/format.ts imports \.\/units, which isn't there/);
    fs.writeFileSync(path.join(listed, "src/units.ts"), "export {};");
    fs.writeFileSync(path.join(listed, "package.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(listed, "package.json"), "utf8")), files: ["src/main.tsx", "src/format.ts", "src/units.ts", "view.html"] }));
    expect(widgetShipFiles(listed)).toContain("src/units.ts"); // the type-only import of types.ts is erased: not a problem
  });

  it("every built-in in packages/widgets stages", () => {
    const root = path.resolve(import.meta.dirname, "../packages/widgets");
    for (const name of fs.readdirSync(root)) {
      if (!fs.existsSync(path.join(root, name, "package.json"))) continue;
      const files = widgetShipFiles(path.join(root, name)) as string[];
      expect(files, name).toContain("package.json");
      expect(files.some((f) => f.includes("node_modules") || f.split("/").some((s) => s.startsWith("."))), name).toBe(false);
    }
  });
});
