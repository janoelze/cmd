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
// The checkout this was built from: a development build ("cmd dev") looks there for API keys
// in .env (packages/core/src/dev-keys.ts). The path only, never a key.
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, ".checkout"), root + "\n");
// widget-runtime: the Deno side of Magic widgets (cmd.ts, runner.ts), run by Deno from there.
for (const p of ["package.json", "src", "shell", "widget-runtime"]) copy(`packages/core/${p}`, `packages/core/${p}`);
// Workspace packages the core imports (@cmd/protocol, @cmd/remote-crypto): their
// TypeScript is copied next to the core, and node_modules gets a small JavaScript
// package per entry point that re-exports it from there (Node won't strip types
// from .ts files under node_modules). Plain files, so they survive packaging on
// every platform, unlike a symlink (Windows).
function stageWorkspacePackage(name, into = modules) {
  const dir = `packages/${name.slice("@cmd/".length)}`;
  for (const p of ["package.json", "src"]) copy(`${dir}/${p}`, `${dir}/${p}`);
  const entries = JSON.parse(fs.readFileSync(path.join(root, dir, "package.json"), "utf8")).exports;
  const shim = path.join(into, name);
  fs.mkdirSync(shim, { recursive: true });
  const exports = {};
  for (const [key, target] of Object.entries(entries)) {
    const file = `${key === "." ? "index" : key.slice(2).replaceAll("/", "-")}.js`; // flat: one level deep, like the path below
    exports[key] = `./${file}`;
    fs.writeFileSync(path.join(shim, file), `export * from "../../../../${path.basename(dir)}/${target.replace(/^\.\//, "")}";\n`);
  }
  fs.writeFileSync(path.join(shim, "package.json"), JSON.stringify({ name, private: true, type: "module", exports }, null, 2) + "\n");
}
const corePkg = JSON.parse(fs.readFileSync(path.join(root, "packages/core/package.json"), "utf8"));
for (const name of Object.keys(corePkg.dependencies)) if (name.startsWith("@cmd/")) stageWorkspacePackage(name);

// The CLI, for the `cmd` the core puts on PATH in panes (agents/hooks.ts). Its own
// node_modules: shims for the workspace packages (the core's source is already
// staged), and its other dependencies.
const cliModules = path.join(out, "packages/cli/node_modules");
for (const p of ["package.json", "src"]) copy(`packages/cli/${p}`, `packages/cli/${p}`);
const cliPkg = JSON.parse(fs.readFileSync(path.join(root, "packages/cli/package.json"), "utf8"));
for (const name of Object.keys(cliPkg.dependencies)) if (name.startsWith("@cmd/")) stageWorkspacePackage(name, cliModules);

// The native helper (macOS; gitignored, built by postinstall). Without it the
// core falls back to process names (no CPU/memory sampling): the Windows case.
const procinfo = path.join(root, "packages/core/native/build/procinfo");
if (fs.existsSync(procinfo)) {
  fs.mkdirSync(path.join(core, "native/build"), { recursive: true });
  fs.copyFileSync(procinfo, path.join(core, "native/build/procinfo"));
} else if (process.platform === "darwin") {
  throw new Error("packages/core/native/build/procinfo missing; run pnpm install");
}

// The app's notification permission addon (macOS; built by postinstall), loaded
// by Electron main from here (src/main/notify-permission.ts).
const notifications = path.join(root, "apps/desktop/native/build/notifications.node");
if (fs.existsSync(notifications)) {
  fs.mkdirSync(path.join(out, "apps/desktop/native/build"), { recursive: true });
  fs.copyFileSync(notifications, path.join(out, "apps/desktop/native/build/notifications.node"));
} else if (process.platform === "darwin") {
  throw new Error("apps/desktop/native/build/notifications.node missing; run pnpm install");
}

// The SF Symbols renderer (macOS; built by postinstall), run by Electron main
// (src/main/index.ts). Without it icons fall back to resized bitmaps: smaller and soft.
const sfsymbols = path.join(root, "apps/desktop/native/build/sfsymbols");
if (fs.existsSync(sfsymbols)) {
  fs.mkdirSync(path.join(out, "apps/desktop/native/build"), { recursive: true });
  fs.copyFileSync(sfsymbols, path.join(out, "apps/desktop/native/build/sfsymbols"));
} else if (process.platform === "darwin") {
  throw new Error("apps/desktop/native/build/sfsymbols missing; run pnpm install");
}

/** Node-style lookup of `name` from `dir` upwards; returns the real package dir. */
function findPackage(dir, name) {
  for (let d = dir; ; d = path.dirname(d)) {
    const p = path.join(d, "node_modules", name);
    if (fs.existsSync(path.join(p, "package.json"))) return fs.realpathSync(p);
    if (d === path.dirname(d)) throw new Error(`cannot find ${name} from ${dir}`);
  }
}

/** A package's dependencies, plus the peer dependencies it can't do without (ai needs zod). */
function depsOf(pkgDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const optional = pkg.peerDependenciesMeta ?? {};
  const peers = Object.keys(pkg.peerDependencies ?? {}).filter((n) => !optional[n]?.optional);
  return [...Object.keys(pkg.dependencies ?? {}), ...peers];
}

function stageDeps(pkgDir, into = modules) {
  for (const name of depsOf(pkgDir)) {
    if (name.startsWith("@cmd/") || fs.existsSync(path.join(into, name))) continue;
    const src = findPackage(pkgDir, name);
    fs.cpSync(src, path.join(into, name), { recursive: true, dereference: true, filter: (f) => path.basename(f) !== "node_modules" });
    stageDeps(src, into);
  }
}
stageDeps(path.join(root, "packages/core"));
// ripgrep's binary is an optional dependency per platform (file search, search/files.ts): this platform's.
{
  const name = `@vscode/ripgrep-${process.platform}-${process.arch}`;
  const src = findPackage(findPackage(path.join(root, "packages/core"), "@vscode/ripgrep"), name);
  fs.cpSync(src, path.join(modules, name), { recursive: true, dereference: true });
  const bin = path.join(modules, name, "bin", process.platform === "win32" ? "rg.exe" : "rg");
  if (!fs.existsSync(bin)) throw new Error(`${name} has no ripgrep binary`);
  if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
}
stageDeps(path.join(root, "packages/cli"), cliModules);

// node-pty: keep only this platform's prebuilds and what loads them.
const pty = path.join(modules, "node-pty");
for (const p of ["deps", "third_party", "src", "scripts", "binding.gyp", "typings"]) fs.rmSync(path.join(pty, p), { recursive: true, force: true });
for (const p of fs.readdirSync(path.join(pty, "prebuilds"))) {
  if (!p.startsWith(`${process.platform}-`)) fs.rmSync(path.join(pty, "prebuilds", p), { recursive: true });
  // spawn-helper needs its exec bit (see postinstall.mjs).
  else if (fs.existsSync(path.join(pty, "prebuilds", p, "spawn-helper"))) fs.chmodSync(path.join(pty, "prebuilds", p, "spawn-helper"), 0o755);
}

console.log(`staged core runtime in ${path.relative(root, out)}: ${fs.readdirSync(modules).join(", ")}`);
