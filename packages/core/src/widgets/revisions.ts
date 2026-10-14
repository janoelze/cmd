// The versions of a package made with Magic (docs/56, "Revisions"): each build, Restore and
// hand edit keeps a copy of the package's own files with what was asked (or "Edited by hand")
// and a screenshot, numbered, in the instance's $CMD_HOME/widget-packages/<name>/revisions/NNNN/,
// never in the package. Numbered, not git (docs/56's decisions): each version already carries
// the request and the screenshot the edit view's Changes list shows. A hand edit (files changed
// outside a build: an editor, an agent in a terminal) becomes a version on the reload that
// follows it, once per burst; Restore puts a version's files back, and refuses for a linked
// package, whose folder is the person's own.

import fs from "node:fs";
import path from "node:path";
import { logger, widgetPackageData } from "@cmd/protocol/node";
import type { PackageEntry } from "./packages.ts";

const log = logger("widgets");

/** The package's own files (no node_modules, dot-files or links), relative, sorted. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk("");
  return out.sort();
}

/** The files' text, package.json without cmd's own mark (cmd.magic counts the builds; that alone is no edit). */
function contents(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of listFiles(dir)) {
    let text = fs.readFileSync(path.join(dir, f), "utf8");
    if (f === "package.json") {
      try {
        const json = JSON.parse(text) as { cmd?: Record<string, unknown> };
        if (json.cmd && typeof json.cmd === "object") delete json.cmd.magic;
        text = JSON.stringify(json);
      } catch {}
    }
    out.set(f, text);
  }
  return out;
}

export interface PackageRevision {
  n: number;
  at: number;
  /** What was asked ("the latest CI runs", "make it denser"), or "Back to version 2". */
  prompt: string;
  /** Check, test and preview passed. */
  ok: boolean;
  problems?: string[];
  model?: string;
  /** Its screenshot, if the preview made one. */
  shot?: string;
  /** Files changed outside a build ("Edited by hand"): nothing checked them. */
  hand?: boolean;
}

export class PackageRevisions {
  readonly root: string;
  constructor(stateDir: string, name: string) {
    this.root = path.join(widgetPackageData(stateDir, name), "revisions");
  }

  #dir(n: number): string {
    return path.join(this.root, String(n).padStart(4, "0"));
  }

  list(): PackageRevision[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.root).filter((d) => /^\d{4}$/.test(d)).sort();
    } catch {}
    return names.flatMap((d) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.root, d, "meta.json"), "utf8")) as PackageRevision;
        const shot = path.join(this.root, d, "shot.png");
        return [{ ...meta, ...(fs.existsSync(shot) ? { shot } : {}) }];
      } catch {
        return [];
      }
    });
  }

  latest(): PackageRevision | null {
    return this.list().at(-1) ?? null;
  }

  /** Keep the package's files as the next version. */
  snapshot(dir: string, meta: Omit<PackageRevision, "n" | "at" | "shot">, shot?: Buffer): PackageRevision {
    const n = (this.latest()?.n ?? 0) + 1;
    const at = this.#dir(n);
    for (const f of listFiles(dir)) {
      fs.mkdirSync(path.dirname(path.join(at, "files", f)), { recursive: true });
      fs.copyFileSync(path.join(dir, f), path.join(at, "files", f));
    }
    const rev: PackageRevision = { ...meta, n, at: Date.now() };
    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(path.join(at, "meta.json"), JSON.stringify(rev, null, 2) + "\n");
    if (shot) fs.writeFileSync(path.join(at, "shot.png"), shot);
    return { ...rev, ...(shot ? { shot: path.join(at, "shot.png") } : {}) };
  }

  /** Put version n's files back in the package (files it didn't have are removed; node_modules and dot-files stay). */
  checkout(dir: string, n: number): void {
    const from = path.join(this.#dir(n), "files");
    if (!fs.existsSync(from)) throw new Error(`no version ${n}`);
    const keep = new Set(listFiles(from));
    for (const f of listFiles(dir)) if (!keep.has(f)) fs.rmSync(path.join(dir, f), { force: true });
    for (const f of keep) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.copyFileSync(path.join(from, f), path.join(dir, f));
    }
  }

  /** Whether the package's files differ from version n's (by default the latest); false when there is none. */
  differs(dir: string, n?: number): boolean {
    const at = n ?? this.latest()?.n;
    if (at === undefined) return false;
    const from = path.join(this.#dir(at), "files");
    if (!fs.existsSync(from)) return false;
    const a = contents(dir);
    const b = contents(from);
    return a.size !== b.size || [...a].some(([f, t]) => b.get(f) !== t);
  }

  /** Version n's screenshot, to keep with a version that brings it back. */
  shotOf(n: number): Buffer | undefined {
    try {
      return fs.readFileSync(path.join(this.#dir(n), "shot.png"));
    } catch {
      return undefined;
    }
  }

  /** Every version (the package was deleted). */
  clear(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

/** The folder a linked package is (its link resolved), or null for a folder of its own. */
export function linkOf(dir: string): string | null {
  try {
    return fs.lstatSync(dir).isSymbolicLink() ? fs.realpathSync(dir) : null;
  } catch {
    return null;
  }
}

/**
 * A reload of a package made with Magic (it has versions): files that differ from its latest
 * version were edited by hand, and become a version named so. Not while a build writes it.
 */
export function recordHandEdit(stateDir: string, entry: PackageEntry, building: ReadonlySet<string>): PackageRevision | null {
  if (!entry.ok || entry.builtin || building.has(entry.folder)) return null;
  const revs = new PackageRevisions(stateDir, entry.pkg.name);
  const last = revs.latest();
  if (!last || !revs.differs(entry.dir)) return null;
  const rev = revs.snapshot(entry.dir, { prompt: "Edited by hand", ok: true, hand: true });
  log.info(`widget package ${entry.pkg.name} edited by hand (version ${rev.n})`);
  return rev;
}
