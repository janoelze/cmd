// The versions of a package made with Magic (docs/56, "Magic on V3"): each build (and each
// Restore) keeps a copy of the package's own files with what was asked and a screenshot, in
// the instance's $CMD_HOME/widget-packages/<name>/revisions/NNNN/, never in the package. The
// numbered folders of cmd:2 widgets, for packages; git-backed versions are phase 2b's call.

import fs from "node:fs";
import path from "node:path";
import { widgetPackageData } from "@cmd/protocol/node";
import { listFiles } from "./files.ts";

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

  /** Every version (the package was deleted). */
  clear(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
