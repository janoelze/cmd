// The `cmd` module a widget's data.ts imports (docs/14-magic-v2.md). Runs in
// Deno, inside the widget's permissions (manifest.json) and cmd's sandbox. It
// has no dependencies, so a widget works offline and starts in milliseconds.
//
//   import { s, run, fetchJson, type Infer } from "cmd";
//   export const schema = s.object({ temp: s.number(), city: s.string() });
//   export type Data = Infer<typeof schema>;
//   export default async function data(config: { city: string }): Promise<Data> { … }
//
// cmd validates what data() returns against `schema` on every refresh: the view
// only ever gets data of that shape, and a change on the other end shows up as
// a clear error instead of a broken view. Besides the data, a run can report a
// status line (status()) and notifications (notify()), which cmd shows even
// while the window is out of sight.

// ── schema ───────────────────────────────────────────────

export interface Issue {
  path: string;
  message: string;
}

export abstract class Schema<T> {
  declare readonly _type: T;
  /** Check a value; issues are collected with their path (`files[2].path`). */
  abstract check(v: unknown, path: string, issues: Issue[]): void;
  /** A short description of the shape, for error messages and the agent. */
  abstract describe(): string;

  parse(v: unknown): T {
    const issues = this.issues(v);
    if (issues.length) throw new SchemaError(issues);
    return v as T;
  }

  issues(v: unknown): Issue[] {
    const issues: Issue[] = [];
    this.check(v, "", issues);
    return issues;
  }

  optional(): Schema<T | undefined> {
    return new Optional(this);
  }
  nullable(): Schema<T | null> {
    return new Nullable(this);
  }
}

export class SchemaError extends Error {
  constructor(readonly issues: Issue[]) {
    super(`data doesn't match the schema: ${issues.slice(0, 5).map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ")}${issues.length > 5 ? ` (and ${issues.length - 5} more)` : ""}`);
  }
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const at = (path: string, key: string | number) => (typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key);

class Prim<T> extends Schema<T> {
  constructor(readonly name: "string" | "number" | "boolean") {
    super();
  }
  check(v: unknown, path: string, issues: Issue[]) {
    if (typeof v !== this.name || (this.name === "number" && !Number.isFinite(v))) issues.push({ path, message: `expected ${this.name}, got ${kind(v)}${typeof v === "number" ? ` ${v}` : ""}` });
  }
  describe() {
    return this.name;
  }
}

class Literal<T extends string | number | boolean> extends Schema<T> {
  constructor(readonly values: readonly T[]) {
    super();
  }
  check(v: unknown, path: string, issues: Issue[]) {
    if (!this.values.includes(v as T)) issues.push({ path, message: `expected ${this.describe()}, got ${JSON.stringify(v)?.slice(0, 40)}` });
  }
  describe() {
    return this.values.map((x) => JSON.stringify(x)).join(" | ");
  }
}

class Arr<T> extends Schema<T[]> {
  constructor(readonly item: Schema<T>) {
    super();
  }
  check(v: unknown, path: string, issues: Issue[]) {
    if (!Array.isArray(v)) return void issues.push({ path, message: `expected array, got ${kind(v)}` });
    for (let i = 0; i < v.length && issues.length < 50; i++) this.item.check(v[i], at(path, i), issues);
  }
  describe() {
    return `${this.item.describe()}[]`;
  }
}

type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends Infer<S[K]> ? K : never }[keyof S];
type ObjOf<S extends Shape> = { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> };
type Flat<T> = { [K in keyof T]: T[K] } & {};

class Obj<S extends Shape> extends Schema<Flat<ObjOf<S>>> {
  constructor(readonly shape: S) {
    super();
  }
  check(v: unknown, path: string, issues: Issue[]) {
    if (kind(v) !== "object") return void issues.push({ path, message: `expected object, got ${kind(v)}` });
    const o = v as Record<string, unknown>;
    for (const [k, s] of Object.entries(this.shape)) s.check(o[k], at(path, k), issues);
  }
  describe() {
    return `{ ${Object.entries(this.shape).map(([k, s]) => `${k}${s instanceof Optional ? "?" : ""}: ${s.describe()}`).join(", ")} }`;
  }
}

class Rec<T> extends Schema<Record<string, T>> {
  constructor(readonly value: Schema<T>) {
    super();
  }
  check(v: unknown, path: string, issues: Issue[]) {
    if (kind(v) !== "object") return void issues.push({ path, message: `expected object, got ${kind(v)}` });
    for (const [k, x] of Object.entries(v as object)) this.value.check(x, at(path, k), issues);
  }
  describe() {
    return `Record<string, ${this.value.describe()}>`;
  }
}

class Union<T> extends Schema<T> {
  constructor(readonly options: Schema<unknown>[]) {
    super();
  }
  check(v: unknown, path: string, issues: Issue[]) {
    if (this.options.some((o) => o.issues(v).length === 0)) return;
    issues.push({ path, message: `expected ${this.describe()}, got ${kind(v)}` });
  }
  describe() {
    return this.options.map((o) => o.describe()).join(" | ");
  }
}

class Optional<T> extends Schema<T | undefined> {
  constructor(readonly inner: Schema<T>) {
    super();
  }
  check(v: unknown, path: string, issues: Issue[]) {
    if (v !== undefined) this.inner.check(v, path, issues);
  }
  describe() {
    return this.inner.describe();
  }
}

class Nullable<T> extends Schema<T | null> {
  constructor(readonly inner: Schema<T>) {
    super();
  }
  check(v: unknown, path: string, issues: Issue[]) {
    if (v !== null) this.inner.check(v, path, issues);
  }
  describe() {
    return `${this.inner.describe()} | null`;
  }
}

class Any<T> extends Schema<T> {
  check() {}
  describe() {
    return "unknown";
  }
}

/** Schema builders: s.object({ … }), s.array(s.string()), s.enum(["up", "down"]), … */
export const s = {
  string: () => new Prim<string>("string"),
  number: () => new Prim<number>("number"),
  boolean: () => new Prim<boolean>("boolean"),
  literal: <T extends string | number | boolean>(v: T) => new Literal<T>([v]),
  enum: <const T extends readonly (string | number)[]>(values: T) => new Literal<T[number]>(values),
  array: <T>(item: Schema<T>) => new Arr<T>(item),
  object: <S extends Shape>(shape: S) => new Obj<S>(shape),
  record: <T>(value: Schema<T>) => new Rec<T>(value),
  union: <O extends Schema<unknown>[]>(...options: O) => new Union<Infer<O[number]>>(options),
  /** Anything (avoid: the view then gets no guarantees). */
  unknown: () => new Any<unknown>(),
};

// ── paths ────────────────────────────────────────────────

/** The person's home folder. */
export function home(): string {
  return Deno.env.get("CMD_WIDGET_HOME") ?? "/";
}

/** "~/src/x" → "/Users/you/src/x" (other paths unchanged). */
export function expandHome(p: string): string {
  return p === "~" ? home() : p.startsWith("~/") ? home() + p.slice(1) : p;
}

// ── running programs ─────────────────────────────────────

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  cwd?: string;
  /** Don't throw on a non-zero exit (some tools exit 1 for "nothing found"). */
  allowFail?: boolean;
  /** Text fed to stdin. */
  stdin?: string;
}

/**
 * Run a program with arguments (no shell: no quoting, no pipes; do the
 * processing in TypeScript). The program must be listed in manifest.json's
 * permissions.run. `cwd` may start with ~. Throws with its stderr when it
 * exits non-zero.
 */
export async function run(program: string, args: string[] = [], o: RunOptions = {}): Promise<RunResult> {
  const cmd = new Deno.Command(program, { args, cwd: expandHome(o.cwd ?? Deno.env.get("CMD_WIDGET_CWD") ?? home()), stdin: o.stdin === undefined ? "null" : "piped", stdout: "piped", stderr: "piped" });
  let out: Deno.CommandOutput;
  try {
    if (o.stdin === undefined) out = await cmd.output();
    else {
      const child = cmd.spawn();
      const w = child.stdin.getWriter();
      await w.write(new TextEncoder().encode(o.stdin));
      await w.close();
      out = await child.output();
    }
  } catch (e) {
    // Say which program, and that it's missing rather than failing.
    if (e instanceof Deno.errors.NotFound) throw new NotInstalledError(program);
    throw e;
  }
  const r = { stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr), code: out.code };
  if (r.code !== 0 && !o.allowFail) throw new Error(`${program} ${args.join(" ")} exited ${r.code}: ${r.stderr.trim().slice(0, 400) || r.stdout.trim().slice(0, 200) || "(no output)"}`);
  return r;
}

/** run() of a program that isn't installed (not found on PATH). */
export class NotInstalledError extends Error {
  constructor(readonly program: string) {
    super(`${program} isn't installed (not found on PATH)`);
  }
}

/** run() and parse stdout as JSON. */
export async function runJson<T = unknown>(program: string, args: string[] = [], o: RunOptions = {}): Promise<T> {
  const r = await run(program, args, o);
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`${program} ${args.join(" ")} didn't print JSON: ${r.stdout.slice(0, 200)}`);
  }
}

// ── fetching ─────────────────────────────────────────────

/** An HTTP error; `retryAfter` (seconds) comes from the server (Retry-After, rate-limit headers). */
export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, readonly body: string, readonly retryAfter?: number) {
    super(`HTTP ${status}${status === 403 || status === 429 ? " (rate limited?)" : ""} from ${new URL(url).host}: ${body.replace(/\s+/g, " ").slice(0, 200)}`);
  }
}

function retryAfterOf(h: Headers): number | undefined {
  const ra = h.get("retry-after");
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n)) return n;
    const t = Date.parse(ra);
    if (!isNaN(t)) return Math.max(0, Math.round((t - Date.now()) / 1000));
  }
  const reset = h.get("x-ratelimit-reset");
  if (h.get("x-ratelimit-remaining") === "0" && reset) return Math.max(0, Number(reset) - Math.floor(Date.now() / 1000));
  return undefined;
}

/** fetch() that throws HttpError on a non-2xx answer, with a 10 s timeout. */
export async function get(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { "user-agent": "cmd-widget/2", ...(init.headers as Record<string, string> | undefined) }, signal: init.signal ?? AbortSignal.timeout(10_000) });
  if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ""), retryAfterOf(res.headers));
  return res;
}

export async function fetchJson<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await get(url, { ...init, headers: { accept: "application/json", ...(init.headers as Record<string, string> | undefined) } });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${new URL(url).host} didn't answer with JSON: ${text.slice(0, 200)}`);
  }
}

export async function fetchText(url: string, init: RequestInit = {}): Promise<string> {
  return (await get(url, init)).text();
}

// ── small parsers ────────────────────────────────────────

/**
 * Minimal XML (RSS, Atom, plist-ish) → elements: enough to read feeds without a
 * DOM. Returns every element named `tag` with its children's text by name.
 */
export function xmlItems(xml: string, tag: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, "g");
  for (const m of xml.match(re) ?? []) {
    const item: Record<string, string> = {};
    for (const c of m.matchAll(/<([\w:-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
      if (c[1] === tag || c[1]! in item) continue;
      item[c[1]!] = decode(c[2]!.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1").trim());
    }
    for (const c of m.matchAll(/<([\w:-]+)\s([^>]*?)\/>/g)) if (!(c[1]! in item)) item[c[1]!] = /href="([^"]*)"/.exec(c[2]!)?.[1] ?? "";
    out.push(item);
  }
  return out;
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** Split text output into rows of whitespace-separated columns (ps, df, netstat). */
export function columns(text: string, o: { skip?: number; max?: number } = {}): string[][] {
  return text
    .split("\n")
    .slice(o.skip ?? 0)
    .filter((l) => l.trim())
    .map((l) => {
      const parts = l.trim().split(/\s+/);
      return o.max && parts.length > o.max ? [...parts.slice(0, o.max - 1), parts.slice(o.max - 1).join(" ")] : parts;
    });
}

// ── status and notifications ─────────────────────────────

export type Tone = "good" | "warn" | "bad" | "dim";

export interface Status {
  /** A few words: "2 failing", "Connected · utun4", "3 changed". */
  text: string;
  /** The window's light: good (green), warn (amber), bad (red), dim (off). */
  tone?: Tone;
}

export interface Notification {
  /**
   * What this is about, stable while it lasts ("ci-failed-1234", "vpn-down").
   * cmd notifies when a key appears that the previous run didn't report, so
   * report it on every run while it holds: once, not on every refresh.
   */
  key: string;
  title?: string;
  body: string;
  /** Needs the person (plays the sound, may bounce the Dock); default true. */
  urgent?: boolean;
}

const signals: { status: Status | null; notify: Notification[] } = { status: null, notify: [] };

/** The window's status line this run (title bar, sidebar): a light and a few words. */
export function status(s: Status): void {
  signals.status = { text: String(s.text).slice(0, 80), ...(s.tone ? { tone: s.tone } : {}) };
}

/** A notification, shown once per key while it lasts (see Notification.key). */
export function notify(n: Notification): void {
  if (signals.notify.length >= 5 || signals.notify.some((x) => x.key === n.key)) return;
  signals.notify.push({ key: String(n.key).slice(0, 200), body: String(n.body ?? "").slice(0, 300), ...(n.title ? { title: String(n.title).slice(0, 120) } : {}), ...(n.urgent === false ? { urgent: false } : {}) });
}

/** For the runner: what this run reported. */
export function takeSignals(): { status: Status | null; notify: Notification[] } {
  return { status: signals.status, notify: [...signals.notify] };
}
