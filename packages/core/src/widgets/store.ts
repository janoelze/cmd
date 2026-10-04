// Widget folders (docs/14-magic-v2.md): $CMD_HOME/widgets/<id>/ holds
// manifest.json, data.ts, view.html, view.ts, fixtures/ and revisions/. The
// working files are the current state; every build (and every hand edit cmd
// notices) is kept as a revision: a copy of the files with what was asked, so
// any version can be looked at and brought back. A widget has an id of its
// own and outlives the windows that show it (docs/16-widgets.md): widget.json
// keeps what the library lists.

import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { parseManifest, type WidgetManifest } from "./manifest.ts";

/** Files a widget consists of (and that the agent may write). */
export const WIDGET_FILES = ["manifest.json", "data.ts", "view.html", "view.ts", "README.md", "static.json"] as const;
const FIXTURE = /^fixtures\/[\w.-]+\.json$/;
const MAX_FILE = 256 * 1024;

export function isWidgetFile(rel: string): boolean {
  return (WIDGET_FILES as readonly string[]).includes(rel) || FIXTURE.test(rel);
}

export interface RevisionMeta {
  n: number;
  at: number;
  /** What was asked ("a weather widget", "make the numbers bigger"), or how it changed ("Edited by hand"). */
  prompt: string;
  /** All checks passed when it was made. */
  ok: boolean;
  /** Problems left, if any. */
  problems?: string[];
  model?: string;
  /** Has a screenshot (revisions/<n>/shot.png). */
  shot?: boolean;
}

/**
 * What the library knows about a widget (widget.json, beside its files; not a
 * widget file, so agents can't write it). Windows show a widget; this outlives them.
 */
export interface WidgetInfo {
  title: string;
  /** The person named it (widget.rename): changes keep the name instead of taking the manifest's title. */
  named?: boolean;
  /** The first request, then each change. */
  history: string[];
  /** The agent's closing words for the last build. */
  summary?: string;
  createdAt: number;
  /** When a window last showed it (opened, closed, built). */
  usedAt: number;
}

export interface Composed {
  ok: boolean;
  manifest?: WidgetManifest;
  /** The frame's body: view.html, then view.ts as a script. */
  html: string;
  errors: string[];
}

export class WidgetStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  dir(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`bad widget id: ${id}`);
    return path.join(this.root, id);
  }

  exists(id: string): boolean {
    return fs.existsSync(path.join(this.dir(id), "manifest.json"));
  }

  ensure(id: string): string {
    const d = this.dir(id);
    fs.mkdirSync(path.join(d, "fixtures"), { recursive: true });
    return d;
  }

  #path(id: string, rel: string): string {
    // Absolute paths inside the folder (agents write them) are fine too.
    const dir = this.dir(id);
    const inside = path.isAbsolute(rel) && (rel === dir || rel.startsWith(dir + path.sep)) ? path.relative(dir, rel) : rel;
    const clean = path.posix.normalize(inside.replace(/^\.?\//, ""));
    if (!isWidgetFile(clean)) throw new Error(`${rel}: a widget has only ${WIDGET_FILES.join(", ")} and fixtures/<name>.json`);
    return path.join(this.dir(id), clean);
  }

  read(id: string, rel: string): string | null {
    try {
      return fs.readFileSync(this.#path(id, rel), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  write(id: string, rel: string, content: string): void {
    if (Buffer.byteLength(content) > MAX_FILE) throw new Error(`${rel} is larger than ${MAX_FILE / 1024} KB`);
    const p = this.#path(id, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }

  remove(id: string, rel: string): void {
    fs.rmSync(this.#path(id, rel), { force: true });
  }

  /** The widget's files (relative paths), sorted. */
  files(id: string): string[] {
    const d = this.dir(id);
    const out = WIDGET_FILES.filter((f) => fs.existsSync(path.join(d, f))) as string[];
    try {
      for (const f of fs.readdirSync(path.join(d, "fixtures"))) if (FIXTURE.test(`fixtures/${f}`)) out.push(`fixtures/${f}`);
    } catch {}
    return out.sort();
  }

  /** All files' contents, for snapshots and the agent's context. */
  snapshotFiles(id: string): Record<string, string> {
    return Object.fromEntries(this.files(id).map((f) => [f, this.read(id, f) ?? ""]));
  }

  manifest(id: string): ReturnType<typeof parseManifest> {
    const text = this.read(id, "manifest.json");
    if (text === null) return { ok: false, errors: ["manifest.json is missing"] };
    try {
      return parseManifest(JSON.parse(text));
    } catch (e) {
      return { ok: false, errors: [`manifest.json isn't valid JSON: ${(e as Error).message}`] };
    }
  }

  fixtures(id: string): { name: string; data: unknown }[] {
    return this.files(id)
      .filter((f) => f.startsWith("fixtures/"))
      .flatMap((f) => {
        try {
          return [{ name: path.basename(f, ".json"), data: JSON.parse(this.read(id, f) ?? "null") as unknown }];
        } catch {
          return [];
        }
      });
  }

  /** Static data (static.json), for widgets whose data never changes (pasted JSON). */
  staticData(id: string): unknown {
    const t = this.read(id, "static.json");
    if (t === null) return undefined;
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  }

  /** The frame's body from the working files: view.html, then view.ts with its types stripped. */
  compose(id: string): Composed {
    const m = this.manifest(id);
    const errors = m.ok ? [] : [...m.errors];
    const html = this.read(id, "view.html") ?? "";
    const ts = this.read(id, "view.ts");
    let js = "";
    if (ts?.trim()) {
      const r = viewScript(ts);
      if (typeof r === "string") js = r;
      else errors.push(...r.errors);
    }
    if (m.ok && m.manifest.kind === "widget" && !html.trim() && !js.trim()) errors.push("the widget has no view: write view.html (and view.ts)");
    const body = js ? `${html}\n<script>\n${js.replace(/<\/script/gi, "<\\/script")}\n</script>` : html;
    return { ok: !errors.length, manifest: m.ok ? m.manifest : undefined, html: body, errors };
  }

  // ── revisions ──────────────────────────────────────────

  #revDir(id: string, n?: number): string {
    const base = path.join(this.dir(id), "revisions");
    return n === undefined ? base : path.join(base, String(n).padStart(4, "0"));
  }

  revisions(id: string): RevisionMeta[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.#revDir(id));
    } catch {
      return [];
    }
    return names
      .filter((n) => /^\d{4,}$/.test(n))
      .flatMap((n) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(this.#revDir(id), n, "meta.json"), "utf8")) as RevisionMeta];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.n - b.n);
  }

  latest(id: string): RevisionMeta | null {
    return this.revisions(id).at(-1) ?? null;
  }

  /** Keep the working files as a new revision. */
  snapshot(id: string, meta: Omit<RevisionMeta, "n" | "at" | "shot">, shot?: Buffer): RevisionMeta {
    const n = (this.latest(id)?.n ?? 0) + 1;
    const d = this.#revDir(id, n);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, text] of Object.entries(this.snapshotFiles(id))) {
      fs.mkdirSync(path.dirname(path.join(d, "files", f)), { recursive: true });
      fs.writeFileSync(path.join(d, "files", f), text);
    }
    if (shot) fs.writeFileSync(path.join(d, "shot.png"), shot);
    const full: RevisionMeta = { ...meta, n, at: Date.now(), ...(shot ? { shot: true } : {}) };
    fs.writeFileSync(path.join(d, "meta.json"), JSON.stringify(full, null, 2) + "\n");
    return full;
  }

  /** A revision's files. */
  revisionFiles(id: string, n: number): Record<string, string> {
    const base = path.join(this.#revDir(id, n), "files");
    const out: Record<string, string> = {};
    const walk = (rel: string) => {
      for (const e of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r);
        else if (isWidgetFile(r)) out[r] = fs.readFileSync(path.join(base, r), "utf8");
      }
    };
    if (!fs.existsSync(base)) throw new Error(`no revision ${n}`);
    walk("");
    return out;
  }

  shotPath(id: string, n: number): string {
    return path.join(this.#revDir(id, n), "shot.png");
  }

  /** Make the working files those of revision n (files it didn't have are removed). */
  checkout(id: string, n: number): void {
    const files = this.revisionFiles(id, n);
    for (const f of this.files(id)) if (!(f in files)) this.remove(id, f);
    for (const [f, text] of Object.entries(files)) this.write(id, f, text);
  }

  /** Do the working files differ from the latest revision? */
  changedSinceLatest(id: string): boolean {
    const last = this.latest(id);
    if (!last) return this.files(id).length > 0;
    const now = this.snapshotFiles(id);
    const then = this.revisionFiles(id, last.n);
    const keys = new Set([...Object.keys(now), ...Object.keys(then)]);
    for (const k of keys) if (now[k] !== then[k]) return true;
    return false;
  }

  delete(id: string): void {
    fs.rmSync(this.dir(id), { recursive: true, force: true });
  }

  // ── the library ────────────────────────────────────────

  /** Widgets that were built at least once (have a revision), by id. */
  ids(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.root);
    } catch {
      return [];
    }
    return names.filter((n) => /^[\w-]+$/.test(n) && n !== "closed" && !!this.latest(n));
  }

  /** widget.json; folders from before it are described from their revisions and manifest. */
  info(id: string): WidgetInfo | null {
    const revs = this.revisions(id);
    if (!revs.length) return null;
    let saved: Partial<WidgetInfo> = {};
    try {
      saved = JSON.parse(fs.readFileSync(path.join(this.dir(id), "widget.json"), "utf8")) as Partial<WidgetInfo>;
    } catch {}
    const m = this.manifest(id);
    return {
      title: saved.title || (m.ok ? m.manifest.title : "") || "Widget",
      ...(saved.named ? { named: true } : {}),
      history: saved.history?.length ? saved.history : [revs[0]!.prompt],
      summary: saved.summary,
      createdAt: saved.createdAt ?? revs[0]!.at,
      usedAt: saved.usedAt ?? revs.at(-1)!.at,
    };
  }

  setInfo(id: string, patch: Partial<WidgetInfo>): void {
    const now = Date.now();
    const prev = this.info(id) ?? { title: "Widget", history: [], createdAt: now, usedAt: now };
    fs.mkdirSync(this.dir(id), { recursive: true });
    fs.writeFileSync(path.join(this.dir(id), "widget.json"), JSON.stringify({ ...prev, ...patch }, null, 2) + "\n");
  }
}

/**
 * view.ts → the frame's script. Only types may be imported (the Data type from
 * data.ts); they are erased, the rest runs as is in the frame.
 */
export function viewScript(ts: string): string | { errors: string[] } {
  let js: string;
  try {
    js = stripTypeScriptTypes(ts, { mode: "strip" });
  } catch (e) {
    return { errors: [`view.ts: ${(e as Error).message.split("\n")[0]}`] };
  }
  const bad = js.split("\n").find((l) => /^\s*(import|export)\b/.test(l) && !/^\s*export\s*\{\s*\}\s*;?\s*$/.test(l));
  if (bad) return { errors: [`view.ts may only import types (import type { Data } from "./data.ts"); it runs in the frame as a plain script: ${bad.trim().slice(0, 100)}`] };
  return js.replace(/^\s*export\s*\{\s*\}\s*;?\s*$/gm, "");
}
