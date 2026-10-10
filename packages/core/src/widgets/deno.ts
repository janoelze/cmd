// Deno for widgets (docs/14-magic-v2.md): find or install it, type-check a
// widget (data.ts and view.ts against data.ts's schema), and run its data.ts
// through widget-runtime/runner.ts. Permissions come from manifest.json and
// become Deno flags; the whole process also runs under cmd's sandbox-exec
// profile (no writes, no private paths), so even `--allow-run=git` can't
// change anything. cmd's own copy is one pinned Deno release, checked against
// its SHA-256 and code signature before it runs (bumping it: DENO_VERSION).

import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { credentialsForPrograms, expandPath, redact } from "../magic/policy.ts";
import { magicDenyPaths } from "../paths-deny.ts";
import { execArgv, type SandboxMode } from "../magic/sandbox.ts";
import { logger } from "@cmd/protocol/node";
import type { MagicNotify, MagicStatus } from "@cmd/protocol";
import type { WidgetManifest } from "./manifest.ts";

const log = logger("deno");

export const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../widget-runtime");

// ── finding Deno ─────────────────────────────────────────

const CANDIDATES = ["/opt/homebrew/bin/deno", "/usr/local/bin/deno", path.join(os.homedir(), ".deno/bin/deno")];

/** cmd's own copy (installDeno) lives here. */
export function bundledDeno(stateDir: string): string {
  return path.join(stateDir, "runtime", "deno", "deno");
}

/** The Deno to use: the setting, cmd's own copy, PATH, the usual install places; null when there is none. */
export function findDeno(o: { setting?: string; stateDir?: string } = {}): string | null {
  const ok = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (o.setting?.trim()) return ok(expandPath(o.setting.trim())) ? expandPath(o.setting.trim()) : null;
  if (o.stateDir && ok(bundledDeno(o.stateDir))) return bundledDeno(o.stateDir);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) if (dir && ok(path.join(dir, "deno"))) return path.join(dir, "deno");
  return CANDIDATES.find(ok) ?? null;
}

// ── installing cmd's own copy ────────────────────────────

/**
 * The Deno release cmd installs, and the SHA-256 of each Mac asset
 * (deno-<arch>-apple-darwin.zip, as GitHub's release lists it). Bumping it is a
 * reviewed change: new hashes from the release's .sha256sum files, then the
 * widget tests (CI installs this same version through installDeno).
 */
export const DENO_VERSION = "2.9.7";
export const DENO_SHA256: Readonly<Record<"aarch64" | "x86_64", string>> = {
  aarch64: "5cd46d6268f6f78f5d88bdc7159d20bd44cdaa4b3303474839f87ec6fe7ae25c",
  x86_64: "95daaff11c116a52ad54785e7914c8e9c9cdcaba793c5ed929c74ca2d8e6259a",
};

export interface InstallDenoOptions {
  fetchImpl?: typeof fetch;
  /** Tests: the hash to expect instead of DENO_SHA256's. */
  sha256?: string;
}

/**
 * Download the pinned Deno into cmd's state folder (macOS). The zip's hash is
 * checked before anything is written, the binary's signature before it is put
 * in place; either failing leaves the runtime folder as it was. Returns its path.
 */
export async function installDeno(stateDir: string, o: InstallDenoOptions = {}): Promise<string> {
  if (process.platform !== "darwin") throw new Error("Installing Deno is only automatic on macOS; install it from deno.com.");
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const url = `https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-${arch}-apple-darwin.zip`;
  log.info(`downloading Deno ${DENO_VERSION}`, { url });
  const res = await (o.fetchImpl ?? fetch)(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Couldn't download Deno: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const want = o.sha256 ?? DENO_SHA256[arch];
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== want) {
    log.error(`Deno download doesn't match its pinned hash`, { url, want, got, bytes: bytes.length });
    throw new Error(`The Deno download doesn't match Deno ${DENO_VERSION}, so it wasn't installed.`);
  }
  const target = path.dirname(bundledDeno(stateDir));
  const runtime = path.dirname(target);
  fs.mkdirSync(runtime, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(runtime, ".deno-"));
  try {
    const zip = path.join(tmp, "deno.zip");
    fs.writeFileSync(zip, bytes);
    execFileSync("/usr/bin/ditto", ["-x", "-k", zip, tmp]);
    fs.rmSync(zip, { force: true });
    const bin = path.join(tmp, "deno");
    const sig = spawnSync("/usr/bin/codesign", ["-v", bin], { encoding: "utf8", timeout: 30_000 });
    if (sig.status !== 0) {
      log.error(`Deno's code signature doesn't verify`, { url, status: sig.status, stderr: sig.stderr?.trim() });
      throw new Error(`Deno ${DENO_VERSION}'s signature doesn't verify, so it wasn't installed.`);
    }
    fs.chmodSync(bin, 0o755);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  log.info(`installed Deno ${DENO_VERSION}`, { path: bundledDeno(stateDir) });
  return bundledDeno(stateDir);
}

export function denoVersion(deno: string): string | null {
  const r = spawnSync(deno, ["--version"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? (r.stdout.split("\n")[0] ?? null) : null;
}

// ── a widget folder's deno.json ──────────────────────────

/** Written into every widget folder: `cmd` resolves to the runtime, view.ts sees the frame's `cmd` type. */
export function writeDenoConfig(dir: string): string {
  const file = path.join(dir, "deno.json");
  const config = {
    imports: { cmd: path.join(RUNTIME_DIR, "cmd.ts") },
    compilerOptions: { strict: true, lib: ["deno.ns", "dom", "dom.iterable", "esnext"], types: [path.join(RUNTIME_DIR, "view.d.ts")] },
    lock: false,
  };
  const text = JSON.stringify(config, null, 2) + "\n";
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) fs.writeFileSync(file, text);
  return file;
}

export interface DenoEnv {
  deno: string;
  /** Deno's cache (compiled TypeScript); writable inside the sandbox. */
  denoDir: string;
  sandbox: SandboxMode;
}

/** What a sandboxed Deno may write besides its temp dir: its cache. */
function denoExecOptions(env: DenoEnv) {
  fs.mkdirSync(env.denoDir, { recursive: true });
  return { sandbox: env.sandbox, deny: magicDenyPaths(), writable: [env.denoDir], env: { DENO_DIR: env.denoDir, NO_COLOR: "1", DENO_NO_UPDATE_CHECK: "1" } };
}

// ── type-checking ────────────────────────────────────────

export interface CheckResult {
  ok: boolean;
  /** Compiler errors, with paths relative to the widget folder. */
  errors: string[];
}

/** deno check on data.ts and view.ts (whichever exist). */
export async function checkTypes(dir: string, env: DenoEnv): Promise<CheckResult> {
  const files = ["data.ts", "view.ts"].filter((f) => fs.existsSync(path.join(dir, f)));
  if (!files.length) return { ok: true, errors: [] };
  const config = writeDenoConfig(dir);
  const r = await execArgv([env.deno, "check", "--quiet", "--no-remote", "--no-npm", "--config", config, ...files], { ...denoExecOptions(env), cwd: dir, timeoutMs: 60_000 });
  if (r.code === 0) return { ok: true, errors: [] };
  if (r.code === null && !r.timedOut) return { ok: false, errors: [r.stderr || "deno didn't run"] };
  const text = (r.stderr + "\n" + r.stdout).replaceAll(`file://${dir}/`, "").replaceAll(`${dir}/`, "");
  const errors = text
    .split(/\n(?=TS\d+ |error: )/)
    .map((e) => e.trim())
    .filter((e) => e && !/^Check /.test(e) && !/^error: Type checking failed/.test(e))
    .slice(0, 20);
  return { ok: false, errors: errors.length ? errors : [text.trim().slice(0, 2000) || `deno check exited ${r.code}`] };
}

// ── running data.ts ──────────────────────────────────────

export interface DataResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** Schema problems: the data came back but has the wrong shape. */
  issues?: { path: string; message: string }[];
  /** Seconds the server asked to wait (rate limits). */
  retryAfter?: number;
  status?: number;
  /** A permission was missing (net host, program, env var): manifest.json needs it. */
  permission?: boolean;
  stack?: string;
  /** What the run reported besides the data (status(), notify() in data.ts). */
  statusLine?: MagicStatus | null;
  notify?: MagicNotify[];
  /** The data function's console output and Deno's own messages. */
  stderr: string;
  ms: number;
}

export interface RunDataOptions extends DenoEnv {
  /** Where run() starts by default (the window's workspace). */
  cwd: string;
  /** The core's widgets socket and this run's token, for `events()` in data.ts (docs/28 §4). */
  socket?: { path: string; token: string } | null;
  config: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const MARK = "\u0000cmd-result ";

export function denoRunArgs(dir: string, m: WidgetManifest, env: DenoEnv, socket?: string | null): string[] {
  const p = m.permissions;
  const home = os.homedir();
  const read = [dir, RUNTIME_DIR, ...p.read.map((r) => path.resolve(expandPath(r, home))), ...(socket ? [socket] : [])];
  const args = [env.deno, "run", "--quiet", "--no-prompt", "--no-remote", "--no-npm", "--config", path.join(dir, "deno.json"), `--allow-read=${read.join(",")}`];
  // The widgets socket: Deno asks net permission for a Unix socket ("unix:<path>"), older ones read and write on its path.
  if (socket) args.push(`--allow-write=${socket}`);
  const net = [...p.net, ...(socket ? [`unix:${socket}`] : [])];
  if (net.includes("*")) args.push("--allow-net");
  else if (net.length) args.push(`--allow-net=${net.join(",")}`);
  if (p.run.length) args.push(`--allow-run=${p.run.join(",")}`);
  args.push(`--allow-env=${["CMD_WIDGET_CWD", "CMD_WIDGET_HOME", ...(socket ? ["CMD_SOCKET", "CMD_WIDGET_TOKEN"] : []), ...p.env].join(",")}`);
  args.push(path.join(RUNTIME_DIR, "runner.ts"), dir);
  return args;
}

/** Run data.ts once: its data validated against its schema, or what went wrong. */
export async function runData(dir: string, m: WidgetManifest, o: RunDataOptions): Promise<DataResult> {
  if (!fs.existsSync(path.join(dir, "data.ts"))) return { ok: false, error: "this widget has no data.ts", stderr: "", ms: 0 };
  writeDenoConfig(dir);
  const base = denoExecOptions(o);
  const keep = credentialsForPrograms(m.permissions.run);
  const r = await execArgv(denoRunArgs(dir, m, o, o.socket?.path), {
    ...base,
    writable: [...base.writable, ...(o.socket ? [o.socket.path] : [])],
    env: { ...base.env, CMD_WIDGET_CWD: o.cwd, CMD_WIDGET_HOME: os.homedir(), ...(o.socket ? { CMD_SOCKET: o.socket.path, CMD_WIDGET_TOKEN: o.socket.token } : {}) },
    cwd: o.cwd,
    stdin: JSON.stringify(o.config),
    timeoutMs: o.timeoutMs ?? 20_000,
    maxBytes: 4 * 1024 * 1024,
    signal: o.signal,
    credentials: { env: [...keep.env, ...m.permissions.env], paths: keep.paths, keychain: keep.keychain },
  });
  const stderr = r.stderr.trim().slice(0, 4000);
  if (r.timedOut) return { ok: false, error: `data.ts didn't finish within ${Math.round((o.timeoutMs ?? 20_000) / 1000)} s`, stderr, ms: r.ms };
  const line = r.stdout.split("\n").find((l) => l.startsWith(MARK));
  if (!line) {
    const why = r.code === null ? r.stderr || "deno didn't run" : r.truncated ? "data.ts returned more than 4 MB" : `data.ts exited ${r.code} without a result`;
    return { ok: false, error: why.trim().slice(0, 1000), stderr, ms: r.ms };
  }
  try {
    const res = JSON.parse(line.slice(MARK.length)) as Omit<DataResult, "stderr">;
    return { ...res, stderr, ms: res.ms ?? r.ms };
  } catch {
    return { ok: false, error: "data.ts's result couldn't be read", stderr, ms: r.ms };
  }
}

/** A run's error for people and the model, without secrets. */
export function describeDataError(r: DataResult, secrets: string[] = []): string {
  let s = r.error ?? "failed";
  if (r.permission) s += " (add what it needs to manifest.json's permissions)";
  if (r.retryAfter) s += ` (the server asks to wait ${r.retryAfter} s)`;
  for (const v of secrets) if (v.length >= 4) s = s.replaceAll(v, "[secret]");
  return redact(s);
}
