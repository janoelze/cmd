// A widget package's package.json (docs/56-widgets-v3.md, "A widget is a package"):
// the one manifest, read and refused here with a message naming the field, by the core
// (widgets/packages.ts) and by `cmd widget check` alike. Reading never writes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PERMISSION_KEYS, SUPPORTED_API, noPermissions, packageKind, type WidgetPermissions } from "@cmd/protocol";
import { POLICY, declarable } from "../data/policy.ts";
import { ESCAPES } from "../magic/policy.ts";
import { expandPath, magicDenyPaths, privateMatcher } from "../lib/paths-deny.ts";

export type WidgetSize = "s" | "m" | "l" | "wide";

export interface ConfigField {
  key: string;
  title: string;
  type: "string" | "number" | "boolean" | "enum";
  default?: string | number | boolean;
  options?: string[];
  /** Kept in cmd's secrets (never in the widget folder or the window state); reaches the widget's code only. */
  secret?: boolean;
  description?: string;
}

export interface PackageWidget {
  id: string;
  /** Its window kind: "pkg:<package>/<id>". */
  kind: string;
  title: string;
  /** SF Symbol name. */
  icon: string;
  description?: string;
  /** Its entry, relative to the package folder. */
  main: string;
  size: WidgetSize;
  config: ConfigField[];
  /** "tree" (drawn by the app from the kit) or "frame" (pixels in a sandboxed frame). */
  surface: "tree" | "frame";
}

export interface WidgetPackage {
  name: string;
  version: string;
  description?: string;
  /** engines.cmd as written (">=0.32"), if any. */
  engines?: string;
  /** The widget API major it is written against. */
  api: number;
  widgets: PackageWidget[];
  /** What it asks for. */
  permissions: WidgetPermissions;
  /** Experimental API it uses ("pages"). */
  experimental: string[];
  /** Its folder (a link in the packages folder stays a link here). */
  dir: string;
}

export type PackageResult = { ok: true; pkg: WidgetPackage } | { ok: false; errors: string[] };

export const DEFAULT_ICON = "puzzlepiece.extension";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,213}$/;
const WIDGET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ICON = /^[a-z0-9]+(\.[a-z0-9]+)*$/;
const ACT = ["agents", "terminals", "windows", "actions"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const q = (v: unknown) => JSON.stringify(v);

/** The cmd this is: the app's version, else the checkout's (apps/desktop/package.json); null when neither says. */
export function cmdVersion(): string | null {
  if (process.env.CMD_APP_VERSION) return process.env.CMD_APP_VERSION;
  try {
    const v = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../../../apps/desktop/package.json"), "utf8")).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Compare versions by major, minor, patch (missing parts are 0; pre-release tags ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0]!.split(".").map((x) => Number(x) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** The oldest cmd an engines.cmd range admits (">=0.32", "^0.32.1", "0.32"), or null when it isn't one of those. */
export function enginesMin(range: string): string | null {
  const m = /^\s*(?:>=|\^|~)?\s*v?(\d+(?:\.\d+){0,2})\s*$/.exec(range);
  return m ? m[1]! : null;
}

/** Config fields (a manifest's `config`, a package widget's): the fields, problems in `errors` under `at`. */
export function parseConfigFields(v: unknown, at: string, errors: string[]): ConfigField[] {
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()).slice(0, 32) : []);
  const config: ConfigField[] = [];
  for (const c of Array.isArray(v) ? v : []) {
    const f = c as Record<string, unknown>;
    if (!f || typeof f.key !== "string" || !/^[A-Za-z_][\w]*$/.test(f.key)) {
      errors.push(`${at}: each field needs a key (letters, digits, _)`);
      continue;
    }
    const type = f.type === "number" || f.type === "boolean" || f.type === "enum" ? f.type : "string";
    const field: ConfigField = { key: f.key, title: typeof f.title === "string" ? f.title : f.key, type };
    if (["string", "number", "boolean"].includes(typeof f.default)) field.default = f.default as string | number | boolean;
    if (type === "enum") field.options = strs(f.options);
    if (f.secret === true) field.secret = true;
    if (typeof f.description === "string") field.description = f.description;
    config.push(field);
  }
  return config;
}

/** Whether `p` is `dir` or inside it. */
const inside = (dir: string, p: string) => p === dir || p.startsWith(dir + path.sep);

/** A list of strings at `at`: anything else is a problem. */
function list(v: unknown, at: string, errors: string[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim())) {
    errors.push(`${at}: should be a list of names, like ["example"]`);
    return [];
  }
  return [...new Set((v as string[]).map((x) => x.trim()))];
}

function permissions(v: unknown, errors: string[], home: string): WidgetPermissions {
  const out = noPermissions();
  if (v === undefined) return out;
  if (!isObj(v)) {
    errors.push("cmd.permissions: should be an object, like { \"net\": [\"api.github.com\"] }");
    return out;
  }
  for (const k of Object.keys(v)) if (!(PERMISSION_KEYS as readonly string[]).includes(k)) errors.push(`cmd.permissions.${k}: isn't a permission (${PERMISSION_KEYS.join(", ")})${k === "env" ? "; a secret is a config field with \"secret\": true" : ""}`);
  for (const k of PERMISSION_KEYS) out[k] = list(v[k], `cmd.permissions.${k}`, errors);
  for (const h of out.net) if (!/^(\*|[a-z0-9.-]+(:\d+)?)$/i.test(h)) errors.push(`cmd.permissions.net: "${h}" isn't a host, like "api.github.com"`);
  for (const r of out.run) {
    if (ESCAPES.has(r.split("/").pop()!)) errors.push(`cmd.permissions.run: "${r}" would let the widget run anything; name the programs it needs`);
    else if (!/^[\w.-]+$/.test(r)) errors.push(`cmd.permissions.run: "${r}" isn't a program name, like "gh"`);
  }
  const priv = privateMatcher(magicDenyPaths(), home);
  for (const r of out.read) {
    const abs = path.resolve(expandPath(r, home));
    if (!r.startsWith("~") && !path.isAbsolute(r)) errors.push(`cmd.permissions.read: "${r}" should be a full path, like "~/Notes"`);
    else if (abs === path.parse(abs).root || inside(abs, home)) errors.push(`cmd.permissions.read: "${r}" is ${abs === home ? "your whole home folder" : "more than your home folder"}; name the folders it needs`);
    else if (priv(abs)) errors.push(`cmd.permissions.read: "${r}" is private (keys, credentials or cmd's own data)`);
  }
  for (const w of out.workspace) if (w !== "read" && w !== "all") errors.push(`cmd.permissions.workspace: "${w}" should be "read" (this workspace) or "all"`);
  const may = declarable("widget");
  for (const c of out.events) if (!may.includes(c as never)) errors.push(`cmd.permissions.events: "${c}" ${c in POLICY.widget ? "can't be read by widgets" : "isn't a class of events"} (${may.join(", ")})`);
  for (const a of out.act) {
    const [ns, verb, more] = a.split(".");
    if (!ACT.includes(ns!) || more !== undefined || (verb !== undefined && !/^[a-zA-Z]+$/.test(verb))) errors.push(`cmd.permissions.act: "${a}" should be one of ${ACT.join(", ")}, or a verb of one, like "actions.run"`);
  }
  return out;
}

/** A widget's `main` resolves to a file inside the package, also through links; the problem, or null. */
function mainProblem(dir: string, main: string): string | null {
  if (path.isAbsolute(main)) return `"${main}" should be a path inside the package, like "src/widget.tsx"`;
  const abs = path.resolve(dir, main);
  if (!inside(path.resolve(dir), abs)) return `"${main}" is outside the package`;
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return `"${main}" doesn't exist`;
  }
  let root: string;
  try {
    root = fs.realpathSync(dir);
  } catch {
    root = path.resolve(dir);
  }
  if (!inside(root, real)) return `"${main}" links outside the package`;
  if (!fs.statSync(real).isFile()) return `"${main}" isn't a file`;
  return null;
}

export interface ParseOptions {
  /** The running cmd's version (default: cmdVersion()); null skips the engines check. */
  cmdVersion?: string | null;
  home?: string;
}

/** Validate a package.json (as parsed) of the package in `dir`: the package, or every problem, each naming its field. */
export function parsePackage(json: unknown, dir: string, o: ParseOptions = {}): PackageResult {
  if (!isObj(json)) return { ok: false, errors: ["package.json: should be a JSON object"] };
  const errors: string[] = [];
  const home = o.home ?? os.homedir();
  const running = o.cmdVersion === undefined ? cmdVersion() : o.cmdVersion;

  const name = json.name;
  if (typeof name !== "string" || !NAME.test(name)) errors.push(name === undefined ? `name: missing; add a name like "ci-runs"` : `name: ${q(name)} isn't a package name (lowercase letters, digits, - . _)`);
  const version = json.version;
  if (typeof version !== "string" || !SEMVER.test(version)) errors.push(version === undefined ? `version: missing; add a version like "1.0.0"` : `version: ${q(version)} isn't a version like "1.0.0"`);
  const description = typeof json.description === "string" ? json.description.trim() || undefined : undefined;

  let engines: string | undefined;
  if (json.engines !== undefined) {
    const e = isObj(json.engines) ? json.engines.cmd : undefined;
    if (e !== undefined && typeof e !== "string") errors.push(`engines.cmd: should be a version range, like ">=0.32"`);
    else if (typeof e === "string") {
      engines = e;
      const min = enginesMin(e);
      if (!min) errors.push(`engines.cmd: ${q(e)} isn't a range cmd reads; write the oldest cmd it runs on, like ">=0.32"`);
      else if (running && compareVersions(min, running) > 0) errors.push(`engines.cmd: needs cmd ${min} or newer; this is ${running}`);
    }
  }

  const c = json.cmd;
  if (!isObj(c)) {
    errors.push(c === undefined ? `cmd: missing; add a "cmd" block with "api" and "widgets"` : `cmd: should be an object with "api" and "widgets"`);
    return { ok: false, errors };
  }
  const api = c.api;
  if (api === undefined) errors.push(`cmd.api: missing; add "api": ${SUPPORTED_API.max}, the widget API major it's written for`);
  else if (typeof api !== "number" || !Number.isInteger(api)) errors.push(`cmd.api: ${q(api)} should be a whole number, like ${SUPPORTED_API.max}`);
  else if (api < SUPPORTED_API.min || api > SUPPORTED_API.max) errors.push(`cmd.api: ${api} isn't a widget API this cmd runs (${SUPPORTED_API.min === SUPPORTED_API.max ? SUPPORTED_API.min : `${SUPPORTED_API.min}–${SUPPORTED_API.max}`})${api > SUPPORTED_API.max ? "; it needs a newer cmd" : ""}`);

  const perms = permissions(c.permissions, errors, home);
  const experimental = list(c.experimental, "cmd.experimental", errors);

  const widgets: PackageWidget[] = [];
  if (!Array.isArray(c.widgets) || !c.widgets.length) errors.push(`cmd.widgets: should list at least one widget, like [{ "id": "main", "title": "…", "main": "src/main.tsx" }]`);
  else {
    const seen = new Set<string>();
    c.widgets.forEach((w: unknown, i: number) => {
      const at = `cmd.widgets[${i}]`;
      if (!isObj(w)) return void errors.push(`${at}: should be an object with id, title and main`);
      const id = w.id;
      if (typeof id !== "string" || !WIDGET_ID.test(id)) return void errors.push(`${at}.id: ${id === undefined ? "missing" : `${q(id)} should be lowercase letters, digits and -`}`);
      if (seen.has(id)) errors.push(`${at}.id: "${id}" is used twice; each widget needs its own id`);
      seen.add(id);
      const title = typeof w.title === "string" ? w.title.trim().slice(0, 120) : "";
      if (!title) errors.push(`${at}.title: missing; add the name the Widget Library shows`);
      const icon = w.icon === undefined ? DEFAULT_ICON : w.icon;
      if (typeof icon !== "string" || !ICON.test(icon)) errors.push(`${at}.icon: ${q(icon)} isn't an SF Symbol name, like "checkmark.seal"`);
      const surface = w.surface === undefined ? "tree" : w.surface;
      if (surface !== "tree" && surface !== "frame") errors.push(`${at}.surface: ${q(surface)} should be "tree" or "frame"`);
      const size = w.size === undefined ? "m" : w.size;
      if (size !== "s" && size !== "m" && size !== "l" && size !== "wide") errors.push(`${at}.size: ${q(size)} should be "s", "m", "l" or "wide"`);
      const main = w.main;
      if (typeof main !== "string" || !main.trim()) errors.push(`${at}.main: missing; add the widget's entry, like "src/${id}.tsx"`);
      else {
        const p = mainProblem(dir, main);
        if (p) errors.push(`${at}.main: ${p}`);
      }
      if (w.config !== undefined && !Array.isArray(w.config)) errors.push(`${at}.config: should be a list of fields`);
      const config = parseConfigFields(w.config, `${at}.config`, errors);
      if (typeof name === "string")
        widgets.push({ id, kind: packageKind(name, id), title, icon: String(icon), ...(typeof w.description === "string" ? { description: w.description } : {}), main: String(main), size: size as WidgetSize, config, surface: surface as "tree" | "frame" });
    });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, pkg: { name: name as string, version: version as string, ...(description ? { description } : {}), ...(engines ? { engines } : {}), api: api as number, widgets, permissions: perms, experimental, dir } };
}

/** A folder holds a widget package: a package.json with a "cmd" block. */
export function isPackageDir(dir: string): boolean {
  try {
    return isObj(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).cmd);
  } catch {
    return false;
  }
}

/** Read and validate the package in `dir`. */
export function readPackage(dir: string, o: ParseOptions = {}): PackageResult {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "package.json"), "utf8");
  } catch {
    return { ok: false, errors: ["package.json: not found in this folder"] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`package.json: isn't valid JSON (${(e as Error).message})`] };
  }
  return parsePackage(json, dir, o);
}
