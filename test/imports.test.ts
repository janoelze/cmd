// The package graph (docs/architecture-review-01/13 AR1-13-02, 14 AR1-14-07), checked
// on every import in the repo instead of remembered. Each part of the repo may import
// only the parts listed for it in ALLOWED; nothing in packages/ imports apps/; nothing
// in a package reaches into another package's folder by a relative path or by
// "@cmd/x/src/…" (only through its package.json exports). What breaks a rule today is listed in
// imports-debt.json: a new break fails here, and one that's gone fails too until
// `pnpm layout-debt` (which writes both baselines) drops it from the list.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "..");
const BASELINE = path.join(import.meta.dirname, "imports-debt.json");

/** The parts of the repo, by folder (the first that matches). */
const PARTS: [string, string][] = [
  ["packages/protocol/", "protocol"],
  ["packages/remote-crypto/", "remote-crypto"],
  ["packages/core/", "core"],
  ["packages/cli/", "cli"],
  ["packages/ui/", "ui"],
  // The fake host and fixtures (and testing.ts over them): run in Node under a test runner, never in the widget process.
  ["packages/widget-api/src/testing", "widget-api/testing"],
  ["packages/widget-api/", "widget-api"],
  ["packages/widgets/", "widgets"],
  ["apps/desktop/src/main/", "desktop/main"],
  ["apps/desktop/src/preload/", "desktop/preload"],
  ["apps/desktop/src/renderer/", "desktop/renderer"],
  ["apps/desktop/src/shared/", "desktop/shared"],
  ["apps/desktop/src/jam/", "desktop/frames"],
  ["apps/desktop/src/visualizer/", "desktop/frames"],
  ["apps/desktop/src/package-frame/", "desktop/frames"],
  ["apps/desktop/", "desktop"],
  ["apps/web/", "web"],
  ["apps/relay/", "relay"],
  ["tools/", "tools"],
  ["scripts/", "scripts"],
  ["e2e/", "e2e"],
  ["test/", "test"],
  ["website/", "website"],
];
const PACKAGES: Record<string, string> = { "@cmd/protocol": "packages/protocol", "@cmd/remote-crypto": "packages/remote-crypto", "@cmd/core": "packages/core", "@cmd/cli": "packages/cli", "@cmd/ui": "packages/ui", "@cmd/widget-api": "packages/widget-api", "@cmd/desktop": "apps/desktop", "@cmd/web": "apps/web", "@cmd/relay": "apps/relay", "@cmd/tours": "tools/tours" };

/**
 * What the shipped code of each part may import: workspace parts, plus "node:" and
 * "electron" where they run. `types`: parts it may import types from (erased at build).
 * Tests and dev tooling are held only to the rules that apply everywhere.
 */
const ALLOWED: Record<string, { value: string[]; types?: string[]; modules?: string[] }> = {
  protocol: { value: ["node:"] },
  "remote-crypto": { value: [] },
  ui: { value: [] },
  // Runs in the widget process (Deno, sandboxed): protocol's wire types only, nothing at run time.
  // `modules`: values from these alone, protocol files with no imports (the bundle hashes them, scripts/widget-api-bundle.mjs).
  "widget-api": { value: [], types: ["protocol"], modules: ["@cmd/protocol/widget-events", "@cmd/protocol/format"] },
  // Its tests' side (@cmd/widget-api/testing): the API's own code, and the protocol's tables (the verbs' rows, agents' lights), so a fake can't drift from the core.
  "widget-api/testing": { value: ["widget-api", "protocol"] },
  // Widget packages that ship with cmd (packages/widgets/<name>): the widget API, as any package's (and react, from npm: WIDGET_NPM).
  widgets: { value: ["widget-api"] },
  core: { value: ["protocol", "remote-crypto", "node:"] },
  cli: { value: ["protocol", "remote-crypto", "core", "node:"] },
  "desktop/main": { value: ["protocol", "ui", "desktop/shared", "desktop/frames", "electron", "node:"] },
  "desktop/preload": { value: ["protocol", "desktop/shared", "electron", "node:"], types: ["desktop/main"] },
  "desktop/renderer": { value: ["protocol", "ui", "remote-crypto", "desktop/shared"], types: ["desktop/preload", "electron"] },
  "desktop/shared": { value: ["protocol"] },
  web: { value: ["protocol", "remote-crypto", "ui"] },
  relay: { value: ["protocol", "node:"] },
};

const partOf = (rel: string) => PARTS.find(([p]) => rel.startsWith(p))?.[1] ?? null;
/** The package folder a file is in ("packages/core"), or null. */
const packageOf = (rel: string) => Object.values(PACKAGES).find((p) => rel.startsWith(`${p}/`)) ?? null;
/** Shipped code: under a package's src/ (tests, configs and scripts are not). */
/** The UI Workbench (docs/48) runs only in the dev server (no build input), as stories do: it may draw widget packages' stories with @cmd/widget-api. */
const DEV_ONLY = /^apps\/desktop\/src\/renderer\/src\/workbench\//;
const shipped = (rel: string) => /^((packages|apps)\/[^/]+|packages\/widgets\/[^/]+)\/src\//.test(rel) && !/\.(test|story)\.tsx?$/.test(rel) && !DEV_ONLY.test(rel);
/** What a widget package's shipped code may take from npm: React, whose runtime the widget process has (the vendored bundle). */
const WIDGET_NPM = ["react", "react/jsx-runtime"];

const SKIP = new Set(["node_modules", "out", "out-dev", "dist", "build", "native"]);
function files(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(path.join(root, dir))) return out;
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) files(rel, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

/** Every import and re-export of a file: its specifier and whether only types come in. */
function importsOf(src: string): { spec: string; type: boolean }[] {
  const out: { spec: string; type: boolean }[] = [];
  const re = /(?:^|[\n;])\s*(?:import|export)\s+(type\s+)?(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(src)); ) out.push({ spec: m[2] ?? m[3]!, type: !!m[1] });
  return out;
}

/** What breaks the rules, one line each ("file: spec, why"). */
function breaks(): string[] {
  const out: string[] = [];
  for (const f of ["packages", "apps", "tools", "scripts", "e2e", "test", "website"].flatMap((d) => files(d))) {
    const from = partOf(f);
    const pkg = packageOf(f);
    for (const { spec, type } of importsOf(fs.readFileSync(path.join(root, f), "utf8"))) {
      let to: string | null = null;
      let target: string | null = null;
      if (spec.startsWith(".")) {
        target = path.normalize(path.join(path.dirname(f), spec));
        to = partOf(target);
      } else if (spec.startsWith("node:")) to = "node:";
      else if (spec === "electron" || spec.startsWith("electron/")) to = "electron";
      else {
        const name = Object.keys(PACKAGES).find((p) => spec === p || spec.startsWith(`${p}/`));
        if (!name && from === "widgets" && shipped(f) && !WIDGET_NPM.includes(spec)) out.push(`${f}: ${spec}, a widget package may import only @cmd/widget-api and react`);
        if (!name) continue; // a dependency from npm: package.json's business
        target = PACKAGES[name]!;
        to = partOf(`${target}/src/`) ?? partOf(`${target}/`);
        if (/^@cmd\/[^/]+\/src\//.test(spec)) out.push(`${f}: ${spec}, past the package's exports`);
      }
      if (!to || to === from) continue;
      if (f.startsWith("packages/") && target?.startsWith("apps/")) out.push(`${f}: ${spec}, a package importing an app`);
      // From one package into another's folder by a relative path: only through "@cmd/…" and its exports.
      // (The repo's own tooling, scripts/, e2e/ and test/, is no package and reaches in by path.)
      if (pkg && spec.startsWith(".") && target && packageOf(target) && packageOf(target) !== pkg) out.push(`${f}: ${spec}, into another package by its path`);
      if (!shipped(f) || !from || !ALLOWED[from]) continue;
      const rule = ALLOWED[from];
      if (rule.value.includes(to) || (type && rule.types?.includes(to)) || rule.modules?.includes(spec)) continue;
      out.push(`${f}: ${spec}, ${from} may not import ${type ? "types from " : ""}${to}`);
    }
  }
  return [...new Set(out)].sort();
}

describe("the package graph", () => {
  const now = breaks();

  it("reads imports of every shape", () => {
    expect(importsOf(`import a from "./a.ts";\nimport type { B } from "@cmd/protocol";\nexport { c } from "../c.ts";\nimport "./side.css";\nconst d = await import("@cmd/core");\nimport {\n  e,\n  f,\n} from "node:fs";`)).toEqual([
      { spec: "./a.ts", type: false },
      { spec: "@cmd/protocol", type: true },
      { spec: "../c.ts", type: false },
      { spec: "./side.css", type: false },
      { spec: "@cmd/core", type: false },
      { spec: "node:fs", type: false },
    ]);
  });

  if (process.env.UPDATE_LAYOUT_DEBT) {
    it("writes imports-debt.json", () => fs.writeFileSync(BASELINE, JSON.stringify(now, null, 2) + "\n"));
    return;
  }

  const base = new Set(JSON.parse(fs.readFileSync(BASELINE, "utf8")) as string[]);

  it("no import breaks the graph that imports-debt.json doesn't list", () => {
    const added = now.filter((b) => !base.has(b));
    expect(added, `Import through the package's name and exports, and only what this part may use (ALLOWED in test/imports.test.ts):\n${added.join("\n")}`).toEqual([]);
  });

  it("imports-debt.json lists nothing that's fixed (pnpm layout-debt drops it)", () => {
    const fixed = [...base].filter((b) => !now.includes(b));
    expect(fixed, `Run pnpm layout-debt to drop:\n${fixed.join("\n")}`).toEqual([]);
  });
});
