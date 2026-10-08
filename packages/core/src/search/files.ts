// Live search in the files of a folder (docs/33, phase 4): the names and the
// lines that contain what was typed, read from disk each time, so nothing is
// stale. ripgrep does the work (it respects .gitignore and skips binaries): the
// one cmd ships (@vscode/ripgrep), else one on PATH; without either, in a git
// repository, `git ls-files` and `git grep`.
// Each search is bounded in hits and time; secrets (.env, keys) and the folders
// in data.exclude are never searched.

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { FileHit } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { checkoutOf, worktreesOf } from "../checkout.ts";

const log = logger("files");

/** Never searched, by name: secrets and the like. */
const SECRET_GLOBS = [".env", ".env.*", "*.pem", "*.key", "*.p12", "id_rsa*", "id_ed25519*", ".netrc", ".npmrc", "*.keychain*"];
/** File lists are read again after this long. */
const NAMES_MAX_AGE_MS = 15_000;
/** At most this many names are kept per folder. */
const NAMES_LIMIT = 200_000;

export interface FileSearchOptions {
  /** Folders never searched (data.exclude). */
  excluded: () => string[];
  /** The `rg` to use; by default the bundled one, else PATH's (the login shell's, see loginpath.ts). */
  rg?: string | null;
}

interface Tool {
  kind: "rg" | "git";
  bin: string;
}

/** Wraps each case-insensitive occurrence of `q` in \x01…\x02 (what the palette highlights). */
export function markMatches(text: string, q: string): string {
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let out = "";
  let at = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, at)) {
    out += text.slice(at, i) + "\x01" + text.slice(i, i + q.length) + "\x02";
    at = i + q.length;
  }
  return out + text.slice(at);
}

/** How well a relative path matches every word: the file's name counts most, then a shorter path. 0: not every word. */
export function nameScore(rel: string, words: string[]): number {
  const p = rel.toLowerCase();
  const base = path.basename(p);
  let s = 0;
  for (const w of words) {
    if (base.includes(w)) s += base.startsWith(w) ? 30 : 20;
    else if (p.includes(w)) s += 5;
    else return 0;
  }
  return s - rel.split("/").length - rel.length / 100;
}

/** Runs a command and hands each output line to `onLine`, which returns false to stop; ends after `timeoutMs` anyway. */
function lines(bin: string, args: string[], cwd: string, timeoutMs: number, onLine: (line: string) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let rest = "";
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      p.kill();
      resolve();
    };
    const timer = setTimeout(end, timeoutMs);
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (chunk: string) => {
      const parts = (rest + chunk).split("\n");
      rest = parts.pop()!;
      for (const l of parts) if (!done && !onLine(l)) return end();
    });
    p.on("close", () => {
      if (rest && !done) onLine(rest);
      end();
    });
    p.on("error", end);
  });
}

export class FileSearch {
  #o: FileSearchOptions;
  #tool: Tool | null | undefined;
  #names = new Map<string, { at: number; files: Promise<string[]> }>();

  constructor(o: FileSearchOptions) {
    this.#o = o;
  }

  /** ripgrep on PATH, else git; null if neither (then only… nothing: say so in the UI). */
  #which(): Tool | null {
    if (this.#tool !== undefined) return this.#tool;
    const find = (name: string) => {
      for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        const f = path.join(dir, name);
        try {
          fs.accessSync(f, fs.constants.X_OK);
          return f;
        } catch {}
      }
      return null;
    };
    const rg = this.#o.rg ?? bundledRg() ?? find("rg");
    const git = find("git");
    this.#tool = rg ? { kind: "rg", bin: rg } : git ? { kind: "git", bin: git } : null;
    if (!rg) log.info(git ? "no ripgrep: file search uses git in repositories" : "no ripgrep or git: no file search");
    return this.#tool;
  }

  #excluded(root: string): { skip: boolean; globs: string[] } {
    // Worktrees inside the folder (`.claude/worktrees/x`) are other checkouts of the same files: searched in their own Space (docs/35).
    const c = checkoutOf(root);
    const globs: string[] = c ? worktreesOf(c.common).filter((t) => t.startsWith(root + path.sep)).map((t) => t.slice(root.length + 1)) : [];
    for (const f of this.#o.excluded()) {
      if (root === f || root.startsWith(f + path.sep)) return { skip: true, globs };
      if (f.startsWith(root + path.sep)) globs.push(f.slice(root.length + 1));
    }
    return { skip: false, globs };
  }

  /** The folder's files, relative, as the tool lists them (ignored files left out); cached briefly. */
  #files(root: string, tool: Tool, globs: string[]): Promise<string[]> {
    const c = this.#names.get(root);
    if (c && Date.now() - c.at < NAMES_MAX_AGE_MS) return c.files;
    const files = (async () => {
      const out: string[] = [];
      const args =
        tool.kind === "rg"
          ? ["--files", ...[...SECRET_GLOBS, ...globs].flatMap((g) => ["-g", `!${g}`])]
          : ["ls-files", "--cached", "--others", "--exclude-standard"];
      await lines(tool.bin, args, root, 3000, (l) => (l && out.push(l), out.length < NAMES_LIMIT));
      return tool.kind === "rg" ? out : out.filter((f) => !isSecret(f) && !globs.some((g) => f === g || f.startsWith(g + "/")));
    })();
    this.#names.set(root, { at: Date.now(), files });
    return files;
  }

  /**
   * Files under `root` whose path has every word of `text`, then lines that
   * contain `text` (as typed, case-insensitive unless it has capitals). Names first.
   * `part`: only the names (quick: a cached list) or only the lines, so a caller
   * can show the names while the lines are still being read.
   */
  async search(root: string, text: string, o: { limit?: number; perFile?: number; timeoutMs?: number; part?: "names" | "lines" } = {}): Promise<FileHit[]> {
    const q = text.trim();
    const tool = this.#which();
    if (!q || !tool || !fs.existsSync(root)) return [];
    const ex = this.#excluded(root);
    if (ex.skip) return [];
    const limit = o.limit ?? 30;
    const perFile = o.perFile ?? 3;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);

    const names = o.part === "lines" ? Promise.resolve([]) : this.#files(root, tool, ex.globs).then((files) =>
      files
        .map((rel) => ({ rel, s: nameScore(rel, words) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 8)
        .map(({ rel }): FileHit => ({ path: path.join(root, rel), root, line: null, column: null, text: null })),
    );

    const contents: FileHit[] = [];
    const counts = new Map<string, number>();
    const smart = q !== q.toLowerCase();
    const args =
      tool.kind === "rg"
        ? ["--no-heading", "--line-number", "--column", "--color", "never", "--fixed-strings", smart ? "--case-sensitive" : "--ignore-case", "--max-count", String(perFile), "--max-columns", "300", "--max-filesize", "2M", ...[...SECRET_GLOBS, ...ex.globs].flatMap((g) => ["-g", `!${g}`]), "--", q, "."]
        : ["grep", "--untracked", "-n", "--column", "-I", "-F", ...(smart ? [] : ["-i"]), "--max-count", String(perFile), "-e", q];
    const grep = o.part === "names" ? Promise.resolve() : lines(tool.bin, args, root, o.timeoutMs ?? 1500, (l) => {
      const m = /^(.+?):(\d+):(\d+):(.*)$/.exec(l);
      if (!m) return true;
      const rel = m[1]!.replace(/^\.\//, "");
      if (tool.kind === "git" && (isSecret(rel) || ex.globs.some((g) => rel.startsWith(g + "/")))) return true;
      const n = (counts.get(rel) ?? 0) + 1;
      if (n > perFile) return true;
      counts.set(rel, n);
      const line = m[4]!.trim().slice(0, 240);
      contents.push({ path: path.join(root, rel), root, line: Number(m[2]), column: Number(m[3]), text: smart ? markCase(line, q) : markMatches(line, q) });
      return contents.length < limit;
    });

    const [byName] = await Promise.all([names, grep]);
    // Where it's defined first (what you're usually after), then nearer files (fewer
    // folders deep), then by path; a file's lines stay in order.
    const depth = (p: string) => p.split("/").length;
    const defines = (h: FileHit) => (h.text && definesIt(h.text.replace(/[\x01\x02]/g, ""), q) ? 0 : 1);
    contents.sort((a, b) => defines(a) - defines(b) || depth(a.path) - depth(b.path) || a.path.localeCompare(b.path) || a.line! - b.line!);
    return [...byName, ...contents];
  }
}

/** The line defines what was typed, from its start: `export function useFind`, `class SearchView`, `const SEARCH =`, `def search`, `## Search`. */
export function definesIt(line: string, q: string): boolean {
  const name = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lead = "(export\\s+(default\\s+)?)?(async\\s+)?(pub(\\(\\w+\\))?\\s+)?";
  const kinds = "function\\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|impl|module";
  return new RegExp(`^(${lead}(${kinds})\\s+${name}\\b|#+\\s+${name})`, "i").test(line.trim());
}

const isSecret = (rel: string) => {
  const base = path.basename(rel);
  return SECRET_GLOBS.some((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(base));
};

/** The ripgrep that ships with cmd: @vscode/ripgrep's binary for this platform (staged next to the core when packaged). */
function bundledRg(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkg = `@vscode/ripgrep-${process.platform}-${process.arch}`;
    const file = req.resolve(`${pkg}/bin/${process.platform === "win32" ? "rg.exe" : "rg"}`, { paths: [path.dirname(req.resolve("@vscode/ripgrep"))] });
    fs.accessSync(file, fs.constants.X_OK);
    return file;
  } catch {
    return null;
  }
}

/** markMatches, case-sensitive (a query with capitals). */
function markCase(text: string, q: string): string {
  return text.split(q).join(`\x01${q}\x02`);
}
