// The packaged app ships no node_modules (electron-builder.yml), so every package main
// imports has to be bundled: listed in the main build's externalizeDeps.exclude in
// electron.vite.config.ts. One that isn't is left as a bare import and the app dies at
// launch with ERR_MODULE_NOT_FOUND (0.32.0 and ws), while dev and e2e, which have
// node_modules beside out/, still pass.
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const desktop = path.join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

// "@scope/name/sub?raw" → "@scope/name", "ws" → "ws"
const packageOf = (spec: string) => spec.split("?")[0].split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");

it("bundles every package the main process imports", () => {
  const config = fs.readFileSync(path.join(desktop, "electron.vite.config.ts"), "utf8");
  const main = /\n  main: \{[\s\S]*?externalizeDeps: \{ exclude: \[([^\]]*)\]/.exec(config);
  expect(main, "the main build's externalizeDeps.exclude").toBeTruthy();
  const bundled = new Set([...main![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));

  const imported = new Set<string>();
  for (const file of [...sources(path.join(desktop, "src/main")), ...sources(path.join(desktop, "src/shared"))]) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b(?!\s+type\b)[^;]*?\bfrom\s+"([^".][^"]*)"|\bimport\(\s*"([^".][^"]*)"\s*\)/g)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith("node:") || spec === "electron") continue;
      imported.add(packageOf(spec));
    }
  }
  expect([...imported].filter((p) => !bundled.has(p))).toEqual([]);
});
