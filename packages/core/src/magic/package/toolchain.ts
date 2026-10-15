// How a Magic build checks, tests and renders the package it writes (docs/56, "Magic on
// V3"), the way `cmd widget check` and `test` would: package.json through readPackage, then
// TypeScript over src/ against @cmd/widget-api's own sources, Vitest with
// @cmd/widget-api/testing (the fake host), and the widget's trees for the previewer, rendered
// in Vitest against each of its story's states (else each fixture). Each runs on a copy of the
// package in a temporary folder whose node_modules links to the checkout's widget-api, React,
// Vitest and types, as a child process of this Node under lib/sandbox.ts (writes only to that
// folder, no network): the agent's code and tests never run in the core. The tools are the
// checkout's TypeScript and Vitest; a cmd without them (the packaged app for now) checks
// package.json alone and says the rest was skipped (packageJsonToolchain; docs/56, Open questions).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WidgetPatch, WidgetTree } from "@cmd/protocol";
import { execArgv, type SandboxMode } from "../../lib/sandbox.ts";
import { writeEnvTypes } from "../../widgets/env-types.ts";
import { readPackage, type WidgetPackage } from "../../widgets/package.ts";
import { STORY_STATES, TOOLCHAIN_TIMEOUT_MS } from "../../widgets/limits.ts";
import { listFiles } from "./files.ts";

/** The checkout this core runs from. */
export const REPO = path.resolve(import.meta.dirname, "../../../../..");

export interface RunOptions {
  sandbox: SandboxMode;
  deny: string[];
  signal?: AbortSignal;
  /** The running cmd's version for engines.cmd (null: not checked). */
  cmdVersion?: string | null;
}

export interface CheckResult {
  ok: boolean;
  problems: string[];
  pkg: WidgetPackage | null;
  /** Whether TypeScript ran (a cmd without the toolchain skips it). */
  types: "checked" | "skipped";
}

export interface TestResult {
  ok: boolean;
  passed: number;
  failed: { name: string; message: string }[];
  /** Why it didn't run, or what kept it from finishing. */
  problems: string[];
  skipped?: string;
}

export interface TreeVariant {
  widget: string;
  /** The story's export or the fixture's name ("Busy", "busy"), or "Empty". */
  name: string;
  /** The tree, then patches, as the widget sent them. */
  messages: (WidgetTree | WidgetPatch)[];
  /** The tree as text (elements, props, text). */
  outline: string;
  /** Errors and warnings the widget logged, and a render that failed. */
  errors: string[];
  /** It shows its empty state (a View's state of kind empty, or an EmptyState). */
  empty?: boolean;
  /** The state gives it data (agents, terminals, events, fetches, …): an empty state there is a bug. */
  data?: boolean;
  /** The story's size for it ("narrow"), if it says one. */
  size?: string;
}

export interface TreesResult {
  ok: boolean;
  variants: TreeVariant[];
  problems: string[];
  skipped?: string;
}

export interface Toolchain {
  name: string;
  check(dir: string, o: RunOptions): Promise<CheckResult>;
  test(dir: string, o: RunOptions): Promise<TestResult>;
  trees(dir: string, o: RunOptions): Promise<TreesResult>;
}

const real = (p: string) => fs.realpathSync(p);
const exists = (p: string) => fs.existsSync(p);

/** Where the checkout keeps what a package's check needs; null when anything is missing. */
function modules(repo: string): Record<string, string> | null {
  const api = path.join(repo, "packages/widget-api");
  const nm = path.join(api, "node_modules");
  const want: Record<string, string> = {
    "@cmd/widget-api": api,
    react: path.join(nm, "react"),
    vitest: path.join(nm, "vitest"),
    "@types/react": path.join(nm, "@types/react"),
    "@types/node": path.join(repo, "node_modules/@types/node"),
  };
  try {
    return Object.fromEntries(Object.entries(want).map(([k, v]) => [k, real(v)]));
  } catch {
    return null;
  }
}

/**
 * A person's package (`cmd widget new`, `dev`, `check`, `test`): node_modules links to the
 * checkout's @cmd/widget-api, React, Vitest, TypeScript and types, and their commands in
 * node_modules/.bin, so `npm test`, an editor and `tsc` work in the folder as they would after
 * an install (@cmd/widget-api isn't on npm yet). A module already there (a real install, the
 * person's own) is left alone, and so is a live link; a dangling one is linked again. Returns
 * what it linked, or null when this cmd has no checkout.
 */
export function linkDevModules(dir: string, repo = REPO): string[] | null {
  const mods = modules(repo);
  const ts = path.join(repo, "node_modules/typescript");
  if (!mods || !exists(ts)) return null;
  const all: Record<string, string> = { ...mods, typescript: real(ts) };
  const linked: string[] = [];
  // There: a real install, the person's own, or a live link. A link into a checkout that's gone
  // (a removed worktree, a moved app) is replaced, or npm test would never find the module again.
  const there = (p: string) => {
    try {
      if (!fs.lstatSync(p).isSymbolicLink()) return true;
    } catch {
      return false;
    }
    if (fs.existsSync(p)) return true;
    fs.unlinkSync(p);
    return false;
  };
  for (const [name, target] of Object.entries(all)) {
    const at = path.join(dir, "node_modules", name);
    if (there(at)) continue;
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at);
    linked.push(name);
  }
  const bins: Record<string, string> = { vitest: "vitest/vitest.mjs", tsc: "typescript/bin/tsc" };
  for (const [bin, rel] of Object.entries(bins)) {
    const at = path.join(dir, "node_modules/.bin", bin);
    if (there(at)) continue;
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(path.join("..", rel), at);
  }
  return linked;
}

const TSCONFIG = {
  compilerOptions: {
    target: "ES2023",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noUncheckedIndexedAccess: true,
    noImplicitReturns: true,
    noFallthroughCasesInSwitch: true,
    verbatimModuleSyntax: true,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    noEmit: true,
    jsx: "react-jsx",
    lib: ["ES2023"],
    types: ["node"],
  },
  include: ["src/**/*.ts", "src/**/*.tsx", "cmd-env.d.ts"],
};

/** Renders each widget against its story's states (else its fixtures, else an empty host) and writes the trees to CMD_TREES_OUT. */
const API = "@cmd/widget-api"; // named once: the harness is text, run in the package's copy
const TREES_HARNESS = `import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { render, createHost, matchers, configValues } from "${API}/testing";

const root = process.cwd();
const DATA = ["agents", "terminals", "windows", "events", "fetch", "ai", "git", "diff", "worktrees", "actions"];
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const fixtures = () => {
  const dir = path.join(root, "fixtures");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => ({ name: f.replace(/\\.json$/, ""), data: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }));
};

it("trees", async () => {
  const out = [];
  for (const w of pkg.cmd.widgets) {
    if (w.surface === "frame") continue;
    const mod = await import(path.join(root, w.main));
    const story = path.join(root, w.main.replace(/\\.tsx?$/, ".story.tsx"));
    let states = [];
    if (fs.existsSync(story)) {
      const s = await import(story);
      states = Object.entries(s).filter(([k, v]) => k !== "default" && v && typeof v === "object").map(([name, data]) => ({ name, data }));
    }
    if (!states.length) states = fixtures();
    if (!states.length) states = [{ name: "Empty", data: {} }];
    for (const { name, data } of states.slice(0, ${STORY_STATES})) {
      const { size, ...host } = data;
      // Config as the core gives it: the fields' defaults under what the state sets.
      const h = createHost({ ...host, config: configValues(w.config, host.config) });
      const errors = [];
      let outline = "";
      let empty = false;
      // Data the state gives it: what an empty state there would be wrong about.
      const given = DATA.some((k) => { const v = host[k]; return Array.isArray(v) ? v.length > 0 : typeof v === "function" || (v && typeof v === "object" ? Object.keys(v).length > 0 : typeof v === "string" && v.length > 0); });
      try {
        const tree = await render(mod.default, h);
        outline = tree.toString();
        empty = matchers.toShowState(tree, "empty").pass;
        tree.unmount();
      } catch (e) {
        errors.push(String(e && e.stack || e).split("\\n").slice(0, 4).join("\\n"));
      }
      for (const m of h.messages) {
        if (m.kind === "error") errors.push(m.message + (m.stack ? "\\n" + String(m.stack).split("\\n").slice(0, 3).join("\\n") : ""));
        if (m.kind === "log" && (m.level === "error" || m.level === "warn")) errors.push(m.level + ": " + m.message);
      }
      out.push({ widget: w.id, name, messages: h.messages.filter((m) => m.kind === "tree" || m.kind === "patch"), outline, errors, empty, data: given, ...(typeof size === "string" ? { size } : {}) });
    }
  }
  fs.writeFileSync(process.env.CMD_TREES_OUT, JSON.stringify(out));
});
`;

interface Work {
  dir: string;
  pkg: string;
  done(): void;
}

/** A copy of the package's own files with node_modules linked to the checkout's, and the configs (`pkg`: package.json as already read). */
function workCopy(src: string, mods: Record<string, string>, pkg_?: WidgetPackage): Work {
  const dir = real(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-magic-pkg-")));
  const pkg = path.join(dir, "pkg");
  for (const f of listFiles(src)) {
    fs.mkdirSync(path.dirname(path.join(pkg, f)), { recursive: true });
    fs.copyFileSync(path.join(src, f), path.join(pkg, f));
  }
  for (const [name, target] of Object.entries(mods)) {
    const at = path.join(pkg, "node_modules", name);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at);
  }
  fs.writeFileSync(path.join(pkg, "tsconfig.json"), JSON.stringify(TSCONFIG));
  // The config's types as package.json says now, whatever the folder's own copy says.
  const read = pkg_ ? { ok: true as const, pkg: pkg_ } : readPackage(src);
  if (read.ok) writeEnvTypes(pkg, read.pkg);
  // Modules, as Deno runs them, whether or not package.json says "type": "module".
  try {
    const pj = path.join(pkg, "package.json");
    const json = JSON.parse(fs.readFileSync(pj, "utf8"));
    if (json.type !== "module") fs.writeFileSync(pj, JSON.stringify({ ...json, type: "module" }));
  } catch {}
  return { dir, pkg, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A tool's text, with paths relative to the package and no lines from inside node_modules. */
const tidy = (text: string, pkg: string) =>
  text
    .replaceAll(`file://${pkg}/`, "")
    .replaceAll(pkg + path.sep, "")
    .replaceAll(pkg, ".")
    .split("\n")
    .filter((l) => !l.includes("/node_modules/"))
    .join("\n");

/** The checkout's TypeScript and Vitest (REPO), or null when this cmd doesn't have them. */
export function checkoutToolchain(repo = REPO): Toolchain | null {
  const tsc = path.join(repo, "node_modules/typescript/bin/tsc");
  const vitest = path.join(repo, "node_modules/vitest/vitest.mjs");
  const mods = modules(repo);
  if (!exists(tsc) || !exists(vitest) || !mods) return null;
  const node = process.execPath;
  const env = { ELECTRON_RUN_AS_NODE: "1", NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" };

  const vitestRun = async (w: Work, include: string, o: RunOptions, extraEnv: Record<string, string> = {}) => {
    const config = path.join(w.pkg, "vitest.config.mjs");
    fs.writeFileSync(config, `export default { test: { include: [${JSON.stringify(include)}], testTimeout: 10000, pool: "threads", maxWorkers: 1, cache: false } };\n`);
    const report = path.join(w.dir, "report.json");
    const r = await execArgv([node, vitest, "run", "--root", w.pkg, "--config", config, "--reporter=json", `--outputFile=${report}`], { cwd: w.pkg, sandbox: o.sandbox, deny: o.deny, signal: o.signal, writable: [w.dir], net: [], timeoutMs: TOOLCHAIN_TIMEOUT_MS, env: { ...env, ...extraEnv } });
    let json: { numPassedTests?: number; testResults?: { name: string; message?: string; assertionResults?: { fullName: string; status: string; failureMessages?: string[] }[] }[] } | null = null;
    try {
      json = JSON.parse(fs.readFileSync(report, "utf8"));
    } catch {}
    return { r, json };
  };

  return {
    name: "TypeScript and Vitest from the cmd checkout",

    async check(dir, o) {
      const read = readPackage(dir, { cmdVersion: o.cmdVersion ?? null });
      if (!read.ok) return { ok: false, problems: read.errors, pkg: null, types: "skipped" };
      const problems: string[] = [];
      for (const w of read.pkg.widgets) if (w.surface === "frame" && !exists(path.join(dir, "view.html"))) problems.push(`cmd.widgets: "${w.id}" draws in a frame: write its view.html`);
      if (!listFiles(dir).some((f) => /^src\/.*\.tsx?$/.test(f))) return { ok: false, problems: [...problems, "src/: no TypeScript yet"], pkg: read.pkg, types: "skipped" };
      const w = workCopy(dir, mods, read.pkg);
      try {
        const r = await execArgv([node, tsc, "-p", path.join(w.pkg, "tsconfig.json"), "--pretty", "false"], { cwd: w.pkg, sandbox: o.sandbox, deny: o.deny, signal: o.signal, writable: [w.dir], net: [], timeoutMs: TOOLCHAIN_TIMEOUT_MS, maxBytes: 256 * 1024, env });
        if (r.code !== 0) {
          const lines = tidy(r.stdout + r.stderr, w.pkg)
            .split("\n")
            .filter((l) => /error TS\d+/.test(l) || (l.startsWith("  ") && l.trim()));
          problems.push(...(lines.length ? lines.slice(0, 40) : [`TypeScript didn't run: ${tidy(r.stderr || r.stdout, w.pkg).trim().slice(0, 600) || `exit ${r.code}`}`]));
        }
      } finally {
        w.done();
      }
      return { ok: !problems.length, problems, pkg: read.pkg, types: "checked" };
    },

    async test(dir, o) {
      if (!listFiles(dir).some((f) => /^src\/.*\.test\.tsx?$/.test(f))) return { ok: false, passed: 0, failed: [], problems: ["no tests: write src/<widget>.test.tsx with @cmd/widget-api/testing"] };
      const w = workCopy(dir, mods);
      try {
        const { r, json } = await vitestRun(w, "src/**/*.test.{ts,tsx}", o);
        if (!json) return { ok: false, passed: 0, failed: [], problems: [`the tests didn't run: ${tidy(r.stderr || r.stdout, w.pkg).trim().slice(-1500) || `exit ${r.code}`}`] };
        const failed: TestResult["failed"] = [];
        const problems: string[] = [];
        for (const f of json.testResults ?? []) {
          for (const a of f.assertionResults ?? []) if (a.status === "failed") failed.push({ name: a.fullName, message: tidy((a.failureMessages ?? []).join("\n"), w.pkg).split("\n").slice(0, 12).join("\n") });
          // A file that fails to load (a syntax error, a bad import) has no assertions, only a message.
          if (!f.assertionResults?.length && f.message) problems.push(`${tidy(f.name, w.pkg)}: ${tidy(f.message, w.pkg).split("\n").slice(0, 8).join("\n")}`);
        }
        const passed = json.numPassedTests ?? 0;
        if (!passed && !failed.length && !problems.length) problems.push("no test ran");
        return { ok: !failed.length && !problems.length && passed > 0, passed, failed, problems };
      } finally {
        w.done();
      }
    },

    async trees(dir, o) {
      const read = readPackage(dir, { cmdVersion: o.cmdVersion ?? null });
      if (!read.ok) return { ok: false, variants: [], problems: read.errors };
      if (read.pkg.widgets.every((x) => x.surface === "frame")) return { ok: true, variants: [], problems: [], skipped: "it draws in a frame (view.html), which the previewer doesn't draw" };
      const w = workCopy(dir, mods, read.pkg);
      try {
        fs.mkdirSync(path.join(w.pkg, "__cmd__"));
        fs.writeFileSync(path.join(w.pkg, "__cmd__", "trees.test.tsx"), TREES_HARNESS);
        const out = path.join(w.dir, "trees.json");
        const { r, json } = await vitestRun(w, "__cmd__/trees.test.tsx", o, { CMD_TREES_OUT: out });
        let variants: TreeVariant[] = [];
        try {
          variants = JSON.parse(fs.readFileSync(out, "utf8"));
        } catch {
          const why = json?.testResults?.flatMap((f) => [f.message ?? "", ...(f.assertionResults ?? []).flatMap((a) => a.failureMessages ?? [])]).filter(Boolean).join("\n") || r.stderr || r.stdout;
          return { ok: false, variants: [], problems: [`it couldn't be rendered: ${tidy(why, w.pkg).trim().split("\n").slice(0, 10).join("\n") || `exit ${r.code}`}`] };
        }
        for (const v of variants) v.errors = v.errors.map((e) => tidy(e, w.pkg));
        const problems = variants.flatMap((v) => v.errors.map((e) => `${v.name}: ${e}`));
        return { ok: !problems.length, variants, problems };
      } finally {
        w.done();
      }
    },
  };
}

const SKIPPED = "this cmd has no TypeScript and Vitest to run it with (a checkout's pnpm install has)";

/** What a cmd without the toolchain does: package.json through readPackage, and says the types, tests and trees were skipped. */
export function packageJsonToolchain(): Toolchain {
  return {
    name: "package.json only",
    async check(dir, o) {
      const read = readPackage(dir, { cmdVersion: o.cmdVersion ?? null });
      return read.ok ? { ok: true, problems: [], pkg: read.pkg, types: "skipped" } : { ok: false, problems: read.errors, pkg: null, types: "skipped" };
    },
    test: async () => ({ ok: true, passed: 0, failed: [], problems: [], skipped: SKIPPED }),
    trees: async () => ({ ok: true, variants: [], problems: [], skipped: SKIPPED }),
  };
}

/** The checkout's toolchain, else package.json only. */
export const defaultToolchain = (): Toolchain => checkoutToolchain() ?? packageJsonToolchain();
