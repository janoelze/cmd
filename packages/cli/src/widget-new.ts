// `cmd widget new|test` (docs/56, "Developer ergonomics"): a widget package from the template
// (packages/cli/templates/widget: a widget with a list and a toolbar, its test, its story,
// README, LICENSE, CLAUDE.md and AGENTS.md), and its tests. Both prepare the folder the way
// an install would: node_modules links to this cmd's @cmd/widget-api, React, Vitest and
// TypeScript (toolchain.ts's linkDevModules) and cmd-env.d.ts from package.json, so
// `npm test`, `tsc` and an editor work in it. `test` runs the package's own `test` script
// (vitest run) with those on the PATH: the same thing `npm test` does, not a runner of its own.
// What every `cmd widget` command does first lives here too: read the package (loadPackage), and
// the sandbox the toolchain runs in (toolSandbox: the core's rule).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { linkDevModules, sandboxAvailable, sandboxMode, withoutMarkers, writeEnvTypes, type SandboxMode } from "@cmd/core/magic";
import { cmdVersion, PACKAGE_NAME, readPackage, type WidgetPackage } from "@cmd/core/widgets/package";
import { dim, green, red } from "./magic.ts";
import { tilde } from "./tilde.ts";

export const TEMPLATE = path.resolve(import.meta.dirname, "../templates/widget");

/** Why `check` and `preview` don't run TypeScript and Vitest here, and how to opt out. */
export const NO_SANDBOX = "cmd can't sandbox TypeScript and Vitest here (inside another sandbox?), so it won't run them; CMD_MAGIC_UNSANDBOXED=1 runs them without one";

/** The sandbox `check` and `preview` run TypeScript and Vitest in: the core's own rule (sandboxMode); null where it can't and wasn't told to go on without (NO_SANDBOX). */
export function toolSandbox(): SandboxMode | null {
  const mode = sandboxMode();
  return mode === "off" || sandboxAvailable() ? mode : null;
}

/**
 * The package in `dir`, as every `cmd widget` command reads it first; null after printing what's
 * wrong with its package.json (the caller exits 2). `what`: what it can't be, "can't be linked".
 */
export function loadPackage(dir: string, o: { cmdVersion?: string | null; what?: string } = {}): WidgetPackage | null {
  const r = readPackage(dir, { cmdVersion: o.cmdVersion ?? null });
  if (r.ok) return r.pkg;
  const n = r.errors.length;
  console.error(`${red("✗")} ${path.basename(dir)} ${dim(`· ${o.what ? `${o.what}: ` : ""}${n} ${n === 1 ? "problem" : "problems"} in package.json`)}`);
  for (const e of r.errors) console.error(red(`  ${e}`));
  return null;
}

/** "my-widget" → "My Widget". */
export const titleOf = (name: string) =>
  name
    .split(/[-._]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");

/** A widget id from a package name: lower case letters, digits and dashes. */
export const idOf = (name: string) => name.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "widget";

/**
 * Links what the package's tests and types need and writes cmd-env.d.ts. Returns null when the
 * package.json isn't one cmd can read (its problems are the caller's to say), else what it did.
 */
export function prepare(dir: string): { linked: string[] | null; env: boolean } | null {
  const r = readPackage(dir);
  if (!r.ok) return null;
  return { linked: linkDevModules(dir), env: writeEnvTypes(dir, r.pkg) };
}

/** The template's files, named and filled in for `name`. */
export function templateFiles(name: string, year = new Date().getFullYear(), version = cmdVersion() ?? "0.30.0"): Record<string, string> {
  const id = idOf(name);
  // CLAUDE.md's generated lists keep their text, not the markers `pnpm widget-api:docs` fills them by.
  const fill = (s: string) =>
    withoutMarkers(s)
      .replaceAll("__NAME__", name)
      .replaceAll("__TITLE__", titleOf(name))
      .replaceAll("__ID__", id)
      .replaceAll("__YEAR__", String(year))
      .replaceAll("__CMD__", version.split(".").slice(0, 2).join("."))
      .replaceAll("./widget.tsx", `./${id}.tsx`);
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(TEMPLATE, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else {
        // Named for the package (src/widget.tsx → src/<id>.tsx); `gitignore` is .gitignore (npm would drop a dot-file from a package).
        const to = r === "gitignore" ? ".gitignore" : r.replace(/^src\/widget\./, `src/${id}.`);
        out[to] = fill(fs.readFileSync(path.join(TEMPLATE, r), "utf8"));
      }
    }
  };
  walk("");
  out["AGENTS.md"] = out["CLAUDE.md"]!;
  return out;
}

/** `cmd widget new <name>`: the package in ./<name> (or `parent`/<name>). */
export function newPackage(name: string | undefined, parent: string): number {
  if (!name) {
    console.error(red("usage: cmd widget new <name>   (lower case: my-widget)"));
    return 1;
  }
  if (!PACKAGE_NAME.test(name)) {
    console.error(red(`${name} can't be a package's name: use lower case letters, digits and dashes (my-widget)`));
    return 1;
  }
  const dir = path.resolve(parent, name);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    console.error(red(`${tilde(dir)} isn't empty. Pick another name, or remove it first.`));
    return 1;
  }
  for (const [rel, text] of Object.entries(templateFiles(name))) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const ready = prepare(dir);
  const id = idOf(name);
  console.log(`${green("✓")} ${name} ${dim(`· ${tilde(dir)}`)}`);
  console.log(dim(`  src/${id}.tsx is the widget, src/${id}.test.tsx its tests, src/${id}.story.tsx its states`));
  if (!ready?.linked) process.stderr.write(dim("  this cmd has no TypeScript and Vitest to lend it: run npm install there for its tests\n"));
  console.log(`\n  cd ${path.relative(process.cwd(), dir) || "."}\n  cmd widget dev      ${dim("put it on the board; saves reload it")}\n  npm test            ${dim("or cmd widget test")}`);
  return 0;
}

/** `cmd widget test [dir]`: the package's `test` script (vitest run), with this cmd's tools linked; its exit code. */
export async function testPackage(dir: string, extra: string[] = []): Promise<number> {
  if (!loadPackage(dir)) return 2;
  prepare(dir);
  const bin = path.join(dir, "node_modules/.bin");
  if (!fs.existsSync(path.join(bin, "vitest"))) {
    console.error(red("no Vitest here: this cmd has none to lend, so run npm install in the package first"));
    return 2;
  }
  let script = "vitest run";
  try {
    script = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).scripts?.test ?? script;
  } catch {}
  const command = [script, ...extra.map((a) => `'${a.replace(/'/g, `'\\''`)}'`)].join(" ");
  return new Promise<number>((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd: dir, stdio: "inherit", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on("error", (e) => {
      console.error(red(`the tests didn't start: ${e.message}`));
      resolve(2);
    });
  });
}
