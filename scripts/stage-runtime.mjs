// Stages the core for packaging into apps/desktop/.runtime, which electron-builder
// copies to Contents/Resources/runtime. The layout mirrors the repo (packages/core,
// packages/protocol/src) so the core's import.meta-relative paths and
// sourceBuildId work unchanged; the packaged app runs it with Electron's own Node.
// Dependencies are copied flat into packages/core/node_modules (not `pnpm deploy`,
// which rewrites the workspace's install state).
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "apps/desktop/.runtime");
const core = path.join(out, "packages/core");
const modules = path.join(core, "node_modules");

fs.rmSync(out, { recursive: true, force: true });
const copy = (from, to) => fs.cpSync(path.join(root, from), path.join(out, to), { recursive: true, dereference: true });
for (const p of ["package.json", "src", "shell"]) copy(`packages/core/${p}`, `packages/core/${p}`);
for (const p of ["package.json", "src"]) copy(`packages/protocol/${p}`, `packages/protocol/${p}`);
// @cmd/protocol: a small JavaScript package that re-exports the protocol's
// TypeScript from outside node_modules (Node won't strip types from .ts files
// under node_modules). Plain files, so it survives packaging on every platform,
// unlike a symlink (Windows).
const shim = path.join(modules, "@cmd/protocol");
fs.mkdirSync(shim, { recursive: true });
fs.writeFileSync(path.join(shim, "package.json"), JSON.stringify({ name: "@cmd/protocol", private: true, type: "module", exports: { ".": "./index.js", "./node": "./node.js" } }, null, 2) + "\n");
fs.writeFileSync(path.join(shim, "index.js"), 'export * from "../../../../protocol/src/index.ts";\n');
fs.writeFileSync(path.join(shim, "node.js"), 'export * from "../../../../protocol/src/node.ts";\n');

// The native helper (macOS; gitignored, built by postinstall). Without it the
// core falls back to process names (no CPU/memory sampling): the Windows case.
const procinfo = path.join(root, "packages/core/native/build/procinfo");
if (fs.existsSync(procinfo)) {
  fs.mkdirSync(path.join(core, "native/build"), { recursive: true });
  fs.copyFileSync(procinfo, path.join(core, "native/build/procinfo"));
} else if (process.platform === "darwin") {
  throw new Error("packages/core/native/build/procinfo missing; run pnpm install");
}

/** Node-style lookup of `name` from `dir` upwards; returns the real package dir. */
function findPackage(dir, name) {
  for (let d = dir; ; d = path.dirname(d)) {
    const p = path.join(d, "node_modules", name);
    if (fs.existsSync(path.join(p, "package.json"))) return fs.realpathSync(p);
    if (d === path.dirname(d)) throw new Error(`cannot find ${name} from ${dir}`);
  }
}

function stageDeps(pkgDir) {
  const deps = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).dependencies ?? {};
  for (const name of Object.keys(deps)) {
    if (name.startsWith("@cmd/") || fs.existsSync(path.join(modules, name))) continue;
    const src = findPackage(pkgDir, name);
    fs.cpSync(src, path.join(modules, name), { recursive: true, dereference: true, filter: (f) => path.basename(f) !== "node_modules" });
    stageDeps(src);
  }
}
stageDeps(path.join(root, "packages/core"));

// node-pty: keep only this platform's prebuilds and what loads them.
const pty = path.join(modules, "node-pty");
for (const p of ["deps", "third_party", "src", "scripts", "binding.gyp", "typings"]) fs.rmSync(path.join(pty, p), { recursive: true, force: true });
for (const p of fs.readdirSync(path.join(pty, "prebuilds"))) {
  if (!p.startsWith(`${process.platform}-`)) fs.rmSync(path.join(pty, "prebuilds", p), { recursive: true });
  // node-pty 1.1.0 ships spawn-helper without the exec bit (see postinstall.mjs).
  else if (fs.existsSync(path.join(pty, "prebuilds", p, "spawn-helper"))) fs.chmodSync(path.join(pty, "prebuilds", p, "spawn-helper"), 0o755);
}

console.log(`staged core runtime in ${path.relative(root, out)}: ${fs.readdirSync(modules).join(", ")}`);
