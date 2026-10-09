// Where Workspace Actions come from (docs/39): one parser per kind of file that
// names ways to run a project (package.json scripts, Makefile targets, justfile
// recipes…). Each reads files and never runs the project's tools: `make -qp`,
// `nx show` and the like evaluate project code, and the folder may be one just
// cloned. A source that throws keeps its last good actions (service.ts).

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parse as parseToml } from "smol-toml";

/** An action as a source finds it, before rules and the model (classify.ts) fill in the rest. */
export interface Found {
  name: string;
  command: string;
  /** Absolute. */
  cwd: string;
  /** Relative to the root. */
  file: string;
  line?: number;
  description?: string;
  /** "cmd": made up by the source (cargo build, docker compose up), not written in the file. */
  describedBy?: "author" | "cmd";
  package?: string;
  hidden?: boolean;
  /** Needs arguments: typed into the terminal, not run. */
  args?: boolean;
  long?: boolean;
  risky?: boolean;
  kind?: string;
  url?: string;
  /** The coding agent an agent skill is for ("claude", "codex"…). */
  agent?: string;
  /** What it runs when that isn't `command` (a package.json script's text), for the rules. */
  script?: string;
}

/** A folder being read: the root, or a workspace package in it. */
export interface Dir {
  /** The catalog's root (absolute). */
  root: string;
  /** This folder (absolute). */
  path: string;
  /** Workspace package name, when this is one. */
  package?: string;
  /** A file's text, or null if it isn't there. */
  read(rel: string): string | null;
  exists(rel: string): boolean;
  /** A folder's entries, [] if none. */
  list(rel: string): fs.Dirent[];
  /** `rel` relative to the root, for ids and display. */
  file(rel: string): string;
}

export interface ActionSource {
  id: string;
  /** Only in the root (most), or in every workspace package too. */
  packages?: boolean;
  /** Folders under the root whose entries it reads (watched besides the root and the packages). */
  folders?: string[];
  find(dir: Dir): Found[];
}

export function makeDir(root: string, dirPath: string, pkg?: string): Dir {
  const abs = (rel: string) => path.join(dirPath, rel);
  // Names as they are on disk: macOS finds "makefile" when the file is "Makefile".
  const listings = new Map<string, Set<string>>();
  const names = (dir: string) => {
    let l = listings.get(dir);
    if (!l) {
      try {
        l = new Set(fs.readdirSync(dir));
      } catch {
        l = new Set();
      }
      listings.set(dir, l);
    }
    return l;
  };
  return {
    root,
    path: dirPath,
    package: pkg,
    read(rel) {
      try {
        return fs.readFileSync(abs(rel), "utf8");
      } catch {
        return null;
      }
    },
    exists: (rel) => names(path.dirname(abs(rel))).has(path.basename(rel)),
    list(rel) {
      try {
        return fs.readdirSync(abs(rel), { withFileTypes: true });
      } catch {
        return [];
      }
    },
    file: (rel) => path.relative(root, abs(rel)) || rel,
  };
}

/** 1-based line of the first `needle` at or after `from`; undefined if absent. */
export function lineOf(text: string, needle: string | RegExp, from = 0): number | undefined {
  let i: number;
  if (typeof needle === "string") i = text.indexOf(needle, from);
  else {
    const re = new RegExp(needle.source, needle.flags.includes("g") ? needle.flags : needle.flags + "g");
    re.lastIndex = from;
    i = re.exec(text)?.index ?? -1;
  }
  if (i < 0) return undefined;
  let n = 1;
  for (let k = 0; k < i; k++) if (text.charCodeAt(k) === 10) n++;
  return n;
}

/** JSON with comments and trailing commas (tsconfig, .vscode, deno.jsonc). */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      out += text.slice(i, end < 0 ? text.length : end + 2).replace(/[^\n]/g, " ");
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** A shell word, quoted if it needs to be. */
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** The first sentence-ish line of a description. */
const firstLine = (s: string | undefined) => s?.split("\n").map((l) => l.trim()).find(Boolean);

// ── npm, pnpm, yarn, bun ────────────────────────────────────────────────────

/** Scripts npm runs by itself around install and publish: listed under More. */
const LIFECYCLE = new Set(["preinstall", "install", "postinstall", "preuninstall", "uninstall", "postuninstall", "prepare", "prepublish", "prepublishOnly", "prepack", "postpack", "publish", "postpublish", "preversion", "version", "postversion", "dependencies"]);

const LOCKFILES: [string, string][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["pnpm-workspace.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/**
 * The package manager a folder uses, as package-manager-detector decides:
 * a lockfile here or in a folder above (up to the root and its repository),
 * else the packageManager field, else npm.
 */
export function packageManager(dir: string, root: string, field?: unknown): string {
  const stop = path.dirname(gitTop(root) ?? root);
  for (let d = dir; ; d = path.dirname(d)) {
    for (const [file, pm] of LOCKFILES) if (fs.existsSync(path.join(d, file))) return pm;
    if (d === stop || d === path.dirname(d) || !(d + path.sep).startsWith(stop + path.sep)) break;
  }
  const m = typeof field === "string" ? /^(npm|pnpm|yarn|bun)@/.exec(field) : null;
  return m ? m[1]! : "npm";
}

function gitTop(dir: string): string | null {
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) if (fs.existsSync(path.join(d, ".git"))) return d;
  return null;
}

export const runScript = (pm: string, name: string) => (pm === "yarn" ? `yarn ${name}` : `${pm} run ${name}`);

export const npmSource: ActionSource = {
  id: "npm",
  packages: true,
  find(dir) {
    const text = dir.read("package.json");
    if (text === null) return [];
    const pkg = JSON.parse(text) as Record<string, unknown>;
    if (!isObj(pkg.scripts)) return [];
    const pm = packageManager(dir.path, dir.root, pkg.packageManager);
    const info: Record<string, unknown> = isObj(pkg["scripts-info"]) ? pkg["scripts-info"] : isObj((pkg.ntl as Record<string, unknown>)?.descriptions) ? ((pkg.ntl as Record<string, unknown>).descriptions as Record<string, unknown>) : {};
    const scripts = pkg.scripts;
    const names = Object.keys(scripts).filter((n) => typeof scripts[n] === "string");
    const at = text.indexOf('"scripts"');
    return names.map((name): Found => {
      const base = /^(pre|post)(.+)$/.exec(name)?.[2];
      return {
        name,
        command: runScript(pm, name),
        cwd: dir.path,
        file: dir.file("package.json"),
        line: lineOf(text, JSON.stringify(name), Math.max(0, at)),
        description: str(info[name]),
        describedBy: str(info[name]) ? "author" : undefined,
        package: dir.package,
        hidden: LIFECYCLE.has(name) || (!!base && names.includes(base)) || undefined,
        // What the script does, for the rules (classify.ts) to read.
        script: scripts[name] as string,
      };
    });
  },
};

/** Workspace packages of a monorepo root: pnpm-workspace.yaml, else package.json `workspaces`. Folders, absolute. */
export function workspacePackages(root: string): { path: string; name: string }[] {
  const dir = makeDir(root, root);
  let globs: string[] = [];
  const pnpmWs = dir.read("pnpm-workspace.yaml");
  try {
    if (pnpmWs !== null) globs = ((YAML.parse(pnpmWs) as { packages?: unknown })?.packages as string[]) ?? [];
    else {
      const pkg = JSON.parse(dir.read("package.json") ?? "{}") as { workspaces?: unknown };
      const ws = pkg.workspaces;
      globs = Array.isArray(ws) ? ws : isObj(ws) && Array.isArray(ws.packages) ? (ws.packages as string[]) : [];
    }
  } catch {
    return [];
  }
  const out = new Map<string, string>();
  for (const g of globs) {
    if (typeof g !== "string" || g.startsWith("!")) continue;
    // "packages/*", "apps/**", "tools/cli": one level of wildcard is what monorepos use.
    const clean = g.replace(/\/\*\*?$/, "/*").replace(/^\.\//, "");
    const candidates = clean.endsWith("/*") ? dir.list(clean.slice(0, -2)).filter((e) => e.isDirectory()).map((e) => path.join(root, clean.slice(0, -2), e.name)) : [path.join(root, clean)];
    for (const p of candidates) {
      if (p === root || !fs.existsSync(path.join(p, "package.json"))) continue;
      let name = path.basename(p);
      try {
        name = str((JSON.parse(fs.readFileSync(path.join(p, "package.json"), "utf8")) as { name?: unknown }).name) ?? name;
      } catch {}
      out.set(p, name);
    }
  }
  return [...out].map(([p, name]) => ({ path: p, name })).sort((a, b) => a.path.localeCompare(b.path));
}

// ── Make ────────────────────────────────────────────────────────────────────

export const makeSource: ActionSource = {
  id: "make",
  find(dir) {
    const file = ["GNUmakefile", "makefile", "Makefile"].find((f) => dir.exists(f));
    if (!file) return [];
    const text = dir.read(file) ?? "";
    const lines = text.split("\n");
    const phony = new Set<string>();
    for (const l of lines) {
      const m = /^\.PHONY\s*:\s*(.*)$/.exec(l);
      if (m) for (const t of m[1]!.split(/\s+/)) if (t) phony.add(t);
    }
    const out: Found[] = [];
    const seen = new Set<string>();
    lines.forEach((l, i) => {
      if (/^\s/.test(l) || l.startsWith("#")) return;
      // "target other: deps ## what it does"; not "VAR := x", "VAR ::= x" or "a::b".
      const m = /^([A-Za-z0-9_][^:#=$%]*?)\s*:(?![:=])([^#]*?)(?:##\s*(.*))?$/.exec(l);
      if (!m) return;
      for (const t of m[1]!.trim().split(/\s+/)) {
        if (seen.has(t) || t.startsWith(".")) continue;
        // A file it builds (out/app.js, main.o) unless declared phony.
        if (!phony.has(t) && /[/.]/.test(t)) continue;
        seen.add(t);
        const above = i > 0 ? /^#+\s?(.*)$/.exec(lines[i - 1]!)?.[1] : undefined;
        const description = str(m[3]) ?? (above && !/^[-=#\s]*$/.test(above) ? str(above) : undefined);
        out.push({ name: t, command: t === "all" ? "make" : `make ${t}`, cwd: dir.path, file: dir.file(file), line: i + 1, description, describedBy: description ? "author" : undefined, hidden: t.startsWith("_") || undefined });
      }
    });
    return out;
  },
};

// ── just ────────────────────────────────────────────────────────────────────

export const justSource: ActionSource = {
  id: "just",
  find(dir) {
    const file = ["justfile", ".justfile", "Justfile"].find((f) => dir.exists(f));
    if (!file) return [];
    const lines = (dir.read(file) ?? "").split("\n");
    const out: Found[] = [];
    let comment: string | undefined;
    let attrs: string[] = [];
    lines.forEach((l, i) => {
      if (/^\s*$/.test(l)) return void ((comment = undefined), (attrs = []));
      if (/^\s/.test(l)) return;
      if (l.startsWith("#")) return void (comment = l.startsWith("#!") ? comment : str(l.replace(/^#+/, "")));
      if (l.startsWith("[")) return void attrs.push(l);
      const m = /^@?([A-Za-z_][\w-]*)((?:\s+[^:]*?)?)\s*:(?!=)/.exec(l);
      if (!m || /^(set|alias|export|import|mod)$/.test(m[1]!)) return void ((comment = undefined), (attrs = []));
      const name = m[1]!;
      const attrText = attrs.join(" ");
      if (!name.startsWith("_") && !/\bprivate\b/.test(attrText)) {
        // A parameter without a default ("target", "+files") needs a value.
        const params = m[2]!.trim().split(/\s+/).filter(Boolean);
        const args = params.some((p) => !p.includes("=") && !p.startsWith("*"));
        const doc = /\bdoc\(\s*(['"])(.*?)\1\s*\)/.exec(attrText)?.[2] ?? comment;
        out.push({ name, command: `just ${name}`, cwd: dir.path, file: dir.file(file), line: i + 1, description: str(doc), describedBy: str(doc) ? "author" : undefined, args: args || undefined });
      }
      comment = undefined;
      attrs = [];
    });
    return out;
  },
};

// ── Task (taskfile.dev) ─────────────────────────────────────────────────────

export const taskSource: ActionSource = {
  id: "task",
  find(dir) {
    const file = ["Taskfile.yml", "Taskfile.yaml", "taskfile.yml", "taskfile.yaml"].find((f) => dir.exists(f));
    if (!file) return [];
    const text = dir.read(file) ?? "";
    const doc = YAML.parse(text) as { tasks?: unknown };
    if (!isObj(doc?.tasks)) return [];
    const at = text.search(/^tasks\s*:/m);
    return Object.entries(doc.tasks)
      .filter(([, t]) => !(isObj(t) && t.internal === true))
      .map(([name, t]) => {
        const desc = isObj(t) ? str(t.desc) ?? firstLine(str(t.summary)) : undefined;
        return { name, command: `task ${name}`, cwd: dir.path, file: dir.file(file), line: lineOf(text, new RegExp(`^\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`, "m"), Math.max(0, at)), description: desc, describedBy: desc ? ("author" as const) : undefined };
      });
  },
};

// ── mise ────────────────────────────────────────────────────────────────────

export const miseSource: ActionSource = {
  id: "mise",
  folders: ["mise-tasks", ".mise-tasks", ".mise/tasks"],
  find(dir) {
    const out: Found[] = [];
    const file = ["mise.toml", ".mise.toml"].find((f) => dir.exists(f));
    if (file) {
      const text = dir.read(file) ?? "";
      const tasks = (parseToml(text) as { tasks?: unknown }).tasks;
      if (isObj(tasks))
        for (const [name, t] of Object.entries(tasks)) {
          if (isObj(t) && t.hide === true) continue;
          const desc = isObj(t) ? str(t.description) : undefined;
          out.push({ name, command: `mise run ${name}`, cwd: dir.path, file: dir.file(file), line: lineOf(text, `[tasks.${name}]`) ?? lineOf(text, `[tasks."${name}"]`), description: desc, describedBy: desc ? "author" : undefined });
        }
    }
    for (const folder of this.folders!)
      for (const e of dir.list(folder)) {
        if (!e.isFile()) continue;
        const text = dir.read(path.join(folder, e.name)) ?? "";
        if (/^#\s*\[?MISE\]?\s+hide\s*=\s*true/m.test(text)) continue;
        const desc = str(/^#\s*\[?MISE\]?\s+description\s*=\s*"(.*)"/m.exec(text)?.[1]);
        const name = e.name.replace(/\.[^.]+$/, "");
        out.push({ name, command: `mise run ${name}`, cwd: dir.path, file: dir.file(path.join(folder, e.name)), description: desc, describedBy: desc ? "author" : undefined });
      }
    return out;
  },
};

// ── Deno ────────────────────────────────────────────────────────────────────

export const denoSource: ActionSource = {
  id: "deno",
  packages: true,
  find(dir) {
    const file = ["deno.json", "deno.jsonc"].find((f) => dir.exists(f));
    if (!file) return [];
    const text = dir.read(file) ?? "";
    const tasks = (parseJsonc(text) as { tasks?: unknown }).tasks;
    if (!isObj(tasks)) return [];
    return Object.entries(tasks).map(([name, t]) => {
      const desc = isObj(t) ? str(t.description) : undefined;
      return { name, command: `deno task ${name}`, cwd: dir.path, file: dir.file(file), line: lineOf(text, JSON.stringify(name), Math.max(0, text.indexOf('"tasks"'))), description: desc, describedBy: desc ? ("author" as const) : undefined, package: dir.package };
    });
  },
};

// ── Composer ────────────────────────────────────────────────────────────────

export const composerSource: ActionSource = {
  id: "composer",
  find(dir) {
    const text = dir.read("composer.json");
    if (text === null) return [];
    const doc = JSON.parse(text) as { scripts?: unknown; "scripts-descriptions"?: unknown };
    if (!isObj(doc.scripts)) return [];
    const descs = isObj(doc["scripts-descriptions"]) ? doc["scripts-descriptions"] : {};
    return Object.keys(doc.scripts).map((name) => ({
      name,
      command: `composer run ${name}`,
      cwd: dir.path,
      file: dir.file("composer.json"),
      line: lineOf(text, JSON.stringify(name), Math.max(0, text.indexOf('"scripts"'))),
      description: str(descs[name]),
      describedBy: str(descs[name]) ? ("author" as const) : undefined,
      // Event hooks composer runs by itself (post-install-cmd, pre-autoload-dump).
      hidden: /^(pre|post)-/.test(name) || undefined,
    }));
  },
};

// ── Python (pyproject.toml) ─────────────────────────────────────────────────

export const pythonSource: ActionSource = {
  id: "python",
  find(dir) {
    const text = dir.read("pyproject.toml");
    if (text === null) return [];
    const doc = parseToml(text) as Record<string, any>;
    const file = dir.file("pyproject.toml");
    const uv = dir.exists("uv.lock");
    const poetry = dir.exists("poetry.lock");
    const out: Found[] = [];
    const add = (name: string, command: string, header: string, description?: string, hidden?: boolean) =>
      out.push({ name, command, cwd: dir.path, file, line: lineOf(text, header), description, describedBy: description ? "author" : undefined, hidden });
    const poe = doc.tool?.poe?.tasks;
    if (isObj(poe))
      for (const [name, t] of Object.entries(poe)) {
        if (name.startsWith("_")) continue;
        add(name, `${uv ? "uv run " : poetry ? "poetry run " : ""}poe ${name}`, "[tool.poe.tasks", isObj(t) ? str(t.help) : undefined);
      }
    const pdm = doc.tool?.pdm?.scripts;
    if (isObj(pdm))
      for (const [name, t] of Object.entries(pdm)) {
        if (name.startsWith("_")) continue;
        add(name, `pdm run ${name}`, "[tool.pdm.scripts", isObj(t) ? str(t.help) : undefined, /^(pre|post)_/.test(name) || undefined);
      }
    const envs = doc.tool?.hatch?.envs;
    if (isObj(envs))
      for (const [env, e] of Object.entries(envs)) {
        if (!isObj(e) || !isObj(e.scripts)) continue;
        for (const name of Object.keys(e.scripts)) add(env === "default" ? name : `${env}:${name}`, `hatch run ${env === "default" ? name : `${env}:${name}`}`, `[tool.hatch.envs.${env}.scripts`);
      }
    // Console entry points the project installs: run through the project's environment.
    const scripts = { ...(isObj(doc.project?.scripts) ? doc.project.scripts : {}), ...(isObj(doc.tool?.poetry?.scripts) ? doc.tool.poetry.scripts : {}) };
    for (const name of Object.keys(scripts)) add(name, `${uv ? "uv run " : poetry ? "poetry run " : ""}${name}`, doc.project?.scripts?.[name] ? "[project.scripts" : "[tool.poetry.scripts");
    return out;
  },
};

// ── Cargo ───────────────────────────────────────────────────────────────────

export const cargoSource: ActionSource = {
  id: "cargo",
  folders: [".cargo"],
  find(dir) {
    const text = dir.read("Cargo.toml");
    if (text === null) return [];
    const doc = parseToml(text) as Record<string, any>;
    const file = dir.file("Cargo.toml");
    const made = (name: string, command: string, description: string, extra: Partial<Found> = {}): Found => ({ name, command, cwd: dir.path, file, description, describedBy: "cmd", ...extra });
    const out: Found[] = [];
    const bins: string[] = Array.isArray(doc.bin) ? doc.bin.map((b: { name?: unknown }) => str(b.name)).filter((n: string | undefined): n is string => !!n) : [];
    if (bins.length > 1) for (const b of bins) out.push(made(`run ${b}`, `cargo run --bin ${b}`, `Run ${b}`));
    else if (bins.length === 1 || dir.exists("src/main.rs")) out.push(made("run", "cargo run", "Build and run"));
    out.push(made("build", "cargo build", "Compile"), made("test", "cargo test", "Run the tests"), made("clippy", "cargo clippy", "Lint with Clippy"));
    for (const f of [".cargo/config.toml", ".cargo/config"]) {
      const t = dir.read(f);
      if (t === null) continue;
      const alias = (parseToml(t) as { alias?: unknown }).alias;
      if (isObj(alias)) for (const name of Object.keys(alias)) out.push({ name, command: `cargo ${name}`, cwd: dir.path, file: dir.file(f), line: lineOf(t, new RegExp(`^${name}\\s*=`, "m")) });
      break;
    }
    return out;
  },
};

// ── Procfile ────────────────────────────────────────────────────────────────

export const procfileSource: ActionSource = {
  id: "procfile",
  find(dir) {
    const out: Found[] = [];
    for (const file of ["Procfile.dev", "Procfile"]) {
      const text = dir.read(file);
      if (text === null) continue;
      text.split("\n").forEach((l, i) => {
        const m = /^([\w-]+)\s*:\s*(.+)$/.exec(l.trim());
        if (m && !l.startsWith("#")) out.push({ name: file === "Procfile" ? m[1]! : `${m[1]} (dev)`, command: m[2]!.trim(), cwd: dir.path, file: dir.file(file), line: i + 1, long: true });
      });
    }
    return out;
  },
};

// ── Docker Compose ──────────────────────────────────────────────────────────

export const composeSource: ActionSource = {
  id: "compose",
  find(dir) {
    const file = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"].find((f) => dir.exists(f));
    if (!file) return [];
    const text = dir.read(file) ?? "";
    const doc = YAML.parse(text) as { services?: unknown };
    const services = isObj(doc?.services) ? doc.services : {};
    const made = (name: string, command: string, description: string, extra: Partial<Found> = {}): Found => ({ name, command, cwd: dir.path, file: dir.file(file), description, describedBy: "cmd", ...extra });
    const urlOf = (s: unknown) => {
      if (!isObj(s) || !Array.isArray(s.ports)) return undefined;
      for (const p of s.ports) {
        // "3000:3000", "127.0.0.1:8080:80", 5432 (container only), { published: 3000 }
        const host = isObj(p) ? p.published : typeof p === "string" && p.split(":").length > 1 ? p.split(":").at(-2) : undefined;
        if (host !== undefined && /^\d+$/.test(String(host))) return `http://localhost:${host}`;
      }
      return undefined;
    };
    const names = Object.keys(services);
    const out = [made("up", "docker compose up", names.length ? `Start ${names.length === 1 ? names[0] : `all ${names.length} services`}` : "Start the services", { long: true, kind: "dev", url: names.length === 1 ? urlOf(services[names[0]!]) : undefined }), made("down", "docker compose down", "Stop and remove the containers", { kind: "clean" })];
    if (names.length > 1 && names.length <= 8)
      for (const s of names) out.push(made(`up ${s}`, `docker compose up ${quote(s)}`, `Start ${s}`, { long: true, kind: "dev", url: urlOf(services[s]), line: lineOf(text, new RegExp(`^\\s+${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`, "m")) }));
    return out;
  },
};

// ── VS Code tasks ───────────────────────────────────────────────────────────

export const vscodeSource: ActionSource = {
  id: "vscode",
  folders: [".vscode"],
  find(dir) {
    const text = dir.read(".vscode/tasks.json");
    if (text === null) return [];
    const tasks = (parseJsonc(text) as { tasks?: unknown }).tasks;
    if (!Array.isArray(tasks)) return [];
    const out: Found[] = [];
    for (const t of tasks) {
      if (!isObj(t) || (t.type !== "shell" && t.type !== "process")) continue;
      const label = str(t.label);
      const cmd = str(t.command);
      if (!label || !cmd) continue;
      const args = Array.isArray(t.args) ? t.args.filter((a): a is string => typeof a === "string") : [];
      const command = [cmd, ...args.map(quote)].join(" ");
      // ${file}, ${input:x}: values only VS Code can fill in.
      if (command.includes("${")) continue;
      const cwd = str((t.options as Record<string, unknown> | undefined)?.cwd)?.replace("${workspaceFolder}", dir.root);
      out.push({ name: label, command, cwd: cwd && !cwd.includes("${") ? path.resolve(dir.path, cwd) : dir.path, file: dir.file(".vscode/tasks.json"), line: lineOf(text, JSON.stringify(label)), description: str(t.detail), describedBy: str(t.detail) ? "author" : undefined, long: t.isBackground === true || undefined });
    }
    return out;
  },
};

// ── scripts/ and bin/ ───────────────────────────────────────────────────────

export const scriptsSource: ActionSource = {
  id: "scripts",
  folders: ["scripts", "bin"],
  find(dir) {
    const out: Found[] = [];
    for (const folder of this.folders!)
      for (const e of dir.list(folder).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!e.isFile() || e.name.startsWith(".")) continue;
        const rel = path.join(folder, e.name);
        try {
          if (!(fs.statSync(path.join(dir.path, rel)).mode & 0o111)) continue;
        } catch {
          continue;
        }
        const head = (dir.read(rel) ?? "").slice(0, 2000);
        // A script, not a build's binary output.
        if (!head.startsWith("#!")) continue;
        const desc = scriptComment(head);
        out.push({ name: e.name.replace(/\.(sh|bash|zsh|py|rb|js|mjs|ts)$/, ""), command: `./${rel}`, cwd: dir.path, file: dir.file(rel), description: desc, describedBy: desc ? "author" : undefined });
      }
    return out;
  },
};

/** The first sentence of the comment at the top of a script, after the shebang. */
export function scriptComment(head: string): string | undefined {
  const words: string[] = [];
  for (const l of head.split("\n").slice(1, 12)) {
    const m = /^\s*(?:#|\/\/|\*|\/\*\*?)\s?(.*)$/.exec(l);
    if (!m) break;
    const t = m[1]!.replace(/\*\/\s*$/, "").trim();
    if (!t) {
      if (words.length) break;
      continue;
    }
    if (/^(-+|=+|shellcheck|eslint|@|usage:)/i.test(t)) {
      if (words.length) break;
      continue;
    }
    words.push(t);
  }
  const text = words.join(" ");
  const end = text.search(/[.!?](\s|$)/);
  const sentence = (end >= 0 ? text.slice(0, end) : text).trim();
  return sentence ? (sentence.length > 120 ? sentence.slice(0, 119).replace(/\s+\S*$/, "") + "…" : sentence) : undefined;
}

// ── GitHub Actions you can start by hand ────────────────────────────────────

export const githubSource: ActionSource = {
  id: "github",
  folders: [".github/workflows"],
  find(dir) {
    const out: Found[] = [];
    for (const e of dir.list(".github/workflows")) {
      if (!e.isFile() || !/\.ya?ml$/.test(e.name)) continue;
      const rel = path.join(".github/workflows", e.name);
      const text = dir.read(rel) ?? "";
      const doc = YAML.parse(text) as Record<string, unknown> | null;
      // `on:` parses as the key "on" (YAML 1.2), or true under YAML 1.1 rules.
      const on = doc?.on ?? doc?.true;
      const manual = on === "workflow_dispatch" || (Array.isArray(on) && on.includes("workflow_dispatch")) || (isObj(on) && "workflow_dispatch" in on);
      if (!manual) continue;
      const name = str(doc?.name) ?? e.name.replace(/\.ya?ml$/, "");
      out.push({ name, command: `gh workflow run ${e.name}`, cwd: dir.path, file: dir.file(rel), line: lineOf(text, "workflow_dispatch"), description: `Start the “${name}” workflow on GitHub`, describedBy: "cmd", risky: true });
    }
    return out;
  },
};

// ── Agent skills and commands ───────────────────────────────────────────────

/** A Markdown file's front matter (YAML, else key: value lines), {} if none. */
export function frontMatter(text: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  try {
    const v = YAML.parse(m[1]!) as unknown;
    if (isObj(v)) return v;
  } catch {}
  // Not YAML ("description: Write copy: menus, toasts…"): agents read it as one key per line, so do the same.
  const out: Record<string, unknown> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * Where coding agents keep a project's skills and commands, and how each is
 * started with one. Skills are folders with a SKILL.md (the Agent Skills format);
 * commands are files (Markdown for Claude, TOML for Gemini and Qwen, "a/b.toml"
 * is /a:b). `.agents/skills` is the shared folder Codex reads (Gemini and Copilot too).
 */
const AGENT_PLACES: { agent: string; folder: string; type: "skills" | "commands-md" | "commands-toml"; start: (name: string) => string }[] = [
  { agent: "claude", folder: ".claude/skills", type: "skills", start: (n) => `claude ${quote(`/${n}`)}` },
  { agent: "claude", folder: ".claude/commands", type: "commands-md", start: (n) => `claude ${quote(`/${n}`)}` },
  { agent: "codex", folder: ".agents/skills", type: "skills", start: (n) => `codex ${quote(`$${n}`)}` },
  { agent: "codex", folder: ".codex/skills", type: "skills", start: (n) => `codex ${quote(`$${n}`)}` },
  { agent: "gemini", folder: ".gemini/commands", type: "commands-toml", start: (n) => `gemini -i ${quote(`/${n}`)}` },
  // Gemini and Copilot pick a skill by its description; asking for it by name starts it.
  { agent: "gemini", folder: ".gemini/skills", type: "skills", start: (n) => `gemini -i ${quote(`Use the ${n} skill.`)}` },
  { agent: "qwen", folder: ".qwen/commands", type: "commands-toml", start: (n) => `qwen -i ${quote(`/${n}`)}` },
  { agent: "copilot", folder: ".github/skills", type: "skills", start: (n) => `copilot -i ${quote(`Use the ${n} skill.`)}` },
];

/** How a skill is named where its agent starts it: /triage in Claude, $triage in Codex. */
const SKILL_LABEL: Record<string, (n: string) => string> = { codex: (n) => `$${n}`, gemini: (n) => `/${n}`, qwen: (n) => `/${n}`, claude: (n) => `/${n}`, copilot: (n) => n };

/**
 * The project's agent skills and commands: each runs as a new session of its
 * agent started with it. Skills a person can't start (user-invocable: false) are left out.
 */
export const skillsSource: ActionSource = {
  id: "skills",
  folders: [...new Set(AGENT_PLACES.flatMap((p) => [p.folder]))],
  find(dir) {
    const out: Found[] = [];
    for (const place of AGENT_PLACES) {
      const add = (name: string, rel: string, description: string | undefined, hint?: string) =>
        out.push({ name: SKILL_LABEL[place.agent]!(name), command: place.start(name), cwd: dir.path, file: dir.file(rel), description, describedBy: description ? "author" : undefined, kind: "agent", long: true, risky: false, agent: place.agent, ...(hint ? { script: `${SKILL_LABEL[place.agent]!(name)} ${hint}` } : {}) });
      if (place.type === "skills") {
        for (const e of dir.list(place.folder).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!e.isDirectory() && !e.isSymbolicLink()) continue;
          const rel = path.join(place.folder, e.name, "SKILL.md");
          const text = dir.read(rel);
          if (text === null) continue;
          const fm = frontMatter(text);
          if (fm["user-invocable"] === false) continue;
          add(str(fm.name) ?? e.name, rel, firstLine(str(fm.description)), str(fm["argument-hint"]));
        }
        continue;
      }
      // Commands, one level of folders for namespaces (git/commit.toml → git:commit).
      const ext = place.type === "commands-md" ? ".md" : ".toml";
      const files = dir.list(place.folder).flatMap((e) => (e.isDirectory() ? dir.list(path.join(place.folder, e.name)).filter((f) => f.isFile()).map((f) => `${e.name}/${f.name}`) : e.isFile() ? [e.name] : []));
      for (const f of files.filter((x) => x.endsWith(ext)).sort()) {
        const rel = path.join(place.folder, f);
        const text = dir.read(rel) ?? "";
        const name = f.slice(0, -ext.length).replace("/", ":");
        let description: string | undefined;
        let hint: string | undefined;
        if (place.type === "commands-md") {
          const fm = frontMatter(text);
          description = firstLine(str(fm.description));
          hint = str(fm["argument-hint"]);
        } else {
          try {
            description = firstLine(str((parseToml(text) as { description?: unknown }).description));
          } catch {}
        }
        add(name, rel, description, hint);
      }
    }
    return out;
  },
};

/** In the order they're listed when nothing else orders them. */
export const SOURCES: ActionSource[] = [npmSource, justSource, taskSource, makeSource, miseSource, denoSource, composerSource, pythonSource, cargoSource, procfileSource, composeSource, vscodeSource, scriptsSource, githubSource, skillsSource];
