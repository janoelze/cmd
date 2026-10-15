// Vendors @cmd/widget-api for the widget process (docs/56, "The host API"): Deno runs a
// widget with --no-remote --no-npm, so React, react/jsx-runtime, the reconciler and the
// API are bundled here into ESM files it loads through an import map. One esbuild run
// with code splitting: every entry is a thin file over shared chunks, so the widget's
// `react` and the API's are one React.
//
//   <out>/react.js, jsx-runtime.js, jsx-dev-runtime.js, widget-api.js, runtime.js, chunk-*.js
//   <out>/import-map.json   { imports: { react, react/jsx-runtime, react/jsx-dev-runtime,
//                             @cmd/widget-api, @cmd/widget-api/runtime } }, relative to it
//   <out>/stamp.json        the hash of what it was built from (--if-stale skips a match)
//
// Run by postinstall into packages/widget-api/dist/deno; `node scripts/widget-api-bundle.mjs
// [--out <dir>] [--if-stale]` by hand or by a build after editing the API. The packaged app
// ships the folder (staging it is the widget host's step). Production React: smaller and
// quieter; render errors still carry component stacks.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = path.join(root, "packages/widget-api");
const require = createRequire(path.join(pkg, "package.json"));

/** The protocol files bundled with the API (its `@cmd/protocol/widget-events` and `@cmd/protocol/format` imports). */
const PROTOCOL_MODULES = ["packages/protocol/src/widget-events.ts", "packages/protocol/src/format.ts"];

/** The default output folder. */
export const BUNDLE_DIR = path.join(pkg, "dist/deno");

/** The specifiers a widget may import, and the file each maps to. */
export const IMPORTS = {
  react: "./react.js",
  "react/jsx-runtime": "./jsx-runtime.js",
  "react/jsx-dev-runtime": "./jsx-dev-runtime.js",
  "@cmd/widget-api": "./widget-api.js",
  "@cmd/widget-api/runtime": "./runtime.js",
};

/** A CommonJS module's names, as ESM exports of `spec`'s default. */
function reexport(spec) {
  const names = Object.keys(require(spec)).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== "default");
  return `import M from ${JSON.stringify(spec)};\nexport default M;\nexport const { ${names.join(", ")} } = M;\n`;
}

const ENTRIES = {
  react: () => reexport("react"),
  "jsx-runtime": () => reexport("react/jsx-runtime"),
  "jsx-dev-runtime": () => reexport("react/jsx-dev-runtime"),
  "widget-api": () => `export * from ${JSON.stringify(path.join(pkg, "src/index.ts"))};\n`,
  runtime: () => `export * from ${JSON.stringify(path.join(pkg, "src/runtime.ts"))};\nexport { Connection, ApiCallError } from ${JSON.stringify(path.join(pkg, "src/connection.ts"))};\n`,
};

/** A hash of the API's sources and the versions of what is vendored. */
function sourceHash() {
  const h = crypto.createHash("sha256");
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(p.slice(root.length)).update(fs.readFileSync(p));
    }
  };
  walk(path.join(pkg, "src"));
  // The protocol files the API takes values from (test/imports.test.ts, `modules`): no imports of their own.
  for (const f of PROTOCOL_MODULES) h.update(f).update(fs.readFileSync(path.join(root, f)));
  const fromReconciler = createRequire(require.resolve("react-reconciler/package.json"));
  for (const [dep, req] of [["react", require], ["react-reconciler", require], ["scheduler", fromReconciler]]) h.update(`${dep}@${req(`${dep}/package.json`).version}`);
  h.update(fs.readFileSync(fileURLToPath(import.meta.url)));
  return h.digest("hex");
}

/** Builds the bundle into `out` (by default BUNDLE_DIR); with `ifStale`, only when the sources changed. Returns the import map's path. */
export async function bundleWidgetApi({ out = BUNDLE_DIR, ifStale = false } = {}) {
  const hash = sourceHash();
  const stamp = path.join(out, "stamp.json");
  const map = path.join(out, "import-map.json");
  if (ifStale && fs.existsSync(map) && fs.existsSync(stamp) && JSON.parse(fs.readFileSync(stamp, "utf8")).hash === hash) return map;
  const esbuild = require("esbuild");
  fs.rmSync(out, { recursive: true, force: true });
  await esbuild.build({
    entryPoints: Object.fromEntries(Object.keys(ENTRIES).map((k) => [k, `cmd-entry:${k}`])),
    outdir: out,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none",
    logLevel: "warning",
    plugins: [
      {
        name: "cmd-entries",
        setup(b) {
          b.onResolve({ filter: /^cmd-entry:/ }, (a) => ({ path: a.path.slice("cmd-entry:".length), namespace: "cmd-entry" }));
          b.onLoad({ filter: /.*/, namespace: "cmd-entry" }, (a) => ({ contents: ENTRIES[a.path](), resolveDir: pkg, loader: "js" }));
        },
      },
    ],
  });
  fs.writeFileSync(map, JSON.stringify({ imports: IMPORTS }, null, 2) + "\n");
  fs.writeFileSync(stamp, JSON.stringify({ hash }) + "\n");
  return map;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const at = process.argv.indexOf("--out");
  const out = at > 0 ? path.resolve(process.argv[at + 1]) : BUNDLE_DIR;
  const map = await bundleWidgetApi({ out, ifStale: process.argv.includes("--if-stale") });
  console.log(`widget-api bundle: ${path.relative(process.cwd(), map)}`);
}
